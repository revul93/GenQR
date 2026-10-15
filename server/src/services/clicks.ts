import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { isbot } from 'isbot';
import { open, type CountryResponse, type Reader } from 'maxmind';
import UAParser from 'ua-parser-js';
import { z } from 'zod';
import { DATA_DIR, env } from '../config.js';
import { db } from '../db/index.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Click logging for short-link redirects. Stores only what the dashboards need:
 * source, referrer host, browser/OS/device, optional country, and a keyed hash
 * standing in for the visitor (to count unique visitors). IP addresses are never stored.
 */

export const analyticsConfigSchema = z.object({
  retentionDays: z.number().int().min(0).max(3650), // 0 = keep detailed clicks forever
  geoip: z.boolean(),
});
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>;
const CONFIG_KEY = 'analytics.config';
const DEFAULT_CONFIG: AnalyticsConfig = { retentionDays: 395, geoip: true };

export const getAnalyticsConfig = () => getSetting<AnalyticsConfig>(CONFIG_KEY, DEFAULT_CONFIG);
export const saveAnalyticsConfig = (cfg: AnalyticsConfig, userId: number) => setSetting(CONFIG_KEY, cfg, { userId });

// --- GeoIP (optional) ---------------------------------------------------------------------

/** Drop MaxMind's free GeoLite2-Country.mmdb here to enable country statistics. */
export const GEOIP_FILE = path.join(DATA_DIR, 'GeoLite2-Country.mmdb');
let geoReader: Reader<CountryResponse> | null = null;
let geoLoadedMtime = 0;

async function geoLookup(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  try {
    const stat = fs.statSync(GEOIP_FILE, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!geoReader || stat.mtimeMs !== geoLoadedMtime) {
      geoReader = await open<CountryResponse>(GEOIP_FILE);
      geoLoadedMtime = stat.mtimeMs;
    }
    return geoReader.get(ip.replace(/^::ffff:/, ''))?.country?.iso_code ?? null;
  } catch {
    return null;
  }
}

export function geoipStatus(): { installed: boolean; path: string; updatedAt: number | null } {
  const stat = fs.statSync(GEOIP_FILE, { throwIfNoEntry: false });
  return { installed: !!stat, path: GEOIP_FILE, updatedAt: stat ? stat.mtimeMs : null };
}

// --- Recording ----------------------------------------------------------------------------

const visitorKey = crypto.createHash('sha256').update(`genqr-visitor:${env.encryptionKey || 'dev'}`).digest();

function visitorHash(ip: string | null, userAgent: string): string {
  return crypto.createHmac('sha256', visitorKey).update(`${ip ?? ''}|${userAgent}`).digest('hex');
}

function deviceOf(type: string | undefined): string {
  if (type === 'mobile' || type === 'wearable') return 'mobile';
  if (type === 'tablet') return 'tablet';
  if (!type) return 'desktop'; // ua-parser leaves desktop browsers untyped
  return 'other';
}

function referrerHost(req: Request): string | null {
  const ref = req.get('referer');
  if (!ref) return null;
  try {
    return new URL(ref).hostname.toLowerCase().slice(0, 255) || null;
  } catch {
    return null;
  }
}

/** Records a redirect. Never throws: analytics must not break the redirect. */
export async function recordClick(linkId: number, req: Request): Promise<void> {
  try {
    const ua = (req.get('user-agent') ?? '').slice(0, 1000);
    const parsed = new UAParser(ua).getResult();
    const cfg = await getAnalyticsConfig();
    await db()('clicks').insert({
      short_link_id: linkId,
      ts: Date.now(),
      source: req.query.s === 'qr' ? 'qr' : 'direct',
      referrer_host: referrerHost(req),
      browser: parsed.browser.name?.slice(0, 50) ?? null,
      os: parsed.os.name?.slice(0, 50) ?? null,
      device: deviceOf(parsed.device.type),
      country: cfg.geoip ? await geoLookup(req.ip ?? null) : null,
      visitor: visitorHash(req.ip ?? null, ua),
      is_bot: !ua || isbot(ua),
    });
  } catch (err) {
    console.error('Failed to record click', err);
  }
}

// --- Retention ----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Rolls detailed clicks older than the retention period into per-day totals and deletes
 * them. Daily totals keep the long-term chart; browser/OS/country breakdowns cover the
 * retention window only.
 */
export async function applyRetention(): Promise<{ archived: number }> {
  const { retentionDays } = await getAnalyticsConfig();
  if (!retentionDays) return { archived: 0 };
  // Cut at a UTC day boundary so a day is never split between raw and daily rows.
  const cutoff = Math.floor((Date.now() - retentionDays * DAY_MS) / DAY_MS) * DAY_MS;
  const rows = await db()('clicks').where('ts', '<', cutoff).select('short_link_id', 'ts', 'source', 'visitor', 'is_bot');
  if (!rows.length) return { archived: 0 };

  const buckets = new Map<string, { linkId: number; day: string; clicks: number; visitors: Set<string>; qr: number; direct: number }>();
  for (const r of rows) {
    if (r.is_bot) continue;
    const day = utcDay(Number(r.ts));
    const key = `${r.short_link_id}|${day}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { linkId: Number(r.short_link_id), day, clicks: 0, visitors: new Set(), qr: 0, direct: 0 }));
    b.clicks++;
    b.visitors.add(r.visitor);
    if (r.source === 'qr') b.qr++;
    else b.direct++;
  }

  await db().transaction(async (trx) => {
    for (const b of buckets.values()) {
      const existing = await trx('clicks_daily').where({ short_link_id: b.linkId, day: b.day }).first();
      if (existing) {
        await trx('clicks_daily')
          .where({ short_link_id: b.linkId, day: b.day })
          .update({
            clicks: Number(existing.clicks) + b.clicks,
            visitors: Number(existing.visitors) + b.visitors.size,
            qr: Number(existing.qr) + b.qr,
            direct: Number(existing.direct) + b.direct,
          });
      } else {
        await trx('clicks_daily').insert({ short_link_id: b.linkId, day: b.day, clicks: b.clicks, visitors: b.visitors.size, qr: b.qr, direct: b.direct });
      }
    }
    await trx('clicks').where('ts', '<', cutoff).delete();
  });
  return { archived: rows.length };
}

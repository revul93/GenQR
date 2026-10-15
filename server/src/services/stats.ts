import type { Knex } from 'knex';
import { db } from '../db/index.js';
import type { User } from './users.js';

/**
 * Click statistics. Aggregation runs in JavaScript over the selected rows: it keeps the SQL
 * identical on every database engine, and the volume (a few hundred clicks a day) is small.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_N = 8;

export type Scope = { kind: 'link'; linkId: number } | { kind: 'owner'; ownerId: number } | { kind: 'all' };

export function scopeFor(user: User, all: boolean): Scope {
  return all && user.role === 'admin' ? { kind: 'all' } : { kind: 'owner', ownerId: user.id };
}

export interface Range {
  from: number; // inclusive, epoch ms (start of the first local day)
  to: number; // exclusive
  tzOffsetMin: number; // Date.getTimezoneOffset() of the viewer
}

/** Last `days` calendar days in the viewer's timezone, including today. */
export function rangeFor(days: number, tzOffsetMin: number, now = Date.now()): Range {
  const shift = -tzOffsetMin * 60000;
  const startOfToday = Math.floor((now + shift) / DAY_MS) * DAY_MS - shift;
  return { from: startOfToday - (days - 1) * DAY_MS, to: startOfToday + DAY_MS, tzOffsetMin };
}

const localDay = (ts: number, tzOffsetMin: number) => new Date(ts - tzOffsetMin * 60000).toISOString().slice(0, 10);

function linkIds(scope: Scope): Knex.QueryBuilder {
  const q = db()('short_links').select('id');
  if (scope.kind === 'link') q.where({ id: scope.linkId });
  if (scope.kind === 'owner') q.where({ owner_id: scope.ownerId });
  return q;
}

export interface Breakdown {
  name: string;
  count: number;
}

export interface Stats {
  range: { from: number; to: number; days: string[] };
  totals: { clicks: number; visitors: number; qr: number; direct: number; links: number; activeLinks: number };
  series: { day: string; clicks: number; visitors: number; qr: number; direct: number }[];
  devices: Breakdown[];
  browsers: Breakdown[];
  os: Breakdown[];
  referrers: Breakdown[];
  countries: Breakdown[];
  topLinks: { id: number; code: string; title: string | null; owner: string; clicks: number; visitors: number }[];
  topCreators: { username: string; displayName: string; clicks: number; links: number }[];
  /** True when part of the range comes from archived daily totals (no breakdowns for those days). */
  includesArchived: boolean;
  bots: number;
}

function topN(counts: Map<string, number>): Breakdown[] {
  const sorted = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  if (sorted.length <= TOP_N) return sorted;
  const rest = sorted.slice(TOP_N - 1).reduce((s, b) => s + b.count, 0);
  return [...sorted.slice(0, TOP_N - 1), { name: 'Other', count: rest }];
}

const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);

export async function computeStats(scope: Scope, range: Range): Promise<Stats> {
  const [raw, daily, links] = await Promise.all([
    db()('clicks').whereIn('short_link_id', linkIds(scope)).where('ts', '>=', range.from).where('ts', '<', range.to)
      .select('short_link_id', 'ts', 'source', 'referrer_host', 'browser', 'os', 'device', 'country', 'visitor', 'is_bot'),
    db()('clicks_daily').whereIn('short_link_id', linkIds(scope))
      .where('day', '>=', localDay(range.from, range.tzOffsetMin)).where('day', '<', localDay(range.to, range.tzOffsetMin)),
    db()('short_links as l').join('users as u', 'u.id', 'l.owner_id').leftJoin('qr_codes as q', 'q.id', 'l.qr_code_id').whereIn('l.id', linkIds(scope))
      .select('l.id', 'l.code', 'l.is_active', 'l.expires_at', 'q.title', 'q.deleted_at', 'u.username', 'u.display_name'),
  ]);

  const days: string[] = [];
  for (let t = range.from; t < range.to; t += DAY_MS) days.push(localDay(t, range.tzOffsetMin));
  const series = new Map(days.map((day) => [day, { day, clicks: 0, visitors: new Set<string>(), archivedVisitors: 0, qr: 0, direct: 0 }]));

  const visitors = new Set<string>();
  const perLink = new Map<number, { clicks: number; visitors: Set<string>; archivedVisitors: number }>();
  const linkEntry = (id: number) => {
    let e = perLink.get(id);
    if (!e) perLink.set(id, (e = { clicks: 0, visitors: new Set(), archivedVisitors: 0 }));
    return e;
  };
  const devices = new Map<string, number>();
  const browsers = new Map<string, number>();
  const os = new Map<string, number>();
  const referrers = new Map<string, number>();
  const countries = new Map<string, number>();
  let qr = 0;
  let direct = 0;
  let bots = 0;
  let archivedVisitors = 0;

  for (const r of raw) {
    if (r.is_bot) {
      bots++;
      continue;
    }
    const day = series.get(localDay(Number(r.ts), range.tzOffsetMin));
    if (!day) continue;
    day.clicks++;
    day.visitors.add(r.visitor);
    visitors.add(r.visitor);
    const link = linkEntry(Number(r.short_link_id));
    link.clicks++;
    link.visitors.add(r.visitor);
    if (r.source === 'qr') {
      qr++;
      day.qr++;
    } else {
      direct++;
      day.direct++;
    }
    bump(devices, r.device);
    bump(browsers, r.browser ?? 'Unknown');
    bump(os, r.os ?? 'Unknown');
    bump(referrers, r.referrer_host ?? (r.source === 'qr' ? 'QR scan (no referrer)' : 'Typed or shared link (no referrer)'));
    if (r.country) bump(countries, r.country);
  }

  for (const d of daily) {
    const day = series.get(String(d.day));
    if (!day) continue;
    day.clicks += Number(d.clicks);
    day.archivedVisitors += Number(d.visitors);
    day.qr += Number(d.qr);
    day.direct += Number(d.direct);
    qr += Number(d.qr);
    direct += Number(d.direct);
    archivedVisitors += Number(d.visitors);
    const link = linkEntry(Number(d.short_link_id));
    link.clicks += Number(d.clicks);
    link.archivedVisitors += Number(d.visitors);
  }

  const now = Date.now();
  const linkInfo = new Map(links.map((l) => [Number(l.id), l]));
  const topLinks = [...perLink.entries()]
    .map(([id, e]) => {
      const l = linkInfo.get(id);
      return { id, code: String(l?.code ?? ''), title: (l?.title as string | null) ?? null, owner: String(l?.username ?? ''), clicks: e.clicks, visitors: e.visitors.size + e.archivedVisitors };
    })
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  const creators = new Map<string, { username: string; displayName: string; clicks: number; links: Set<number> }>();
  for (const [id, e] of perLink) {
    const l = linkInfo.get(id);
    if (!l) continue;
    const key = String(l.username);
    let c = creators.get(key);
    if (!c) creators.set(key, (c = { username: key, displayName: String(l.display_name), clicks: 0, links: new Set() }));
    c.clicks += e.clicks;
    c.links.add(id);
  }

  return {
    range: { from: range.from, to: range.to, days },
    totals: {
      clicks: qr + direct,
      visitors: visitors.size + archivedVisitors,
      qr,
      direct,
      links: links.filter((l) => l.deleted_at == null).length,
      activeLinks: links.filter((l) => l.deleted_at == null && l.is_active && (l.expires_at == null || Number(l.expires_at) > now)).length,
    },
    series: [...series.values()].map((d) => ({ day: d.day, clicks: d.clicks, visitors: d.visitors.size + d.archivedVisitors, qr: d.qr, direct: d.direct })),
    devices: topN(devices),
    browsers: topN(browsers),
    os: topN(os),
    referrers: topN(referrers),
    countries: topN(countries),
    topLinks,
    topCreators: [...creators.values()].map((c) => ({ username: c.username, displayName: c.displayName, clicks: c.clicks, links: c.links.size })).sort((a, b) => b.clicks - a.clicks).slice(0, 10),
    includesArchived: daily.length > 0,
    bots,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Quote, and neutralise leading characters spreadsheets would treat as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function clicksCsv(scope: Scope, range: Range): Promise<string> {
  const rows = await db()('clicks as c')
    .join('short_links as l', 'l.id', 'c.short_link_id')
    .leftJoin('qr_codes as q', 'q.id', 'l.qr_code_id')
    .whereIn('c.short_link_id', linkIds(scope))
    .where('c.ts', '>=', range.from)
    .where('c.ts', '<', range.to)
    .orderBy('c.ts')
    .select('c.ts', 'l.code', 'q.title', 'c.source', 'c.referrer_host', 'c.browser', 'c.os', 'c.device', 'c.country', 'c.is_bot');
  const header = ['time_utc', 'short_code', 'qr_title', 'source', 'referrer', 'browser', 'os', 'device', 'country', 'bot'];
  const lines = rows.map((r) =>
    [new Date(Number(r.ts)).toISOString(), r.code, r.title, r.source, r.referrer_host, r.browser, r.os, r.device, r.country, r.is_bot ? 'yes' : 'no'].map(csvCell).join(','),
  );
  // BOM so Excel opens UTF-8 correctly.
  return '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n';
}

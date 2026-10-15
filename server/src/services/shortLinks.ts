import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { db, insertReturningId } from '../db/index.js';
import { HttpError } from '../http.js';
import { getSetting, setSetting, SettingKeys } from './settings.js';
import type { Actor } from './audit.js';
import type { User } from './users.js';

/** Short links: /short/<code> → target URL. QR codes for URLs encode the short link, so targets stay editable. */

// No 0/O, 1/l/I: codes are read and typed by people.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 7;
export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
const RESERVED_ALIASES = new Set(['api', 'admin', 'short', 'qr', 'login', 'logout', 'setup', 'static', 'assets', 'health', 'genqr']);

/** Marks scans so analytics can tell them apart from clicks on the plain short URL. */
const QR_SOURCE_SUFFIX = '?s=qr';

export interface ShortLink {
  id: number;
  code: string;
  url: string; // public short URL
  targetUrl: string;
  ownerId: number;
  ownerUsername: string;
  qrCodeId: number | null;
  qrTitle: string | null;
  isActive: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LinkHistoryEntry {
  id: number;
  field: 'target' | 'active' | 'expires';
  oldValue: string | null;
  newValue: string | null;
  changedByName: string;
  changedAt: number;
}

// --- Settings -------------------------------------------------------------------------

export const linkPolicySchema = z.object({
  mode: z.enum(['off', 'allowlist', 'blocklist']),
  domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Use plain domain names like example.com')).max(500),
});
export type LinkPolicy = z.infer<typeof linkPolicySchema>;
const POLICY_KEY = 'links.policy';
const DEFAULT_POLICY: LinkPolicy = { mode: 'off', domains: [] };

export const getLinkPolicy = () => getSetting<LinkPolicy>(POLICY_KEY, DEFAULT_POLICY);
export const saveLinkPolicy = (policy: LinkPolicy, userId: number) => setSetting(POLICY_KEY, policy, { userId });

export async function publicBaseUrl(): Promise<string> {
  const base = await getSetting<string | null>(SettingKeys.publicBaseUrl, null);
  if (!base) throw new HttpError(500, 'The public address of GenQR is not configured.', 'NO_BASE_URL');
  return base.replace(/\/+$/, '');
}

export const shortUrlFor = (base: string, code: string) => `${base}/short/${code}`;
export const qrDataFor = (base: string, code: string) => shortUrlFor(base, code) + QR_SOURCE_SUFFIX;

/** What a not-yet-saved URL code will encode: same length as the real one, so the preview has the same density. */
export async function sampleQrData(): Promise<string> {
  return qrDataFor(await publicBaseUrl(), 'x'.repeat(CODE_LENGTH));
}

// --- Target validation ----------------------------------------------------------------

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

/** Normalises and checks a redirect target against the safety rules and the admin's domain policy. */
export async function validateTarget(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Enter a full URL, e.g. https://www.example.com/page', 'BAD_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http:// and https:// links are allowed.', 'BAD_URL');
  if (url.username || url.password) throw new HttpError(400, 'Links must not contain a username or password.', 'BAD_URL');
  const normalised = url.toString();
  if (normalised.length > 2000) throw new HttpError(400, 'The link is too long (2000 characters maximum).', 'BAD_URL');

  const host = url.hostname.toLowerCase();
  const base = new URL(await publicBaseUrl());
  if (host === base.hostname.toLowerCase() && url.pathname.startsWith('/short/')) {
    throw new HttpError(400, 'A short link cannot point to another short link.', 'LINK_LOOP');
  }

  const policy = await getLinkPolicy();
  if (policy.mode === 'allowlist' && !policy.domains.some((d) => hostMatches(host, d))) {
    throw new HttpError(400, `Links to ${host} are not allowed. Allowed domains: ${policy.domains.join(', ') || '(none)'}.`, 'DOMAIN_NOT_ALLOWED');
  }
  if (policy.mode === 'blocklist' && policy.domains.some((d) => hostMatches(host, d))) {
    throw new HttpError(400, `Links to ${host} are blocked by the administrator.`, 'DOMAIN_BLOCKED');
  }
  return normalised;
}

// --- Creation ---------------------------------------------------------------------------

function randomCode(): string {
  return Array.from(crypto.randomBytes(CODE_LENGTH), (b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function aliasTaken(trx: Knex | Knex.Transaction, code: string): Promise<boolean> {
  return !!(await trx('short_links').whereRaw('LOWER(code) = ?', [code.toLowerCase()]).first());
}

export async function createShortLink(
  trx: Knex.Transaction,
  input: { targetUrl: string; ownerId: number; qrCodeId: number | null; alias?: string | null },
): Promise<{ id: number; code: string }> {
  let code: string;
  if (input.alias) {
    if (!ALIAS_PATTERN.test(input.alias)) throw new HttpError(400, 'Custom names use 3-40 letters, digits, dashes or underscores.', 'BAD_ALIAS');
    if (RESERVED_ALIASES.has(input.alias.toLowerCase())) throw new HttpError(400, `"${input.alias}" is reserved.`, 'BAD_ALIAS');
    if (await aliasTaken(trx, input.alias)) throw new HttpError(409, `The short name "${input.alias}" is already in use.`, 'ALIAS_TAKEN');
    code = input.alias;
  } else {
    do code = randomCode();
    while (await aliasTaken(trx, code));
  }
  const now = Date.now();
  const id = await insertReturningId(trx, 'short_links', {
    code,
    target_url: input.targetUrl,
    owner_id: input.ownerId,
    qr_code_id: input.qrCodeId,
    is_active: true,
    created_at: now,
    updated_at: now,
  });
  return { id, code };
}

// --- Queries ----------------------------------------------------------------------------

const baseQuery = (trx: Knex | Knex.Transaction = db()) =>
  trx('short_links as l')
    .join('users as u', 'u.id', 'l.owner_id')
    .leftJoin('qr_codes as q', 'q.id', 'l.qr_code_id')
    .select('l.*', 'u.username as owner_username', 'q.title as qr_title');

function mapLink(r: Record<string, unknown>, base: string): ShortLink {
  return {
    id: Number(r.id),
    code: String(r.code),
    url: shortUrlFor(base, String(r.code)),
    targetUrl: String(r.target_url),
    ownerId: Number(r.owner_id),
    ownerUsername: String(r.owner_username ?? ''),
    qrCodeId: r.qr_code_id == null ? null : Number(r.qr_code_id),
    qrTitle: (r.qr_title as string | null) ?? null,
    isActive: Boolean(r.is_active),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function getLinkForQr(qrCodeId: number): Promise<ShortLink | null> {
  const row = await baseQuery().where('l.qr_code_id', qrCodeId).first();
  return row ? mapLink(row, await publicBaseUrl()) : null;
}

export async function getLink(id: number, user: User): Promise<ShortLink> {
  const row = await baseQuery().where('l.id', id).first();
  if (!row || (user.role !== 'admin' && Number(row.owner_id) !== user.id)) throw new HttpError(404, 'Short link not found.', 'NOT_FOUND');
  return mapLink(row, await publicBaseUrl());
}

export async function listLinks(user: User, opts: { search?: string; all?: boolean; limit: number; offset: number }): Promise<{ items: ShortLink[]; total: number }> {
  const q = baseQuery().whereNull('q.deleted_at');
  if (!(opts.all && user.role === 'admin')) q.where('l.owner_id', user.id);
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    q.where((w) =>
      w.whereRaw('LOWER(l.code) LIKE ?', [term]).orWhereRaw('LOWER(l.target_url) LIKE ?', [term]).orWhereRaw('LOWER(q.title) LIKE ?', [term]).orWhereRaw('LOWER(u.username) LIKE ?', [term]),
    );
  }
  const totalRow = await q.clone().clearSelect().count({ n: '*' }).first();
  const rows = await q.orderBy('l.updated_at', 'desc').limit(opts.limit).offset(opts.offset);
  const base = await publicBaseUrl();
  return { items: rows.map((r) => mapLink(r, base)), total: Number(totalRow?.n ?? 0) };
}

export async function linkHistory(id: number): Promise<LinkHistoryEntry[]> {
  const rows = await db()('short_link_history').where({ short_link_id: id }).orderBy([{ column: 'changed_at', order: 'desc' }, { column: 'id', order: 'desc' }]);
  return rows.map((r) => ({
    id: Number(r.id),
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    changedByName: r.changed_by_name,
    changedAt: Number(r.changed_at),
  }));
}

// --- Changes ----------------------------------------------------------------------------

export interface LinkPatch {
  targetUrl?: string; // already validated
  isActive?: boolean;
  expiresAt?: number | null;
}

/** Applies changes and records each one in the link's history. Returns the fields that changed. */
export async function updateLink(trx: Knex | Knex.Transaction, id: number, patch: LinkPatch, actor: Actor): Promise<string[]> {
  const row = await trx('short_links').where({ id }).first();
  if (!row) throw new HttpError(404, 'Short link not found.', 'NOT_FOUND');
  const now = Date.now();
  const changes: { field: LinkHistoryEntry['field']; old: string | null; next: string | null }[] = [];
  const update: Record<string, unknown> = {};

  if (patch.targetUrl !== undefined && patch.targetUrl !== row.target_url) {
    changes.push({ field: 'target', old: row.target_url, next: patch.targetUrl });
    update.target_url = patch.targetUrl;
  }
  if (patch.isActive !== undefined && patch.isActive !== Boolean(row.is_active)) {
    changes.push({ field: 'active', old: String(Boolean(row.is_active)), next: String(patch.isActive) });
    update.is_active = patch.isActive;
  }
  const oldExpiry = row.expires_at == null ? null : Number(row.expires_at);
  if (patch.expiresAt !== undefined && patch.expiresAt !== oldExpiry) {
    changes.push({ field: 'expires', old: oldExpiry == null ? null : new Date(oldExpiry).toISOString(), next: patch.expiresAt == null ? null : new Date(patch.expiresAt).toISOString() });
    update.expires_at = patch.expiresAt;
  }
  if (!changes.length) return [];

  await trx('short_links').where({ id }).update({ ...update, updated_at: now });
  await trx('short_link_history').insert(
    changes.map((c) => ({ short_link_id: id, field: c.field, old_value: c.old, new_value: c.next, changed_by: actor.id, changed_by_name: actor.name, changed_at: now })),
  );
  return changes.map((c) => c.field);
}

// --- Redirect ---------------------------------------------------------------------------

export type Resolution = { status: 'ok'; target: string; linkId: number } | { status: 'missing' | 'disabled' | 'expired' };

export async function resolveCode(code: string): Promise<Resolution> {
  const row = await db()('short_links').where({ code }).first();
  if (!row) return { status: 'missing' };
  if (!row.is_active) return { status: 'disabled' };
  if (row.expires_at != null && Number(row.expires_at) <= Date.now()) return { status: 'expired' };
  return { status: 'ok', target: String(row.target_url), linkId: Number(row.id) };
}

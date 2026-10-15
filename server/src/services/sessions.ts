import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { getSetting, SettingKeys } from './settings.js';

export const SESSION_COOKIE = 'genqr_sid';
const DEFAULT_TIMEOUT_MINUTES = 480;
// Avoid a DB write on every request: only slide the expiry once a minute.
const TOUCH_INTERVAL_MS = 60 * 1000;

const hashId = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex');

async function timeoutMs(): Promise<number> {
  return (await getSetting(SettingKeys.sessionTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES)) * 60 * 1000;
}

/** Creates a session and returns the raw cookie value. Only its hash is stored. */
export async function createSession(userId: number, meta: { ip: string | null; userAgent: string | undefined }): Promise<string> {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db()('sessions').insert({
    id: hashId(sid),
    user_id: userId,
    created_at: now,
    last_seen_at: now,
    expires_at: now + (await timeoutMs()),
    ip: meta.ip,
    user_agent: meta.userAgent?.slice(0, 500) ?? null,
  });
  return sid;
}

export interface Session {
  id: string;
  userId: number;
}

export async function loadSession(sid: string): Promise<Session | null> {
  const id = hashId(sid);
  const row = await db()('sessions').where({ id }).first();
  if (!row) return null;
  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    await db()('sessions').where({ id }).delete();
    return null;
  }
  if (now - Number(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    await db()('sessions').where({ id }).update({ last_seen_at: now, expires_at: now + (await timeoutMs()) });
  }
  return { id, userId: Number(row.user_id) };
}

export async function destroySession(id: string): Promise<void> {
  await db()('sessions').where({ id }).delete();
}

export async function destroyUserSessions(userId: number, exceptId?: string): Promise<void> {
  const q = db()('sessions').where({ user_id: userId });
  if (exceptId) q.whereNot({ id: exceptId });
  await q.delete();
}

export async function purgeExpiredSessions(): Promise<void> {
  await db()('sessions').where('expires_at', '<=', Date.now()).delete();
}

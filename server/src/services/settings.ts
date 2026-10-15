import type { Knex } from 'knex';
import { db } from '../db/index.js';

export const SettingKeys = {
  publicBaseUrl: 'app.publicBaseUrl',
  setupCompletedAt: 'app.setupCompletedAt',
  sessionTimeoutMinutes: 'auth.sessionTimeoutMinutes',
} as const;

const cache = new Map<string, unknown>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const row = await db()('settings').where({ key }).first();
  const value = row ? (JSON.parse(String(row.value)) as T) : fallback;
  if (row) cache.set(key, value);
  return value;
}

export async function setSetting(
  key: string,
  value: unknown,
  opts: { userId?: number | null; secret?: boolean; trx?: Knex | Knex.Transaction } = {},
): Promise<void> {
  const conn = opts.trx ?? db();
  const row = {
    value: JSON.stringify(value),
    is_secret: opts.secret ?? false,
    updated_by: opts.userId ?? null,
    updated_at: Date.now(),
  };
  const updated = await conn('settings').where({ key }).update(row);
  if (!updated) await conn('settings').insert({ key, ...row });
  cache.delete(key);
}

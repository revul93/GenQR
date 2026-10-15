import type { Knex } from 'knex';
import { db, insertReturningId, countRows } from '../db/index.js';

export type Role = 'admin' | 'user';
export type UserSource = 'local' | 'ad';

export interface User {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  source: UserSource;
  role: Role;
  mustChangePassword: boolean;
  isActive: boolean;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface UserRecord extends User {
  passwordHash: string | null;
  failedLogins: number;
  lockedUntil: number | null;
}

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

function mapUser(r: Record<string, unknown>): UserRecord {
  return {
    id: Number(r.id),
    username: String(r.username),
    displayName: String(r.display_name),
    email: (r.email as string | null) ?? null,
    source: r.source as UserSource,
    role: r.role as Role,
    mustChangePassword: Boolean(r.must_change_password),
    isActive: Boolean(r.is_active),
    lastLoginAt: numOrNull(r.last_login_at),
    createdAt: Number(r.created_at),
    passwordHash: (r.password_hash as string | null) ?? null,
    failedLogins: Number(r.failed_logins ?? 0),
    lockedUntil: numOrNull(r.locked_until),
  };
}

export function publicUser(u: UserRecord): User {
  const { passwordHash: _h, failedLogins: _f, lockedUntil: _l, ...rest } = u;
  return rest;
}

// Usernames are case-insensitive everywhere (AD sAMAccountName is too).
export const normalizeUsername = (username: string) => username.trim().toLowerCase();

export async function findUserByUsername(username: string, trx: Knex | Knex.Transaction = db()): Promise<UserRecord | null> {
  const row = await trx('users').where({ username: normalizeUsername(username) }).first();
  return row ? mapUser(row) : null;
}

export async function findUserById(id: number): Promise<UserRecord | null> {
  const row = await db()('users').where({ id }).first();
  return row ? mapUser(row) : null;
}

export function countUsers(trx: Knex | Knex.Transaction = db()): Promise<number> {
  return countRows(trx, 'users');
}

export interface NewUser {
  username: string;
  displayName: string;
  email: string | null;
  source: UserSource;
  role: Role;
  passwordHash: string | null;
  mustChangePassword?: boolean;
}

export async function createUser(input: NewUser, trx: Knex | Knex.Transaction = db()): Promise<number> {
  const now = Date.now();
  return insertReturningId(trx, 'users', {
    username: normalizeUsername(input.username),
    display_name: input.displayName,
    email: input.email,
    source: input.source,
    role: input.role,
    password_hash: input.passwordHash,
    must_change_password: input.mustChangePassword ?? false,
    is_active: true,
    failed_logins: 0,
    created_at: now,
    updated_at: now,
  });
}

export async function setPasswordHash(id: number, passwordHash: string, mustChangePassword: boolean): Promise<void> {
  await db()('users').where({ id }).update({
    password_hash: passwordHash,
    must_change_password: mustChangePassword,
    updated_at: Date.now(),
  });
}

/** Clears a lockout and re-enables the account. */
export async function unlockUser(id: number): Promise<void> {
  await db()('users').where({ id }).update({ failed_logins: 0, locked_until: null, is_active: true, updated_at: Date.now() });
}

export async function recordLoginFailure(user: UserRecord): Promise<void> {
  const failed = user.failedLogins + 1;
  await db()('users')
    .where({ id: user.id })
    .update({
      failed_logins: failed,
      locked_until: failed >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MS : null,
    });
}

export async function recordLoginSuccess(id: number): Promise<void> {
  await db()('users').where({ id }).update({ failed_logins: 0, locked_until: null, last_login_at: Date.now() });
}

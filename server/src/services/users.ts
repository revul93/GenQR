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
  // After a lock has expired the count starts again; otherwise one bad attempt would re-lock
  // the account, letting anyone keep it locked indefinitely.
  const lockExpired = user.lockedUntil != null && user.lockedUntil <= Date.now();
  const failed = (lockExpired ? 0 : user.failedLogins) + 1;
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

export interface UserListItem extends User {
  locked: boolean;
}

export async function listUsers(opts: { search?: string; source?: UserSource; role?: Role }): Promise<UserListItem[]> {
  const q = db()('users');
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    q.where((w) => w.whereRaw('LOWER(username) LIKE ?', [term]).orWhereRaw('LOWER(display_name) LIKE ?', [term]).orWhereRaw('LOWER(email) LIKE ?', [term]));
  }
  if (opts.source) q.where({ source: opts.source });
  if (opts.role) q.where({ role: opts.role });
  const rows = await q.orderBy('username');
  const now = Date.now();
  return rows.map((r) => {
    const u = mapUser(r);
    return { ...publicUser(u), locked: !!u.lockedUntil && u.lockedUntil > now };
  });
}

export interface UserPatch {
  displayName?: string;
  email?: string | null;
  role?: Role;
  isActive?: boolean;
}

export async function updateUser(id: number, patch: UserPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: Date.now() };
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  await db()('users').where({ id }).update(row);
}

export async function deleteUser(id: number): Promise<void> {
  await db()('users').where({ id }).delete();
}

export async function countActiveAdmins(): Promise<number> {
  const row = await db()('users').where({ role: 'admin', is_active: true }).count({ n: '*' }).first();
  return Number(row?.n ?? 0);
}

/** Invalidates emailed reset links, e.g. after an admin reset or when the account is disabled. */
export async function revokePasswordResets(id: number): Promise<void> {
  await db()('password_resets').where({ user_id: id }).delete();
}

export async function clearLockout(id: number): Promise<void> {
  await db()('users').where({ id }).update({ failed_logins: 0, locked_until: null });
}

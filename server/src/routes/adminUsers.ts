import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { clientIp, HttpError, parseBody } from '../http.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { requireAdmin } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { findAdUser, searchAdUsers } from '../services/activeDirectory.js';
import { destroyUserSessions } from '../services/sessions.js';
import {
  countActiveAdmins,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listUsers,
  normalizeUsername,
  publicUser,
  setPasswordHash,
  clearLockout,
  updateUser,
  type UserRecord,
} from '../services/users.js';
import { USERNAME_PATTERN } from './setup.js';

export const adminUsersRouter = Router();
adminUsersRouter.use(requireAdmin);

const role = z.enum(['admin', 'user']);
const username = z.string().trim().regex(USERNAME_PATTERN, 'Use 3-64 letters, digits, dots, dashes or underscores.');
const email = z.union([z.email(), z.literal('').transform(() => null), z.null()]);

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  source: z.enum(['local', 'ad']).optional(),
  role: role.optional(),
});

const createLocalSchema = z.object({
  username,
  displayName: z.string().trim().min(1).max(200),
  email: email.optional(),
  role,
  password: z.string().max(1024),
  mustChangePassword: z.boolean().default(true),
});

const importSchema = z.object({
  users: z.array(z.object({ username: z.string().trim().min(1).max(100), role })).min(1).max(100),
});

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  email: email.optional(),
  role: role.optional(),
  isActive: z.boolean().optional(),
});

const resetSchema = z.object({
  password: z.string().max(1024),
  mustChangePassword: z.boolean().default(true),
});

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid user id.');
  return id;
};

async function loadUser(req: Request): Promise<UserRecord> {
  const user = await findUserById(idParam(req));
  if (!user) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
  return user;
}

/** Changes that would leave nobody able to administer GenQR are refused. */
async function guardLastAdmin(target: UserRecord, losingAdmin: boolean): Promise<void> {
  if (losingAdmin && target.role === 'admin' && target.isActive && (await countActiveAdmins()) <= 1) {
    throw new HttpError(409, 'This is the last active administrator. Make another user an administrator first.', 'LAST_ADMIN');
  }
}

adminUsersRouter.get('/', async (req, res) => {
  const { q, source, role } = parseBody(listQuery, req.query);
  res.json({ users: await listUsers({ search: q || undefined, source, role }) });
});

adminUsersRouter.post('/local', async (req, res) => {
  const body = parseBody(createLocalSchema, req.body);
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');
  if (await findUserByUsername(body.username)) throw new HttpError(409, `A user named "${normalizeUsername(body.username)}" already exists.`, 'USERNAME_TAKEN');

  const id = await createUser({
    username: body.username,
    displayName: body.displayName,
    email: body.email ?? null,
    source: 'local',
    role: body.role,
    passwordHash: await hashPassword(body.password),
    mustChangePassword: body.mustChangePassword,
  });
  const user = publicUser((await findUserById(id))!);
  await audit({ actor: actorOf(req.user!), action: 'user.created', entityType: 'user', entityId: id, details: { username: user.username, source: 'local', role: user.role }, ip: clientIp(req) });
  res.status(201).json({ user });
});

adminUsersRouter.get('/ad-search', async (req, res) => {
  const { q } = parseBody(z.object({ q: z.string().trim().min(2, 'Type at least 2 characters.').max(100) }), req.query);
  const results = await searchAdUsers(q);
  const imported = new Set((await db()('users').whereIn('username', results.map((r) => normalizeUsername(r.username))).select('username')).map((r) => r.username as string));
  res.json({ users: results.map((u) => ({ ...u, imported: imported.has(normalizeUsername(u.username)) })) });
});

adminUsersRouter.post('/import', async (req, res) => {
  const { users } = parseBody(importSchema, req.body);
  const imported: string[] = [];
  const skipped: { username: string; reason: string }[] = [];

  for (const item of users) {
    if (await findUserByUsername(item.username)) {
      skipped.push({ username: item.username, reason: 'A user with this name already exists in GenQR.' });
      continue;
    }
    // Re-read from AD rather than trusting the browser for names and emails.
    const adUser = await findAdUser(item.username);
    if (!adUser) {
      skipped.push({ username: item.username, reason: 'Not found in Active Directory.' });
      continue;
    }
    const id = await createUser({ username: adUser.username, displayName: adUser.displayName, email: adUser.email, source: 'ad', role: item.role, passwordHash: null });
    imported.push(adUser.username);
    await audit({ actor: actorOf(req.user!), action: 'user.imported', entityType: 'user', entityId: id, details: { username: adUser.username, role: item.role, dn: adUser.dn }, ip: clientIp(req) });
  }
  res.json({ imported, skipped });
});

adminUsersRouter.patch('/:id', async (req, res) => {
  const target = await loadUser(req);
  const patch = parseBody(patchSchema, req.body);
  const self = target.id === req.user!.id;

  if (self && (patch.isActive === false || patch.role === 'user')) throw new HttpError(409, 'You cannot disable or demote your own account.', 'SELF_CHANGE');
  await guardLastAdmin(target, patch.isActive === false || patch.role === 'user');
  // Name and email of AD users come from the directory and are refreshed at each sign-in.
  if (target.source === 'ad' && (patch.displayName !== undefined || patch.email !== undefined)) {
    throw new HttpError(400, 'Name and email of Active Directory users are managed in AD.', 'AD_USER');
  }

  await updateUser(target.id, patch);
  if (patch.isActive === false) await destroyUserSessions(target.id);

  const changes = Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [k, { from: (target as unknown as Record<string, unknown>)[k], to: v }]),
  );
  await audit({ actor: actorOf(req.user!), action: 'user.updated', entityType: 'user', entityId: target.id, details: { username: target.username, changes }, ip: clientIp(req) });
  res.json({ user: publicUser((await findUserById(target.id))!) });
});

adminUsersRouter.post('/:id/reset-password', async (req, res) => {
  const target = await loadUser(req);
  if (target.source !== 'local') throw new HttpError(400, 'Active Directory passwords are managed in AD.', 'AD_USER');
  const { password, mustChangePassword } = parseBody(resetSchema, req.body);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');

  await setPasswordHash(target.id, await hashPassword(password), mustChangePassword);
  await clearLockout(target.id);
  await destroyUserSessions(target.id, target.id === req.user!.id ? req.sessionId : undefined);
  await audit({ actor: actorOf(req.user!), action: 'user.password_reset', entityType: 'user', entityId: target.id, details: { username: target.username, mustChangePassword }, ip: clientIp(req) });
  res.json({ user: publicUser((await findUserById(target.id))!) });
});

adminUsersRouter.post('/:id/unlock', async (req, res) => {
  const target = await loadUser(req);
  await clearLockout(target.id);
  await audit({ actor: actorOf(req.user!), action: 'user.unlocked', entityType: 'user', entityId: target.id, details: { username: target.username }, ip: clientIp(req) });
  res.json({ user: publicUser((await findUserById(target.id))!) });
});

adminUsersRouter.delete('/:id', async (req, res) => {
  const target = await loadUser(req);
  if (target.id === req.user!.id) throw new HttpError(409, 'You cannot delete your own account.', 'SELF_CHANGE');
  await guardLastAdmin(target, true);
  await deleteUser(target.id);
  await audit({ actor: actorOf(req.user!), action: 'user.deleted', entityType: 'user', entityId: target.id, details: { username: target.username, source: target.source, role: target.role }, ip: clientIp(req) });
  res.json({ ok: true });
});

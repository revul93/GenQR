import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { clientIp, HttpError, parseBody } from '../http.js';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { verifyAdCredentials } from '../auth/activeDirectory.js';
import { clearSessionCookie, requireSession, setSessionCookie } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { createSession, destroySession, destroyUserSessions } from '../services/sessions.js';
import {
  findUserById,
  findUserByUsername,
  publicUser,
  recordLoginFailure,
  recordLoginSuccess,
  setPasswordHash,
} from '../services/users.js';

const INVALID_CREDENTIALS = 'Invalid username or password.';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().max(1024),
});

export const authRouter = Router();

authRouter.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), async (req, res) => {
  const { username, password } = parseBody(loginSchema, req.body);
  const ip = clientIp(req);
  const user = await findUserByUsername(username);

  // Local DB first. Users who were not created or imported by an admin never sign in,
  // and AD is not contacted for them.
  if (!user) {
    await dummyVerify(password);
    await audit({ actor: { id: null, name: username.toLowerCase() }, action: 'auth.login_failed', details: { reason: 'unknown_user' }, ip });
    throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }
  if (!user.isActive) {
    await dummyVerify(password);
    await audit({ actor: actorOf(user), action: 'auth.login_failed', details: { reason: 'disabled' }, ip });
    throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    await audit({ actor: actorOf(user), action: 'auth.login_failed', details: { reason: 'locked' }, ip });
    throw new HttpError(423, 'Too many failed attempts. The account is temporarily locked; try again later.', 'LOCKED');
  }

  const ok =
    user.source === 'local'
      ? !!user.passwordHash && (await verifyPassword(user.passwordHash, password))
      : await verifyAdCredentials(user.username, password);

  if (!ok) {
    await recordLoginFailure(user);
    await audit({ actor: actorOf(user), action: 'auth.login_failed', details: { reason: 'bad_password', source: user.source }, ip });
    throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  await recordLoginSuccess(user.id);
  const sid = await createSession(user.id, { ip, userAgent: req.get('user-agent') });
  setSessionCookie(req, res, sid);
  await audit({ actor: actorOf(user), action: 'auth.login', details: { source: user.source }, ip });
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionId) {
    await destroySession(req.sessionId);
    await audit({ actor: actorOf(req.user!), action: 'auth.logout', ip: clientIp(req) });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireSession, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/change-password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
  const user = (await findUserById(req.user!.id))!;
  if (user.source !== 'local') throw new HttpError(400, 'Active Directory passwords are changed through your organisation, not in GenQR.', 'AD_USER');
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new HttpError(400, 'Current password is incorrect.', 'BAD_PASSWORD');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');
  if (newPassword === currentPassword) throw new HttpError(400, 'The new password must be different.', 'SAME_PASSWORD');

  await setPasswordHash(user.id, await hashPassword(newPassword), false);
  await destroyUserSessions(user.id, req.sessionId);
  await audit({ actor: actorOf(user), action: 'auth.password_changed', entityType: 'user', entityId: user.id, ip: clientIp(req) });
  res.json({ user: publicUser((await findUserById(user.id))!) });
});

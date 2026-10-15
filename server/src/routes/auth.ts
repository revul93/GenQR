import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { clientIp, HttpError, parseBody } from '../http.js';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { AdUnavailableError, verifyAdCredentials, type AdLoginResult } from '../services/activeDirectory.js';
import { clearSessionCookie, requireSession, setSessionCookie } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { createSession, destroySession, destroyUserSessions } from '../services/sessions.js';
import { isEmailEnabled } from '../services/email.js';
import { requestPasswordReset, resetPassword } from '../services/passwordReset.js';
import {
  findUserById,
  findUserByUsername,
  publicUser,
  recordLoginFailure,
  recordLoginSuccess,
  setPasswordHash,
  updateUser,
  type UserRecord,
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

/**
 * Exact username first. People often type "DOMAIN\user" or "user@domain" for AD
 * accounts, so fall back to the bare name — but only when it belongs to an AD user.
 */
async function findLoginUser(input: string): Promise<UserRecord | null> {
  const exact = await findUserByUsername(input);
  if (exact) return exact;
  const bare = input.includes('\\') ? input.split('\\').pop()! : input.includes('@') ? input.split('@')[0]! : null;
  if (!bare) return null;
  const user = await findUserByUsername(bare);
  return user?.source === 'ad' ? user : null;
}

authRouter.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), async (req, res) => {
  const { username, password } = parseBody(loginSchema, req.body);
  const ip = clientIp(req);
  const user = await findLoginUser(username);

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

  let ok: boolean;
  let reason = 'bad_password';
  if (user.source === 'local') {
    ok = !!user.passwordHash && (await verifyPassword(user.passwordHash, password));
  } else {
    let result: AdLoginResult;
    try {
      result = await verifyAdCredentials(user.username, password);
    } catch (err) {
      // Details (server names, errors) go to the log and audit trail, not to anonymous callers.
      if (!(err instanceof AdUnavailableError)) throw err;
      console.error('AD sign-in failed:', err.message);
      await audit({ actor: actorOf(user), action: 'auth.login_failed', details: { reason: 'ad_unavailable', error: err.message }, ip });
      throw new HttpError(503, 'The sign-in service is temporarily unavailable. Please try again later.', 'AD_UNAVAILABLE');
    }
    ok = result.ok;
    if (result.ok) {
      // Keep name and email in step with the directory.
      const { displayName, email } = result.user;
      if (displayName !== user.displayName || email !== user.email) await updateUser(user.id, { displayName, email });
    } else {
      reason = `ad_${result.reason}`;
    }
  }

  if (!ok) {
    await recordLoginFailure(user);
    await audit({ actor: actorOf(user), action: 'auth.login_failed', details: { reason, source: user.source }, ip });
    throw new HttpError(401, INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  await recordLoginSuccess(user.id);
  const sid = await createSession(user.id, { ip, userAgent: req.get('user-agent') });
  setSessionCookie(req, res, sid);
  await audit({ actor: actorOf(user), action: 'auth.login', details: { source: user.source }, ip });
  res.json({ user: publicUser((await findUserById(user.id))!) });
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

// --- Self-service password reset --------------------------------------------------------

authRouter.get('/options', async (_req, res) => {
  res.json({ emailEnabled: await isEmailEnabled() });
});

authRouter.post('/forgot', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 }), async (req, res) => {
  const { login } = parseBody(z.object({ login: z.string().trim().min(1).max(255) }), req.body);
  await requestPasswordReset(login, clientIp(req));
  res.json({ ok: true });
});

authRouter.post('/reset', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), async (req, res) => {
  const { token, password } = parseBody(z.object({ token: z.string().min(20).max(200), password: z.string().max(1024) }), req.body);
  const user = await resetPassword(token, password, clientIp(req));
  res.json({ ok: true, username: user.username });
});

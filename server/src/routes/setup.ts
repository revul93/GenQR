import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/index.js';
import { clientIp, HttpError, parseBody } from '../http.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { setSessionCookie } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { createSession } from '../services/sessions.js';
import { setSetting, SettingKeys } from '../services/settings.js';
import { removeSetupToken, verifySetupToken } from '../services/setupToken.js';
import { countUsers, createUser, findUserById, publicUser } from '../services/users.js';

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

const setupSchema = z.object({
  token: z.string().min(1),
  username: z.string().trim().regex(USERNAME_PATTERN, 'Use 3-64 letters, digits, dots, dashes or underscores.'),
  displayName: z.string().trim().min(1).max(200),
  email: z.email('Enter a valid recovery email.'),
  password: z.string(),
  publicBaseUrl: z
    .url({ protocol: /^https?$/, message: 'Enter a full http:// or https:// URL.' })
    .transform((u) => u.replace(/\/+$/, '')),
});

export const setupRouter = Router();

setupRouter.get('/status', async (_req, res) => {
  res.json({ needsSetup: (await countUsers()) === 0 });
});

setupRouter.post('/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), async (req, res) => {
  const body = parseBody(setupSchema, req.body);
  if ((await countUsers()) > 0) throw new HttpError(409, 'Setup has already been completed.', 'SETUP_DONE');
  if (!verifySetupToken(body.token)) {
    await audit({ actor: { id: null, name: body.username }, action: 'setup.bad_token', ip: clientIp(req) });
    throw new HttpError(403, 'Invalid setup token. Run "genqrctl setup-token" on the server to see it.', 'BAD_SETUP_TOKEN');
  }
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');

  const passwordHash = await hashPassword(body.password);
  const userId = await db().transaction(async (trx) => {
    // Re-check inside the transaction so two concurrent submissions can't both create an admin.
    if ((await countUsers(trx)) > 0) throw new HttpError(409, 'Setup has already been completed.', 'SETUP_DONE');
    const id = await createUser(
      { username: body.username, displayName: body.displayName, email: body.email, source: 'local', role: 'admin', passwordHash },
      trx,
    );
    await setSetting(SettingKeys.publicBaseUrl, body.publicBaseUrl, { userId: id, trx });
    await setSetting(SettingKeys.setupCompletedAt, new Date().toISOString(), { userId: id, trx });
    return id;
  });
  removeSetupToken();

  const user = publicUser((await findUserById(userId))!);
  await audit({ actor: { id: user.id, name: user.username }, action: 'setup.completed', entityType: 'user', entityId: user.id, details: { publicBaseUrl: body.publicBaseUrl }, ip: clientIp(req) });

  const sid = await createSession(user.id, { ip: clientIp(req), userAgent: req.get('user-agent') });
  setSessionCookie(req, res, sid);
  res.status(201).json({ user });
});

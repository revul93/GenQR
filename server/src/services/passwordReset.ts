import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { HttpError } from '../http.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { actorOf, audit, SYSTEM_ACTOR } from './audit.js';
import { escapeHtml, isEmailEnabled, layout, sendMail } from './email.js';
import { destroyUserSessions } from './sessions.js';
import { publicBaseUrl } from './shortLinks.js';
import { clearLockout, normalizeUsername, setPasswordHash, findUserById, type UserRecord } from './users.js';

/** Self-service password reset for local accounts, by emailed one-time link. */

const TOKEN_TTL_MS = 60 * 60 * 1000;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

async function localUsersFor(login: string): Promise<UserRecord[]> {
  const value = login.trim().toLowerCase();
  const rows = await db()('users')
    .where({ source: 'local', is_active: true })
    .whereNotNull('email')
    .where((q) => q.where({ username: normalizeUsername(value) }).orWhereRaw('LOWER(email) = ?', [value]));
  return (await Promise.all(rows.map((r) => findUserById(Number(r.id))))).filter((u): u is UserRecord => !!u);
}

/**
 * Emails a reset link to matching local users. Always looks the same to the caller, so it
 * cannot be used to find out which usernames or addresses exist.
 */
export async function requestPasswordReset(login: string, ip: string | null): Promise<void> {
  if (!(await isEmailEnabled())) throw new HttpError(403, 'Password reset by email is not available. Ask an administrator.', 'EMAIL_DISABLED');
  const users = await localUsersFor(login);
  if (!users.length) {
    await audit({ actor: { id: null, name: login.slice(0, 100) }, action: 'auth.reset_requested', details: { matched: false }, ip });
    return;
  }
  // Sent in the background: answering only after SMTP finishes would reveal (by timing) that the account exists.
  void sendResetLinks(users, ip).catch((err) => console.error('Password reset failed:', err));
}

async function sendResetLinks(users: UserRecord[], ip: string | null): Promise<void> {
  const base = await publicBaseUrl();
  for (const user of users) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db().transaction(async (trx) => {
      // Only the newest link works.
      await trx('password_resets').where({ user_id: user.id }).whereNull('used_at').delete();
      await trx('password_resets').insert({ token_hash: hashToken(token), user_id: user.id, expires_at: Date.now() + TOKEN_TTL_MS });
    });
    const link = `${base}/reset-password?token=${token}`;
    try {
      await sendMail(
        {
          to: [user.email!],
          subject: 'Reset your GenQR password',
          text: `Hello ${user.displayName},\n\nSomeone asked to reset the GenQR password for "${user.username}". Open this link within one hour to choose a new password:\n\n${link}\n\nIf this wasn't you, ignore this email; your password stays the same.`,
          html: layout(
            'Reset your password',
            `<p>Hello ${escapeHtml(user.displayName)},</p><p>Someone asked to reset the GenQR password for <b>${escapeHtml(user.username)}</b>. The link works for one hour.</p>` +
              `<p style="text-align:center;margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0b5394;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none">Choose a new password</a></p>` +
              `<p style="color:#52606d;font-size:12px">If this wasn't you, ignore this email; your password stays the same.</p>`,
          ),
        },
        { kind: 'password_reset', actor: SYSTEM_ACTOR },
      );
      await audit({ actor: actorOf(user), action: 'auth.reset_requested', details: { matched: true }, ip });
    } catch (err) {
      // Logged in email_log; the caller still gets the generic answer.
      console.error('Password reset email failed:', (err as Error).message);
    }
  }
}

export async function resetPassword(token: string, password: string, ip: string | null): Promise<UserRecord> {
  const row = await db()('password_resets').where({ token_hash: hashToken(token) }).first();
  const invalid = new HttpError(400, 'This reset link is invalid or has expired. Request a new one.', 'BAD_RESET_TOKEN');
  if (!row || row.used_at != null || Number(row.expires_at) < Date.now()) throw invalid;
  const user = await findUserById(Number(row.user_id));
  if (!user || user.source !== 'local' || !user.isActive) throw invalid;

  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');

  await setPasswordHash(user.id, await hashPassword(password), false);
  await clearLockout(user.id);
  await db()('password_resets').where({ token_hash: row.token_hash }).update({ used_at: Date.now() });
  await destroyUserSessions(user.id);
  await audit({ actor: actorOf(user), action: 'auth.password_reset_by_email', entityType: 'user', entityId: user.id, ip });
  return user;
}

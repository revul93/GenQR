import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../http.js';
import { destroySession, loadSession, SESSION_COOKIE } from '../services/sessions.js';
import { findUserById, publicUser, type User } from '../services/users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

export function setSessionCookie(req: Request, res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Attaches req.user when the request carries a valid session for an active user. */
export async function sessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (sid) {
    const session = await loadSession(sid);
    const user = session ? await findUserById(session.userId) : null;
    if (session && user?.isActive) {
      req.user = publicUser(user);
      req.sessionId = session.id;
    } else {
      if (session) await destroySession(session.id);
      clearSessionCookie(res);
    }
  }
  next();
}

/** Signed in, even if a password change is still pending. Used by the auth routes themselves. */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Not signed in.', 'UNAUTHENTICATED');
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  requireSession(req, res, () => {
    if (req.user!.mustChangePassword) throw new HttpError(403, 'You must change your password first.', 'PASSWORD_CHANGE_REQUIRED');
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user!.role !== 'admin') throw new HttpError(403, 'Administrator access required.', 'FORBIDDEN');
    next();
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence alongside SameSite=Lax cookies: browsers always send Origin on cross-site
 * state-changing requests, so reject any whose Origin host differs from ours.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (SAFE_METHODS.has(req.method) || !origin) return next();
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Invalid request origin.', 'BAD_ORIGIN');
  }
  // req.host honours X-Forwarded-Host only from trusted proxies ("trust proxy" setting).
  if (originHost !== req.host) throw new HttpError(403, 'Cross-site request rejected.', 'BAD_ORIGIN');
  next();
}

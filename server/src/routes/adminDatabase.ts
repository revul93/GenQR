import { Router, type NextFunction, type Request, type Response } from 'express';
import { HttpError, clientIp, parseBody } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';
import { DB_CLIENTS, describeDbConfig, loadDbConfig } from '../db/index.js';
import { driverState } from '../db/drivers.js';
import { assertSwitchable, isSwitchRunning, markRestarting, runSwitch, switchStatus, switchTargetSchema, testTarget } from '../db/switch.js';
import { actorOf, audit } from '../services/audit.js';
import { canSelfRestart, restartSoon } from '../services/lifecycle.js';

export const adminDatabaseRouter = Router();
adminDatabaseRouter.use(requireAdmin);

/** While data is being copied, changes would be lost: refuse writes everywhere else. */
export function maintenanceGuard(req: Request, _res: Response, next: NextFunction): void {
  if (isSwitchRunning() && req.method !== 'GET' && !req.path.startsWith('/admin/database')) {
    throw new HttpError(503, 'GenQR is moving to another database. Please try again in a few minutes.', 'MAINTENANCE');
  }
  next();
}

adminDatabaseRouter.get('/', (_req, res) => {
  res.json({
    current: describeDbConfig(loadDbConfig()),
    drivers: DB_CLIENTS.map(driverState),
    status: switchStatus(),
    canSelfRestart: canSelfRestart(),
  });
});

adminDatabaseRouter.get('/status', (_req, res) => {
  res.json(switchStatus());
});

adminDatabaseRouter.post('/test', async (req, res) => {
  const target = parseBody(switchTargetSchema, req.body);
  try {
    res.json({ ok: true, ...(await testTarget(target)) });
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

adminDatabaseRouter.post('/switch', async (req, res) => {
  const target = parseBody(switchTargetSchema, req.body);
  try {
    assertSwitchable(target);
  } catch (err) {
    throw new HttpError(409, (err as Error).message, 'SWITCH_REFUSED');
  }
  const actor = actorOf(req.user!);
  const { password: _p, ...safeTarget } = target as typeof target & { password?: string };
  await audit({ actor, action: 'database.switch_started', details: { from: loadDbConfig().client, target: safeTarget }, ip: clientIp(req) });

  // Runs in the background; the page follows progress through /status.
  void runSwitch(target, actor.name)
    .then(async () => {
      await audit({ actor, action: 'database.switch_copied', details: { to: target.client } });
      if (canSelfRestart()) {
        markRestarting();
        restartSoon();
      }
    })
    .catch(async (err: Error) => {
      await audit({ actor, action: 'database.switch_failed', details: { to: target.client, error: err.message } });
    });
  res.status(202).json(switchStatus());
});

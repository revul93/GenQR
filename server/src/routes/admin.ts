import { Router } from 'express';
import { z } from 'zod';
import { dbClient } from '../db/index.js';
import { clientIp, HttpError, parseBody } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';
import { actorOf, audit, listAudit } from '../services/audit.js';
import { checkForUpdates, getVersionInfo, isUpdateInProgress, readUpdateLog, readUpdateStatus, requestUpdate } from '../services/system.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(100).optional(),
});

adminRouter.get('/audit', async (req, res) => {
  const { limit, offset, q } = parseBody(auditQuery, req.query);
  res.json(await listAudit({ limit, offset, search: q || undefined }));
});

adminRouter.get('/system', async (_req, res) => {
  res.json({
    ...(await getVersionInfo()),
    database: dbClient(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    uptimeSeconds: Math.round(process.uptime()),
    update: readUpdateStatus(),
  });
});

adminRouter.post('/system/check-updates', async (_req, res) => {
  res.json(await checkForUpdates());
});

adminRouter.post('/system/update', async (req, res) => {
  if (isUpdateInProgress()) throw new HttpError(409, 'An update is already in progress.', 'UPDATE_IN_PROGRESS');
  requestUpdate(req.user!.username);
  await audit({ actor: actorOf(req.user!), action: 'system.update_requested', details: { fromCommit: (await getVersionInfo()).commit }, ip: clientIp(req) });
  res.status(202).json({ update: readUpdateStatus() });
});

adminRouter.get('/system/update-log', (_req, res) => {
  res.json({ update: readUpdateStatus(), log: readUpdateLog() });
});

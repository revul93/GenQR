import { Router } from 'express';
import { z } from 'zod';
import { clientIp, parseBody } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { adConfigSchema, getAdConfig, saveAdConfig, testAdConfig } from '../services/activeDirectory.js';

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAdmin);

const adSaveSchema = adConfigSchema.extend({ bindPassword: z.string().max(1024).optional() });
const adTestSchema = adSaveSchema.extend({ testUsername: z.string().trim().max(100).optional() });

adminSettingsRouter.get('/ad', async (_req, res) => {
  res.json({ config: await getAdConfig() });
});

adminSettingsRouter.put('/ad', async (req, res) => {
  const { bindPassword, ...config } = parseBody(adSaveSchema, req.body);
  const before = await getAdConfig();
  await saveAdConfig(config, bindPassword || undefined, req.user!.id);
  await audit({
    actor: actorOf(req.user!),
    action: 'settings.ad_updated',
    details: { enabled: config.enabled, urls: config.urls, baseDn: config.baseDn, bindDn: config.bindDn, passwordChanged: !!bindPassword, wasEnabled: before.enabled },
    ip: clientIp(req),
  });
  res.json({ config: await getAdConfig() });
});

adminSettingsRouter.post('/ad/test', async (req, res) => {
  const { bindPassword, testUsername, ...config } = parseBody(adTestSchema, req.body);
  res.json(await testAdConfig(config, bindPassword || undefined, testUsername || undefined));
});

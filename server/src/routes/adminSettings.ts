import { Router } from 'express';
import { z } from 'zod';
import { clientIp, HttpError, parseBody } from '../http.js';
import { requireAdmin } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { adConfigSchema, getAdConfig, saveAdConfig, testAdConfig } from '../services/activeDirectory.js';
import { getUsableLogo } from '../services/logos.js';
import { deletePreset, savePreset } from '../services/presets.js';
import { qrStyleSchema } from '../qr/style.js';
import { getLinkPolicy, linkPolicySchema, publicBaseUrl, saveLinkPolicy } from '../services/shortLinks.js';
import { setSetting, SettingKeys } from '../services/settings.js';

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

// --- Branding presets ---------------------------------------------------------------

const presetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  style: qrStyleSchema,
  logoId: z.number().int().positive().nullable().default(null),
  isDefault: z.boolean().default(false),
});

const presetId = (raw: string | string[] | undefined) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
  return id;
};

adminSettingsRouter.post('/presets', async (req, res) => {
  const body = parseBody(presetSchema, req.body);
  if (body.logoId) await getUsableLogo(body.logoId, req.user!);
  const preset = await savePreset(body, req.user!.id);
  await audit({ actor: actorOf(req.user!), action: 'preset.created', entityType: 'preset', entityId: preset.id, details: { name: preset.name, isDefault: preset.isDefault }, ip: clientIp(req) });
  res.status(201).json({ preset });
});

adminSettingsRouter.put('/presets/:id', async (req, res) => {
  const body = parseBody(presetSchema, req.body);
  if (body.logoId) await getUsableLogo(body.logoId, req.user!);
  const preset = await savePreset(body, req.user!.id, presetId(req.params.id));
  await audit({ actor: actorOf(req.user!), action: 'preset.updated', entityType: 'preset', entityId: preset.id, details: { name: preset.name, isDefault: preset.isDefault }, ip: clientIp(req) });
  res.json({ preset });
});

adminSettingsRouter.delete('/presets/:id', async (req, res) => {
  const preset = await deletePreset(presetId(req.params.id));
  await audit({ actor: actorOf(req.user!), action: 'preset.deleted', entityType: 'preset', entityId: preset.id, details: { name: preset.name }, ip: clientIp(req) });
  res.json({ ok: true });
});

// --- Short links ----------------------------------------------------------------------

const linkSettingsSchema = z.object({
  publicBaseUrl: z
    .url({ protocol: /^https?$/, message: 'Enter a full http:// or https:// address.' })
    .transform((u) => u.replace(/\/+$/, '')),
  policy: linkPolicySchema,
});

adminSettingsRouter.get('/links', async (_req, res) => {
  res.json({ publicBaseUrl: await publicBaseUrl(), policy: await getLinkPolicy() });
});

adminSettingsRouter.put('/links', async (req, res) => {
  const body = parseBody(linkSettingsSchema, req.body);
  const before = { publicBaseUrl: await publicBaseUrl(), policy: await getLinkPolicy() };
  await setSetting(SettingKeys.publicBaseUrl, body.publicBaseUrl, { userId: req.user!.id });
  await saveLinkPolicy(body.policy, req.user!.id);
  await audit({ actor: actorOf(req.user!), action: 'settings.links_updated', details: { before, after: body }, ip: clientIp(req) });
  res.json(body);
});

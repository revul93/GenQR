import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { clientIp, HttpError, parseBody } from '../http.js';
import { requireAuth } from '../auth/middleware.js';
import { actorOf, audit } from '../services/audit.js';
import { syncQrContent } from '../services/qrCodes.js';
import { getLink, linkHistory, listLinks, updateLink, validateTarget } from '../services/shortLinks.js';

export const linksRouter = Router();
linksRouter.use(requireAuth);

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  all: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const patchSchema = z.object({
  targetUrl: z.string().trim().min(1).max(2000).optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(), // epoch ms; null = never
});

const idOf = (raw: string | string[] | undefined) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
  return id;
};

linksRouter.get('/', async (req, res) => {
  const { q, all, limit, offset } = parseBody(listQuery, req.query);
  res.json(await listLinks(req.user!, { search: q || undefined, all: all === '1', limit, offset }));
});

linksRouter.get('/:id', async (req, res) => {
  const link = await getLink(idOf(req.params.id), req.user!);
  res.json({ link, history: await linkHistory(link.id) });
});

linksRouter.patch('/:id', async (req, res) => {
  const link = await getLink(idOf(req.params.id), req.user!);
  const body = parseBody(patchSchema, req.body);
  const targetUrl = body.targetUrl === undefined ? undefined : await validateTarget(body.targetUrl);
  if (body.isActive && body.expiresAt === undefined && link.expiresAt && link.expiresAt <= Date.now()) {
    throw new HttpError(400, 'This link has expired. Clear or extend the expiry date to switch it back on.', 'EXPIRED');
  }

  const actor = actorOf(req.user!);
  const changed = await db().transaction(async (trx) => {
    const fields = await updateLink(trx, link.id, { targetUrl, isActive: body.isActive, expiresAt: body.expiresAt }, actor);
    if (targetUrl && fields.includes('target') && link.qrCodeId) await syncQrContent(trx, link.qrCodeId, targetUrl);
    return fields;
  });
  if (changed.length) {
    await audit({
      actor,
      action: 'link.updated',
      entityType: 'link',
      entityId: link.id,
      details: {
        code: link.code,
        ...(changed.includes('target') ? { target: { from: link.targetUrl, to: targetUrl } } : {}),
        ...(changed.includes('active') ? { isActive: body.isActive } : {}),
        ...(changed.includes('expires') ? { expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null } : {}),
      },
      ip: clientIp(req),
    });
  }
  const updated = await getLink(link.id, req.user!);
  res.json({ link: updated, history: await linkHistory(link.id) });
});

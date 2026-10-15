import { Router, type Request } from 'express';
import { z } from 'zod';
import { clientIp, HttpError, parseBody } from '../http.js';
import { requireAuth } from '../auth/middleware.js';
import { renderSvg, scanCheck } from '../qr/render.js';
import { qrStyleSchema } from '../qr/style.js';
import { EXPORT_TYPES, exportQr, type ExportFormat } from '../qr/export.js';
import { actorOf, audit } from '../services/audit.js';
import { deleteLogo, getUsableLogo, listLogos, logoDataUri, readLogoFile, saveLogo } from '../services/logos.js';
import { listPresets } from '../services/presets.js';
import { createQr, getQr, listQr, softDeleteQr, svgRendererFor, updateQr, type QrInput } from '../services/qrCodes.js';
import { sampleQrData, validateTarget } from '../services/shortLinks.js';

export const qrRouter = Router();
qrRouter.use(requireAuth);

const MAX_CONTENT = 2000;

const contentSchema = z.object({
  contentType: z.enum(['url', 'text']),
  content: z.string().trim().min(1, 'Enter the link or text to encode.').max(MAX_CONTENT),
  style: qrStyleSchema,
  logoId: z.number().int().positive().nullable().default(null),
});

const qrSchema = contentSchema.extend({ title: z.string().trim().min(1, 'Give the QR code a title.').max(200) });
const createSchema = qrSchema.extend({ alias: z.string().trim().max(40).optional() });
// The preview also renders while the content field is still empty.
const previewSchema = contentSchema.extend({ content: z.string().trim().max(MAX_CONTENT), qrId: z.number().int().positive().optional() });

const idOf = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
  return id;
};

async function checkLogo(input: { logoId: number | null }, req: Request) {
  if (input.logoId != null) await getUsableLogo(input.logoId, req.user!);
}

// --- Designer support ---------------------------------------------------------------

qrRouter.post('/preview', async (req, res) => {
  const body = parseBody(previewSchema, req.body);
  await checkLogo(body, req);
  // URL codes encode a short link; the preview uses one of the same length.
  let data = body.content || 'GenQR';
  let contentError: string | null = null;
  if (body.contentType === 'url') {
    // A saved code previews its real short link; a new one a placeholder of the same length.
    const saved = body.qrId ? await getQr(body.qrId, req.user!) : null;
    data = saved?.contentType === 'url' ? saved.encodedData : await sampleQrData();
    if (body.content) await validateTarget(body.content).catch((err: Error) => (contentError = err.message));
  }
  const svg = renderSvg({ data, style: body.style, logoDataUri: await logoDataUri(body.logoId), sizePx: 512 });
  res.json({ svg, scannable: await scanCheck(svg, data), contentError });
});

qrRouter.get('/presets', async (_req, res) => {
  res.json({ presets: await listPresets() });
});

qrRouter.get('/logos', async (req, res) => {
  res.json({ logos: await listLogos(req.user!) });
});

qrRouter.post('/logos', async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(200), dataUrl: z.string().max(5_000_000), shared: z.boolean().default(false) }), req.body);
  if (body.shared && req.user!.role !== 'admin') throw new HttpError(403, 'Only administrators can add logos to the shared library.', 'FORBIDDEN');
  const logo = await saveLogo(body, req.user!);
  await audit({ actor: actorOf(req.user!), action: 'logo.uploaded', entityType: 'logo', entityId: logo.id, details: { name: logo.name, shared: logo.isShared }, ip: clientIp(req) });
  res.status(201).json({ logo });
});

qrRouter.get('/logos/:id/image', async (req, res) => {
  const logo = await getUsableLogo(idOf(req), req.user!);
  res.type('png').set('Cache-Control', 'private, max-age=86400').send(readLogoFile(logo.fileName));
});

qrRouter.delete('/logos/:id', async (req, res) => {
  const logo = await deleteLogo(idOf(req), req.user!);
  await audit({ actor: actorOf(req.user!), action: 'logo.deleted', entityType: 'logo', entityId: logo.id, details: { name: logo.name, shared: logo.isShared }, ip: clientIp(req) });
  res.json({ ok: true });
});

// --- Saved QR codes -------------------------------------------------------------------

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  all: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).default(0),
});

qrRouter.get('/', async (req, res) => {
  const { q, all, limit, offset } = parseBody(listQuery, req.query);
  res.json(await listQr(req.user!, { search: q || undefined, all: all === '1', limit, offset }));
});

qrRouter.post('/', async (req, res) => {
  const body = parseBody(createSchema, req.body);
  await checkLogo(body, req);
  const id = await createQr(body, req.user!);
  const qr = await getQr(id, req.user!);
  await audit({ actor: actorOf(req.user!), action: 'qr.created', entityType: 'qr', entityId: id, details: { title: qr.title, contentType: qr.contentType, content: qr.content, shortCode: qr.shortLink?.code }, ip: clientIp(req) });
  res.status(201).json({ qr });
});

qrRouter.get('/:id', async (req, res) => {
  res.json({ qr: await getQr(idOf(req), req.user!) });
});

qrRouter.put('/:id', async (req, res) => {
  const before = await getQr(idOf(req), req.user!);
  const body: QrInput = parseBody(qrSchema, req.body);
  await checkLogo(body, req);
  const { symbolChanged } = await updateQr(before, body, actorOf(req.user!));
  const qr = await getQr(before.id, req.user!);
  const details: Record<string, unknown> = { title: qr.title, symbolChanged };
  if (before.content !== qr.content) details.content = { from: before.content, to: qr.content };
  if (JSON.stringify(before.style) !== JSON.stringify(qr.style) || before.logoId !== qr.logoId) details.designChanged = true;
  await audit({ actor: actorOf(req.user!), action: 'qr.updated', entityType: 'qr', entityId: qr.id, details, ip: clientIp(req) });
  res.json({ qr });
});

qrRouter.delete('/:id', async (req, res) => {
  const qr = await getQr(idOf(req), req.user!);
  await softDeleteQr(qr, actorOf(req.user!));
  await audit({ actor: actorOf(req.user!), action: 'qr.deleted', entityType: 'qr', entityId: qr.id, details: { title: qr.title, owner: qr.ownerUsername, shortLinkDisabled: qr.shortLink?.code ?? null }, ip: clientIp(req) });
  res.json({ ok: true });
});

qrRouter.get('/:id/image.svg', async (req, res) => {
  const qr = await getQr(idOf(req), req.user!);
  const { size } = parseBody(z.object({ size: z.coerce.number().int().min(64).max(4096).default(512) }), req.query);
  res.type('image/svg+xml').set('Cache-Control', 'private, no-cache').send((await svgRendererFor(qr))(size));
});

const exportQuery = z.object({
  format: z.enum(['png', 'jpg', 'svg', 'pdf', 'docx']),
  size: z.coerce.number().positive().optional(),
});

const slug = (title: string) =>
  title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'qr-code';

qrRouter.get('/:id/export', async (req, res) => {
  const qr = await getQr(idOf(req), req.user!);
  const { format, size } = parseBody(exportQuery, req.query);
  // Pixels for images, centimetres for documents.
  const printFormat = format === 'pdf' || format === 'docx';
  const resolved = printFormat ? Math.min(50, Math.max(1, size ?? 5)) : Math.round(Math.min(4096, Math.max(128, size ?? 1024)));
  const background = qr.style.transparentBackground ? '#ffffff' : qr.style.background;
  const file = await exportQr(format as ExportFormat, await svgRendererFor(qr), resolved, background);
  res.attachment(`${slug(qr.title)}-${qr.id}.${format}`).type(EXPORT_TYPES[format as ExportFormat]).send(file);
});

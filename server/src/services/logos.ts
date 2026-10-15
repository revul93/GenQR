import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { DATA_DIR, ensureDir } from '../config.js';
import { db, insertReturningId } from '../db/index.js';
import { HttpError } from '../http.js';
import type { User } from './users.js';

export const LOGO_DIR = path.join(DATA_DIR, 'uploads', 'logos');
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 512;

export interface Logo {
  id: number;
  name: string;
  width: number;
  height: number;
  isShared: boolean;
  ownerId: number | null;
  createdAt: number;
}

const mapLogo = (r: Record<string, unknown>): Logo & { fileName: string } => ({
  id: Number(r.id),
  name: String(r.name),
  width: Number(r.width),
  height: Number(r.height),
  isShared: Boolean(r.is_shared),
  ownerId: r.owner_id == null ? null : Number(r.owner_id),
  createdAt: Number(r.created_at),
  fileName: String(r.file_name),
});

const strip = ({ fileName: _f, ...logo }: Logo & { fileName: string }): Logo => logo;

/** Logos a user may use: the shared library plus their own uploads. */
export async function listLogos(user: User): Promise<Logo[]> {
  const rows = await db()('logos')
    .where((q) => q.where({ is_shared: true }).orWhere({ owner_id: user.id }))
    .orderBy([{ column: 'is_shared', order: 'desc' }, { column: 'name' }]);
  return rows.map((r) => strip(mapLogo(r)));
}

async function findLogo(id: number) {
  const row = await db()('logos').where({ id }).first();
  return row ? mapLogo(row) : null;
}

export async function getUsableLogo(id: number, user: User): Promise<Logo & { fileName: string }> {
  const logo = await findLogo(id);
  if (!logo || (!logo.isShared && logo.ownerId !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Logo not found.', 'LOGO_NOT_FOUND');
  return logo;
}

/**
 * Accepts PNG, JPEG, WebP or SVG (as a data URL) and stores a normalised PNG.
 * Rasterising SVG on upload means no user-supplied SVG is ever served back.
 */
export async function saveLogo(input: { name: string; dataUrl: string; shared: boolean }, user: User): Promise<Logo> {
  const match = /^data:image\/(png|jpeg|webp|svg\+xml);base64,(.+)$/s.exec(input.dataUrl);
  if (!match) throw new HttpError(400, 'Upload a PNG, JPEG, WebP or SVG image.', 'BAD_LOGO');
  const raw = Buffer.from(match[2]!, 'base64');
  if (raw.length > MAX_UPLOAD_BYTES) throw new HttpError(400, 'The logo must be smaller than 3 MB.', 'BAD_LOGO');

  let png: Buffer;
  let info: OutputInfo;
  try {
    ({ data: png, info } = await sharp(raw, { density: 300 })
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    throw new HttpError(400, 'That file could not be read as an image.', 'BAD_LOGO');
  }

  ensureDir(LOGO_DIR);
  const fileName = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(LOGO_DIR, fileName), png);
  const id = await insertReturningId(db(), 'logos', {
    name: input.name,
    file_name: fileName,
    width: info.width,
    height: info.height,
    is_shared: input.shared,
    owner_id: input.shared ? null : user.id,
    created_at: Date.now(),
  });
  return strip((await findLogo(id))!);
}

export function readLogoFile(fileName: string): Buffer {
  return fs.readFileSync(path.join(LOGO_DIR, fileName));
}

const dataUriCache = new Map<number, string>();

/** Logo as a data URI for embedding in SVG, so exported files are self-contained. */
export async function logoDataUri(id: number | null): Promise<string | null> {
  if (id == null) return null;
  const cached = dataUriCache.get(id);
  if (cached) return cached;
  const logo = await findLogo(id);
  if (!logo) return null;
  const uri = `data:image/png;base64,${readLogoFile(logo.fileName).toString('base64')}`;
  dataUriCache.set(id, uri);
  return uri;
}

export async function deleteLogo(id: number, user: User): Promise<Logo> {
  const logo = await findLogo(id);
  if (!logo) throw new HttpError(404, 'Logo not found.', 'LOGO_NOT_FOUND');
  const canDelete = user.role === 'admin' || (!logo.isShared && logo.ownerId === user.id);
  if (!canDelete) throw new HttpError(403, 'You cannot delete this logo.', 'FORBIDDEN');

  const inUse = await db()('qr_codes').where({ logo_id: id }).whereNull('deleted_at').count({ n: '*' }).first();
  const presets = await db()('style_presets').where({ logo_id: id }).count({ n: '*' }).first();
  if (Number(inUse?.n ?? 0) || Number(presets?.n ?? 0)) {
    throw new HttpError(409, `This logo is used by ${Number(inUse?.n ?? 0)} QR code(s) and ${Number(presets?.n ?? 0)} preset(s).`, 'LOGO_IN_USE');
  }
  await db().transaction(async (trx) => {
    await trx('qr_codes').where({ logo_id: id }).update({ logo_id: null }); // only deleted codes remain
    await trx('logos').where({ id }).delete();
  });
  fs.rmSync(path.join(LOGO_DIR, logo.fileName), { force: true });
  dataUriCache.delete(id);
  return strip(logo);
}

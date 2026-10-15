import type { Knex } from 'knex';
import { db, insertReturningId } from '../db/index.js';
import { HttpError } from '../http.js';
import { renderSvg } from '../qr/render.js';
import { parseStyle, type QrStyle } from '../qr/style.js';
import { logoDataUri } from './logos.js';
import type { User } from './users.js';

export type ContentType = 'url' | 'text';

export interface QrCode {
  id: number;
  ownerId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  title: string;
  contentType: ContentType;
  content: string;
  encodedData: string;
  style: QrStyle;
  logoId: number | null;
  createdAt: number;
  updatedAt: number;
}

function mapQr(r: Record<string, unknown>): QrCode {
  return {
    id: Number(r.id),
    ownerId: Number(r.owner_id),
    ownerUsername: String(r.owner_username ?? ''),
    ownerDisplayName: String(r.owner_display_name ?? ''),
    title: String(r.title),
    contentType: r.content_type as ContentType,
    content: String(r.content),
    encodedData: String(r.encoded_data),
    style: parseStyle(String(r.style)),
    logoId: r.logo_id == null ? null : Number(r.logo_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** What the QR symbol encodes for the given content. URLs will point at short links in Phase 4. */
export function encodeContent(contentType: ContentType, content: string): string {
  if (contentType === 'url') {
    let url: URL;
    try {
      url = new URL(content);
    } catch {
      throw new HttpError(400, 'Enter a full URL, e.g. https://www.example.com/page', 'BAD_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http:// and https:// links are allowed.', 'BAD_URL');
    return url.toString();
  }
  return content;
}

const baseQuery = (trx: Knex | Knex.Transaction = db()) =>
  trx('qr_codes as q')
    .join('users as u', 'u.id', 'q.owner_id')
    .whereNull('q.deleted_at')
    .select('q.*', 'u.username as owner_username', 'u.display_name as owner_display_name');

export async function getQr(id: number, user: User): Promise<QrCode> {
  const row = await baseQuery().where('q.id', id).first();
  if (!row || (user.role !== 'admin' && Number(row.owner_id) !== user.id)) throw new HttpError(404, 'QR code not found.', 'NOT_FOUND');
  return mapQr(row);
}

export async function listQr(
  user: User,
  opts: { search?: string; all?: boolean; limit: number; offset: number },
): Promise<{ items: QrCode[]; total: number }> {
  const q = baseQuery();
  if (!(opts.all && user.role === 'admin')) q.where('q.owner_id', user.id);
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    q.where((w) => w.whereRaw('LOWER(q.title) LIKE ?', [term]).orWhereRaw('LOWER(q.content) LIKE ?', [term]).orWhereRaw('LOWER(u.username) LIKE ?', [term]));
  }
  const totalRow = await q.clone().clearSelect().count({ n: '*' }).first();
  const rows = await q.orderBy('q.created_at', 'desc').limit(opts.limit).offset(opts.offset);
  return { items: rows.map(mapQr), total: Number(totalRow?.n ?? 0) };
}

export interface QrInput {
  title: string;
  contentType: ContentType;
  content: string;
  style: QrStyle;
  logoId: number | null;
}

export async function createQr(input: QrInput, owner: User): Promise<number> {
  const now = Date.now();
  return insertReturningId(db(), 'qr_codes', {
    owner_id: owner.id,
    title: input.title,
    content_type: input.contentType,
    content: input.content,
    encoded_data: encodeContent(input.contentType, input.content),
    style: JSON.stringify(input.style),
    logo_id: input.logoId,
    created_at: now,
    updated_at: now,
  });
}

export async function updateQr(id: number, input: QrInput): Promise<void> {
  await db()('qr_codes')
    .where({ id })
    .update({
      title: input.title,
      content_type: input.contentType,
      content: input.content,
      encoded_data: encodeContent(input.contentType, input.content),
      style: JSON.stringify(input.style),
      logo_id: input.logoId,
      updated_at: Date.now(),
    });
}

export async function softDeleteQr(id: number): Promise<void> {
  await db()('qr_codes').where({ id }).update({ deleted_at: Date.now() });
}

/** Renderer bound to a saved code, for exports at any size. */
export async function svgRendererFor(qr: Pick<QrCode, 'encodedData' | 'style' | 'logoId'>): Promise<(sizePx: number) => string> {
  const logo = await logoDataUri(qr.logoId);
  return (sizePx) => renderSvg({ data: qr.encodedData, style: qr.style, logoDataUri: logo, sizePx });
}

/** Moves every QR code (including deleted ones) and private logo of a user to another user. */
export async function reassignOwnership(fromUserId: number, toUserId: number, trx: Knex | Knex.Transaction): Promise<{ qrCodes: number; logos: number }> {
  const qrCodes = await trx('qr_codes').where({ owner_id: fromUserId }).update({ owner_id: toUserId });
  const logos = await trx('logos').where({ owner_id: fromUserId }).update({ owner_id: toUserId });
  return { qrCodes: Number(qrCodes), logos: Number(logos) };
}

export async function countOwned(userId: number): Promise<number> {
  const row = await db()('qr_codes').where({ owner_id: userId }).count({ n: '*' }).first();
  const logos = await db()('logos').where({ owner_id: userId }).count({ n: '*' }).first();
  return Number(row?.n ?? 0) + Number(logos?.n ?? 0);
}

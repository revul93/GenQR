import type { Knex } from 'knex';
import { db, insertReturningId } from '../db/index.js';
import { HttpError } from '../http.js';
import { renderSvg } from '../qr/render.js';
import { parseStyle, type QrStyle } from '../qr/style.js';
import type { Actor } from './audit.js';
import { logoDataUri } from './logos.js';
import { createShortLink, publicBaseUrl, qrDataFor, shortUrlFor, updateLink, validateTarget } from './shortLinks.js';
import type { User } from './users.js';

export type ContentType = 'url' | 'text';

export interface QrShortLink {
  id: number;
  code: string;
  url: string;
  isActive: boolean;
  expiresAt: number | null;
}

export interface QrCode {
  id: number;
  ownerId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  title: string;
  contentType: ContentType;
  /** For URL codes: the current redirect target. For text codes: the encoded text. */
  content: string;
  encodedData: string;
  style: QrStyle;
  logoId: number | null;
  shortLink: QrShortLink | null;
  createdAt: number;
  updatedAt: number;
}

function mapQr(r: Record<string, unknown>, base: string): QrCode {
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
    shortLink:
      r.link_id == null
        ? null
        : {
            id: Number(r.link_id),
            code: String(r.link_code),
            url: shortUrlFor(base, String(r.link_code)),
            isActive: Boolean(r.link_active),
            expiresAt: r.link_expires_at == null ? null : Number(r.link_expires_at),
          },
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const baseQuery = (trx: Knex | Knex.Transaction = db()) =>
  trx('qr_codes as q')
    .join('users as u', 'u.id', 'q.owner_id')
    .leftJoin('short_links as l', 'l.qr_code_id', 'q.id')
    .whereNull('q.deleted_at')
    .select(
      'q.*',
      'u.username as owner_username',
      'u.display_name as owner_display_name',
      'l.id as link_id',
      'l.code as link_code',
      'l.is_active as link_active',
      'l.expires_at as link_expires_at',
    );

export async function getQr(id: number, user: User): Promise<QrCode> {
  const row = await baseQuery().where('q.id', id).first();
  if (!row || (user.role !== 'admin' && Number(row.owner_id) !== user.id)) throw new HttpError(404, 'QR code not found.', 'NOT_FOUND');
  return mapQr(row, await publicBaseUrl());
}

export async function listQr(
  user: User,
  opts: { search?: string; all?: boolean; limit: number; offset: number },
): Promise<{ items: QrCode[]; total: number }> {
  const q = baseQuery();
  if (!(opts.all && user.role === 'admin')) q.where('q.owner_id', user.id);
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    q.where((w) =>
      w.whereRaw('LOWER(q.title) LIKE ?', [term]).orWhereRaw('LOWER(q.content) LIKE ?', [term]).orWhereRaw('LOWER(u.username) LIKE ?', [term]).orWhereRaw('LOWER(l.code) LIKE ?', [term]),
    );
  }
  const totalRow = await q.clone().clearSelect().count({ n: '*' }).first();
  const rows = await q.orderBy('q.created_at', 'desc').limit(opts.limit).offset(opts.offset);
  const base = await publicBaseUrl();
  return { items: rows.map((r) => mapQr(r, base)), total: Number(totalRow?.n ?? 0) };
}

export interface QrInput {
  title: string;
  contentType: ContentType;
  content: string;
  style: QrStyle;
  logoId: number | null;
}

/**
 * URL codes get a short link and encode that, so the destination can change after printing.
 * Text codes encode the text itself.
 */
export async function createQr(input: QrInput & { alias?: string | null }, owner: User): Promise<number> {
  const now = Date.now();
  const row = { owner_id: owner.id, title: input.title, content_type: input.contentType, style: JSON.stringify(input.style), logo_id: input.logoId, created_at: now, updated_at: now };
  if (input.contentType === 'text') {
    return insertReturningId(db(), 'qr_codes', { ...row, content: input.content, encoded_data: input.content });
  }
  const target = await validateTarget(input.content);
  const base = await publicBaseUrl();
  return db().transaction(async (trx) => {
    const id = await insertReturningId(trx, 'qr_codes', { ...row, content: target, encoded_data: '' });
    const link = await createShortLink(trx, { targetUrl: target, ownerId: owner.id, qrCodeId: id, alias: input.alias });
    await trx('qr_codes').where({ id }).update({ encoded_data: qrDataFor(base, link.code) });
    return id;
  });
}

/** Returns true when the symbol itself changed (text codes); URL target changes keep the same symbol. */
export async function updateQr(existing: QrCode, input: QrInput, actor: Actor): Promise<{ symbolChanged: boolean }> {
  if (input.contentType !== existing.contentType) {
    throw new HttpError(400, 'The type of a saved QR code cannot change. Create a new QR code instead.', 'TYPE_CHANGE');
  }
  const row = { title: input.title, style: JSON.stringify(input.style), logo_id: input.logoId, updated_at: Date.now() };
  if (input.contentType === 'text') {
    await db()('qr_codes').where({ id: existing.id }).update({ ...row, content: input.content, encoded_data: input.content });
    return { symbolChanged: input.content !== existing.content };
  }
  const target = await validateTarget(input.content);
  await db().transaction(async (trx) => {
    await trx('qr_codes').where({ id: existing.id }).update({ ...row, content: target });
    if (existing.shortLink) await updateLink(trx, existing.shortLink.id, { targetUrl: target }, actor);
  });
  return { symbolChanged: false };
}

/** Removes the code from lists and switches its short link off, so printed copies stop redirecting. */
export async function softDeleteQr(qr: QrCode, actor: Actor): Promise<void> {
  await db().transaction(async (trx) => {
    await trx('qr_codes').where({ id: qr.id }).update({ deleted_at: Date.now() });
    if (qr.shortLink) await updateLink(trx, qr.shortLink.id, { isActive: false }, actor);
  });
}

/** Keeps a URL code's stored content in step when its link target is edited from the links page. */
export async function syncQrContent(trx: Knex | Knex.Transaction, qrCodeId: number, target: string): Promise<void> {
  await trx('qr_codes').where({ id: qrCodeId }).update({ content: target, updated_at: Date.now() });
}

/** Renderer bound to a saved code, for exports at any size. */
export async function svgRendererFor(qr: Pick<QrCode, 'encodedData' | 'style' | 'logoId'>): Promise<(sizePx: number) => string> {
  const logo = await logoDataUri(qr.logoId);
  return (sizePx) => renderSvg({ data: qr.encodedData, style: qr.style, logoDataUri: logo, sizePx });
}

/** Moves every QR code (including deleted ones), short link and private logo of a user to another user. */
export async function reassignOwnership(fromUserId: number, toUserId: number, trx: Knex | Knex.Transaction): Promise<{ qrCodes: number; logos: number }> {
  const qrCodes = await trx('qr_codes').where({ owner_id: fromUserId }).update({ owner_id: toUserId });
  await trx('short_links').where({ owner_id: fromUserId }).update({ owner_id: toUserId });
  const logos = await trx('logos').where({ owner_id: fromUserId }).update({ owner_id: toUserId });
  return { qrCodes: Number(qrCodes), logos: Number(logos) };
}

export async function countOwned(userId: number): Promise<number> {
  const counts = await Promise.all(
    ['qr_codes', 'logos', 'short_links'].map((table) => db()(table).where({ owner_id: userId }).count({ n: '*' }).first()),
  );
  return counts.reduce((sum, row) => sum + Number(row?.n ?? 0), 0);
}

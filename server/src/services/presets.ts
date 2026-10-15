import { db, insertReturningId } from '../db/index.js';
import { HttpError } from '../http.js';
import { parseStyle, type QrStyle } from '../qr/style.js';

export interface Preset {
  id: number;
  name: string;
  style: QrStyle;
  logoId: number | null;
  isDefault: boolean;
}

const mapPreset = (r: Record<string, unknown>): Preset => ({
  id: Number(r.id),
  name: String(r.name),
  style: parseStyle(String(r.style)),
  logoId: r.logo_id == null ? null : Number(r.logo_id),
  isDefault: Boolean(r.is_default),
});

export async function listPresets(): Promise<Preset[]> {
  const rows = await db()('style_presets').orderBy([{ column: 'is_default', order: 'desc' }, { column: 'name' }]);
  return rows.map(mapPreset);
}

export async function getPreset(id: number): Promise<Preset> {
  const row = await db()('style_presets').where({ id }).first();
  if (!row) throw new HttpError(404, 'Preset not found.', 'NOT_FOUND');
  return mapPreset(row);
}

export interface PresetInput {
  name: string;
  style: QrStyle;
  logoId: number | null;
  isDefault: boolean;
}

async function assertUniqueName(name: string, exceptId?: number) {
  const q = db()('style_presets').whereRaw('LOWER(name) = ?', [name.toLowerCase()]);
  if (exceptId) q.whereNot({ id: exceptId });
  if (await q.first()) throw new HttpError(409, `A preset named "${name}" already exists.`, 'NAME_TAKEN');
}

export async function savePreset(input: PresetInput, userId: number, id?: number): Promise<Preset> {
  await assertUniqueName(input.name, id);
  const now = Date.now();
  const row = { name: input.name, style: JSON.stringify(input.style), logo_id: input.logoId, is_default: input.isDefault, updated_at: now };
  const presetId = await db().transaction(async (trx) => {
    // Only one default preset.
    if (input.isDefault) await trx('style_presets').update({ is_default: false });
    if (id) {
      const n = await trx('style_presets').where({ id }).update(row);
      if (!n) throw new HttpError(404, 'Preset not found.', 'NOT_FOUND');
      return id;
    }
    return insertReturningId(trx, 'style_presets', { ...row, created_by: userId, created_at: now });
  });
  return getPreset(presetId);
}

export async function deletePreset(id: number): Promise<Preset> {
  const preset = await getPreset(id);
  await db()('style_presets').where({ id }).delete();
  return preset;
}

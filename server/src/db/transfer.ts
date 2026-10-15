import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import type { Knex } from 'knex';
import { readAppVersion } from '../config.js';
import type { DbClient } from './index.js';

/**
 * Engine-independent data copy, used to switch databases and for JSON dumps (backup/restore).
 * Rows are copied with their ids so every reference stays valid.
 */

/** Application tables in foreign-key order (parents first). Knex's own migration tables are excluded. */
export const APP_TABLES = [
  'users',
  'settings',
  'sessions',
  'password_resets',
  'audit_log',
  'logos',
  'style_presets',
  'qr_codes',
  'short_links',
  'short_link_history',
  'clicks',
  'clicks_daily',
  'email_log',
] as const;

/** Tables with an auto-increment `id`; explicit ids need special handling on PostgreSQL and SQL Server. */
const IDENTITY_TABLES = new Set(['users', 'audit_log', 'logos', 'style_presets', 'qr_codes', 'short_links', 'short_link_history', 'clicks', 'email_log']);

const ORDER_BY: Record<string, string[]> = {
  settings: ['key'],
  sessions: ['id'],
  password_resets: ['token_hash'],
  clicks_daily: ['short_link_id', 'day'],
};

export type Progress = (message: string) => void;
type Row = Record<string, unknown>;

/** Reads a table in pages, in primary-key order. */
async function* readTable(source: Knex, table: string, pageSize = 1000): AsyncGenerator<Row[]> {
  const order = ORDER_BY[table] ?? ['id'];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await source(table).select('*').orderBy(order.map((column) => ({ column }))).limit(pageSize).offset(offset);
    if (!rows.length) return;
    yield rows;
    if (rows.length < pageSize) return;
  }
}

interface ColumnTypes {
  columns: Set<string>;
  booleans: Set<string>;
}

async function columnTypes(target: Knex, table: string): Promise<ColumnTypes> {
  const info = await target(table).columnInfo();
  const columns = new Set(Object.keys(info));
  const booleans = new Set(
    Object.entries(info)
      .filter(([, c]) => /^(boolean|bool|bit)$/i.test(String(c.type)) || (/^tinyint$/i.test(String(c.type)) && String(c.maxLength ?? '') === '1'))
      .map(([name]) => name),
  );
  return { columns, booleans };
}

/** Adapts a row read from one engine for insertion into another. */
function normalise(row: Row, types: ColumnTypes): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (!types.columns.has(k)) continue; // column no longer exists in the target schema
    if (types.booleans.has(k) && v !== null && v !== undefined) out[k] = v === true || v === 1 || v === '1' || v === 't' || v === 'true';
    else if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Date) out[k] = v.getTime();
    else out[k] = v;
  }
  return out;
}

// SQL Server allows at most 2100 parameters per statement.
const batchSize = (client: DbClient, columns: number) => (client === 'mssql' ? Math.max(1, Math.floor(2000 / Math.max(1, columns))) : 500);

async function insertRows(trx: Knex.Transaction, client: DbClient, table: string, rows: Row[], types: ColumnTypes): Promise<void> {
  if (!rows.length) return;
  const normalised = rows.map((r) => normalise(r, types));
  const size = batchSize(client, types.columns.size);
  for (let i = 0; i < normalised.length; i += size) await trx(table).insert(normalised.slice(i, i + size));
}

/** Copies one table's rows (from any async source of row pages) into the target. */
async function copyTable(target: Knex, client: DbClient, table: string, pages: AsyncIterable<Row[]>): Promise<number> {
  const types = await columnTypes(target, table);
  let count = 0;
  await target.transaction(async (trx) => {
    const identity = client === 'mssql' && IDENTITY_TABLES.has(table);
    if (identity) await trx.raw('SET IDENTITY_INSERT ?? ON', [table]);
    for await (const rows of pages) {
      await insertRows(trx, client, table, rows, types);
      count += rows.length;
    }
    if (identity) await trx.raw('SET IDENTITY_INSERT ?? OFF', [table]);
  });
  // PostgreSQL sequences don't move when ids are inserted explicitly.
  if (client === 'pg' && IDENTITY_TABLES.has(table)) {
    await target.raw(`SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ??`, [table, table]);
  }
  return count;
}

export async function tableCounts(conn: Knex): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of APP_TABLES) {
    const row = await conn(t).count({ n: '*' }).first();
    counts[t] = Number(row?.n ?? 0);
  }
  return counts;
}

export async function assertEmpty(conn: Knex): Promise<void> {
  const counts = await tableCounts(conn);
  const used = Object.entries(counts).filter(([, n]) => n > 0);
  if (used.length) throw new Error(`The target database already contains GenQR data (${used.map(([t, n]) => `${t}: ${n}`).join(', ')}). Use an empty database.`);
}

/** Copies every application table from source to target and verifies the row counts. */
export async function copyDatabase(source: Knex, target: Knex, targetClient: DbClient, progress: Progress): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of APP_TABLES) {
    const n = await copyTable(target, targetClient, table, readTable(source, table));
    counts[table] = n;
    progress(`Copied ${table}: ${n} row${n === 1 ? '' : 's'}`);
  }
  const [before, after] = [await tableCounts(source), await tableCounts(target)];
  const mismatched = APP_TABLES.filter((t) => after[t]! < before[t]!);
  if (mismatched.length) throw new Error(`Row counts differ after copying: ${mismatched.map((t) => `${t} ${before[t]} → ${after[t]}`).join(', ')}`);
  progress('Row counts verified.');
  return counts;
}

// --- JSON dumps -------------------------------------------------------------------------

interface DumpHeader {
  genqrDump: 1;
  appVersion: string;
  migrations: string[];
  createdAt: string;
}

/** Writes a gzipped JSON-lines dump of every application table. Works on every engine. */
export async function writeDump(source: Knex, file: string, progress: Progress = () => {}): Promise<void> {
  const migrations = (await source('knex_migrations').select('name').orderBy('id')).map((r) => String(r.name));
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(file, { mode: 0o600 });
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
  gzip.pipe(out);
  const write = (obj: unknown) => (gzip.write(JSON.stringify(obj) + '\n') ? Promise.resolve() : new Promise<void>((r) => gzip.once('drain', () => r())));
  await write({ genqrDump: 1, appVersion: readAppVersion(), migrations, createdAt: new Date().toISOString() } satisfies DumpHeader);
  for (const table of APP_TABLES) {
    let n = 0;
    for await (const rows of readTable(source, table)) {
      for (const r of rows) await write({ t: table, r: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) });
      n += rows.length;
    }
    progress(`${table}: ${n}`);
  }
  gzip.end();
  await done;
}

async function* dumpLines(file: string): AsyncGenerator<{ t?: string; r?: Row } & Partial<DumpHeader>> {
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line);
}

/**
 * Replaces all application data in `target` with the contents of a dump. The target schema
 * must already be migrated. Everything happens table by table; run it with the service stopped.
 */
export async function restoreDump(target: Knex, targetClient: DbClient, file: string, progress: Progress = () => {}): Promise<void> {
  const it = dumpLines(file)[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done || first.value.genqrDump !== 1) throw new Error('Not a GenQR dump file.');
  const header = first.value as DumpHeader;
  progress(`Dump from GenQR ${header.appVersion}, ${header.createdAt}`);

  // Group rows per table (dumps are written table by table, in foreign-key order).
  const byTable = new Map<string, Row[]>();
  for (let next = await it.next(); !next.done; next = await it.next()) {
    const { t, r } = next.value;
    if (!t || !r) continue;
    let list = byTable.get(t);
    if (!list) byTable.set(t, (list = []));
    list.push(r);
  }

  for (const table of [...APP_TABLES].reverse()) await target(table).delete();
  for (const table of APP_TABLES) {
    const rows = byTable.get(table) ?? [];
    async function* pages() {
      for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000);
    }
    const n = await copyTable(target, targetClient, table, pages());
    progress(`Restored ${table}: ${n}`);
  }
}

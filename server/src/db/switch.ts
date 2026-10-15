import fs from 'node:fs';
import path from 'node:path';
import type { Knex } from 'knex';
import { z } from 'zod';
import { CONFIG_DIR, DATA_DIR, ensureDir } from '../config.js';
import { encryptSecret } from '../services/crypto.js';
import { installDriver } from './drivers.js';
import { createKnex, db, dbClient, DB_CONFIG_FILE, loadDbConfig, migrateLatest, writeDbConfig, type DbClient, type DbConfig } from './index.js';
import { assertEmpty, copyDatabase, dropAppTables } from './transfer.js';

/**
 * Moving GenQR to another database: install driver → test → migrate the (empty) target →
 * copy all data → write the new config → restart. If the new database fails at the next
 * startup, the previous configuration is restored automatically.
 */

export const switchTargetSchema = z.discriminatedUnion('client', [
  z.object({ client: z.literal('sqlite'), filename: z.string().trim().min(1).max(500).regex(/\.db$/i, 'Use a file name ending in .db') }),
  z.object({
    // SQL Server support is implemented (Knex 'mssql' dialect, tedious driver) but not yet
    // verified against a real server, so it is not offered yet.
    client: z.enum(['mysql', 'pg']),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    database: z.string().trim().min(1).max(128),
    user: z.string().trim().min(1).max(128),
    password: z.string().max(1024).default(''),
    ssl: z.boolean().default(false),
    verifyCertificate: z.boolean().default(true),
  }),
]);
export type SwitchTarget = z.infer<typeof switchTargetSchema>;

const PREVIOUS_CONFIG_FILE = path.join(CONFIG_DIR, 'database.previous.json');
const PENDING_MARKER = path.join(DATA_DIR, 'db-switch-pending.json');
const STATUS_FILE = path.join(DATA_DIR, 'db-switch-status.json');

export interface SwitchStatus {
  state: 'idle' | 'running' | 'failed' | 'restart-required' | 'restarting' | 'done' | 'reverted';
  from?: DbClient;
  to?: DbClient;
  step?: string;
  log: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  requestedBy?: string;
}

let status: SwitchStatus = readStatusFile();

function readStatusFile(): SwitchStatus {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return { state: 'idle', log: [] };
  }
}

function saveStatus(patch: Partial<SwitchStatus>): void {
  status = { ...status, ...patch };
  ensureDir(DATA_DIR);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function log(line: string): void {
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  status.log = [...status.log, entry].slice(-300);
  saveStatus({});
  console.log(`db-switch: ${line}`);
}

export const switchStatus = () => status;
export const isSwitchRunning = () => status.state === 'running';

/** The config that will be written for a target. The password is encrypted. */
export function configFor(target: SwitchTarget): DbConfig {
  if (target.client === 'sqlite') return { client: 'sqlite', connection: { filename: target.filename } };
  const { client, password, ...connection } = target;
  return { client, connection, passwordEnc: password ? encryptSecret(password) : null };
}

function passwordOf(target: SwitchTarget): string | undefined {
  return target.client === 'sqlite' ? undefined : target.password;
}

function sameDatabase(a: DbConfig, b: DbConfig): boolean {
  if (a.client !== b.client) return false;
  if (a.client === 'sqlite') return path.resolve(String(a.connection.filename)) === path.resolve(String(b.connection.filename));
  const [x, y] = [a.connection, b.connection];
  return x.host === y.host && Number(x.port) === Number(y.port) && x.database === y.database;
}

/** Installs the driver, connects and reports the server version and whether the target is usable. */
export async function testTarget(target: SwitchTarget, onLog: (l: string) => void = () => {}): Promise<{ version: string; empty: boolean; problem?: string }> {
  await installDriver(target.client, onLog);
  const conn = createKnex(configFor(target), passwordOf(target));
  try {
    const version = await serverVersion(conn, target.client);
    let empty = true;
    let problem: string | undefined;
    try {
      if (await conn.schema.hasTable('users')) await assertEmpty(conn);
    } catch (err) {
      empty = false;
      problem = (err as Error).message;
    }
    return { version, empty, problem };
  } finally {
    await conn.destroy();
  }
}

async function serverVersion(conn: Knex, client: DbClient): Promise<string> {
  const sql = { sqlite: 'select sqlite_version() as v', mysql: 'select version() as v', pg: 'select version() as v', mssql: 'select @@version as v' }[client];
  const res = await conn.raw(sql);
  // Result shapes differ per driver.
  const row = client === 'pg' ? res.rows[0] : client === 'mysql' ? res[0][0] : res[0];
  return String(row?.v ?? '').split('\n')[0]!.slice(0, 200);
}

/**
 * Runs the whole switch. `source` is the live database; `onDone` decides how the restart
 * happens (the web app exits under systemd, the CLI tells the operator).
 */
/** Checks that can fail immediately, before the background job starts. */
export function assertSwitchable(target: SwitchTarget): void {
  if (isSwitchRunning()) throw new Error('A database switch is already running.');
  if (sameDatabase(loadDbConfig(), configFor(target))) throw new Error('That is the database GenQR is already using.');
}

export async function runSwitch(target: SwitchTarget, requestedBy: string, source: Knex = db()): Promise<'restart'> {
  assertSwitchable(target);
  const current = loadDbConfig();
  const next = configFor(target);

  saveStatus({ state: 'running', from: dbClient(), to: target.client, log: [], error: undefined, startedAt: new Date().toISOString(), finishedAt: undefined, requestedBy, step: 'driver' });
  let conn: Knex | undefined;
  // Set once we start writing to the target; it was verified empty, so on failure we can clear it.
  let touchedTarget = false;
  try {
    log(`Switching from ${current.client} to ${target.client} (requested by ${requestedBy})`);
    await installDriver(target.client, log);

    saveStatus({ step: 'connect' });
    conn = createKnex(next, passwordOf(target));
    log(`Connected: ${await serverVersion(conn, target.client)}`);
    if (await conn.schema.hasTable('users')) await assertEmpty(conn);

    saveStatus({ step: 'migrate' });
    touchedTarget = true;
    const applied = await migrateLatest(conn);
    log(`Created the schema (${applied.length} migrations).`);
    await assertEmpty(conn);

    saveStatus({ step: 'copy' });
    await copyDatabase(source, conn, target.client, log);

    saveStatus({ step: 'config' });
    writeDbConfig(current, PREVIOUS_CONFIG_FILE);
    fs.writeFileSync(PENDING_MARKER, JSON.stringify({ from: current.client, to: target.client, at: new Date().toISOString() }));
    writeDbConfig(next);
    log(`Saved the new configuration. The previous one is in ${path.basename(PREVIOUS_CONFIG_FILE)}.`);
    saveStatus({ step: 'restart', state: 'restart-required' });
    return 'restart';
  } catch (err) {
    log(`FAILED: ${(err as Error).message}`);
    if (conn && touchedTarget) {
      await dropAppTables(conn)
        .then(() => log('Removed the partly created tables from the target database; it is empty again.'))
        .catch((e: Error) => log(`Could not clean up the target database: ${e.message}`));
    }
    saveStatus({ state: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() });
    throw err;
  } finally {
    await conn?.destroy();
  }
}

/** Called before restarting so the UI can show progress across the restart. */
export function markRestarting(): void {
  log('Restarting GenQR on the new database…');
  saveStatus({ state: 'restarting' });
}

/**
 * Startup hook. When the previous run wrote a new configuration, confirm it works; if the
 * new database cannot be opened, put the previous configuration back.
 * Returns true when the previous configuration was restored (the caller re-initialises).
 */
export function pendingSwitch(): boolean {
  return fs.existsSync(PENDING_MARKER);
}

export function confirmSwitch(): void {
  if (!pendingSwitch()) return;
  fs.rmSync(PENDING_MARKER, { force: true });
  log(`GenQR started on ${dbClient()}. Switch complete.`);
  saveStatus({ state: 'done', finishedAt: new Date().toISOString(), step: undefined });
}

export function revertSwitch(error: Error): void {
  const previous = JSON.parse(fs.readFileSync(PREVIOUS_CONFIG_FILE, 'utf8')) as DbConfig;
  const failed = loadDbConfig();
  writeDbConfig(failed, DB_CONFIG_FILE + '.failed');
  writeDbConfig(previous);
  fs.rmSync(PENDING_MARKER, { force: true });
  log(`Could not start on the new database (${error.message}). Restored the previous configuration (${previous.client}).`);
  saveStatus({ state: 'reverted', error: error.message, finishedAt: new Date().toISOString() });
}

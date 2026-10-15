import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import knex, { type Knex } from 'knex';
import { CONFIG_DIR, DATA_DIR, DRIVERS_DIR, ROOT_DIR, ensureDir } from '../config.js';
import { decryptSecret } from '../services/crypto.js';
import { migrationSource } from './migrations/index.js';

/**
 * Database access goes through Knex only, so the same code and migrations run on
 * SQLite, MySQL/MariaDB, PostgreSQL and SQL Server.
 *
 * Portability conventions used across the schema:
 *  - timestamps are stored as epoch milliseconds (bigInteger) and read back with Number()
 *  - booleans are read back with Boolean() (SQLite/MySQL return 0/1)
 *  - JSON is stored as text
 */

export type DbClient = 'sqlite' | 'mysql' | 'pg' | 'mssql';
export const DB_CLIENTS: DbClient[] = ['sqlite', 'mysql', 'pg', 'mssql'];

/** Server connection settings as stored in config/database.json (password kept separately, encrypted). */
export interface ServerConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  /** Verify the server certificate when ssl is on. */
  verifyCertificate: boolean;
}

export interface DbConfig {
  client: DbClient;
  /** sqlite: { filename }; other engines: ServerConnection */
  connection: Record<string, unknown>;
  passwordEnc?: string | null;
}

const KNEX_CLIENTS: Record<DbClient, string> = {
  sqlite: 'better-sqlite3',
  mysql: 'mysql2',
  pg: 'pg',
  mssql: 'mssql',
};

export const DB_CONFIG_FILE = path.join(CONFIG_DIR, 'database.json');

const DEFAULT_CONFIG: DbConfig = { client: 'sqlite', connection: { filename: 'data/genqr.db' } };

export function loadDbConfig(): DbConfig {
  if (!fs.existsSync(DB_CONFIG_FILE)) return DEFAULT_CONFIG;
  const cfg = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')) as DbConfig;
  if (!DB_CLIENTS.includes(cfg.client)) throw new Error(`Unsupported database client "${cfg.client}" in ${DB_CONFIG_FILE}`);
  return cfg;
}

/** Writes config/database.json atomically (readable by the service account only). */
export function writeDbConfig(cfg: DbConfig, file = DB_CONFIG_FILE): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

/** The configuration without secrets, for display. */
export function describeDbConfig(cfg: DbConfig): { client: DbClient; connection: Record<string, unknown> } {
  return { client: cfg.client, connection: cfg.connection };
}

// Drivers other than SQLite are installed on demand into drivers/ (outside the tracked
// package.json) so `git pull` never conflicts. Knex loads drivers with CommonJS require,
// which honours NODE_PATH.
function registerDriversPath(): void {
  const driversModules = path.join(DRIVERS_DIR, 'node_modules');
  const parts = (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(driversModules)) {
    process.env.NODE_PATH = [driversModules, ...parts].join(path.delimiter);
    (Module as unknown as { _initPaths(): void })._initPaths();
  }
}

function serverConnection(client: Exclude<DbClient, 'sqlite'>, c: ServerConnection, password: string): Record<string, unknown> {
  const tls = c.ssl ? { rejectUnauthorized: c.verifyCertificate } : undefined;
  switch (client) {
    case 'mysql':
      return { host: c.host, port: c.port, user: c.user, password, database: c.database, ssl: tls, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true };
    case 'pg':
      return { host: c.host, port: c.port, user: c.user, password, database: c.database, ssl: tls ?? false };
    case 'mssql':
      return { server: c.host, port: c.port, user: c.user, password, database: c.database, options: { encrypt: c.ssl, trustServerCertificate: c.ssl && !c.verifyCertificate } };
  }
}

export function buildKnexConfig(cfg: DbConfig, passwordOverride?: string): Knex.Config {
  if (cfg.client === 'sqlite') {
    const filename = path.resolve(ROOT_DIR, String(cfg.connection.filename ?? 'data/genqr.db'));
    ensureDir(path.dirname(filename));
    return {
      client: KNEX_CLIENTS.sqlite,
      connection: { filename },
      useNullAsDefault: true,
      pool: {
        min: 1,
        max: 1,
        afterCreate: (conn: { pragma(sql: string): unknown }, done: (err: Error | null, conn: unknown) => void) => {
          conn.pragma('journal_mode = WAL');
          conn.pragma('foreign_keys = ON');
          conn.pragma('busy_timeout = 5000');
          done(null, conn);
        },
      },
    };
  }
  const password = passwordOverride ?? (cfg.passwordEnc ? decryptSecret(cfg.passwordEnc) : '');
  return {
    client: KNEX_CLIENTS[cfg.client],
    connection: serverConnection(cfg.client, cfg.connection as unknown as ServerConnection, password),
    pool: { min: 0, max: 10 },
    acquireConnectionTimeout: 20000,
  };
}

/** A separate Knex instance, e.g. for the target of a database switch. */
export function createKnex(cfg: DbConfig, passwordOverride?: string): Knex {
  registerDriversPath();
  return knex(buildKnexConfig(cfg, passwordOverride));
}

let instance: Knex | undefined;
let activeClient: DbClient | undefined;

export function initDb(cfg: DbConfig = loadDbConfig()): Knex {
  ensureDir(DATA_DIR);
  instance = createKnex(cfg);
  activeClient = cfg.client;
  return instance;
}

export function db(): Knex {
  if (!instance) throw new Error('Database not initialised');
  return instance;
}

export function dbClient(): DbClient {
  return activeClient ?? 'sqlite';
}

export async function migrateLatest(conn: Knex = db()): Promise<string[]> {
  const [, applied] = (await conn.migrate.latest({ migrationSource })) as [number, string[]];
  return applied;
}

/** Undoes the most recent batch of migrations (used when an update is rolled back). */
export async function migrateRollback(conn: Knex = db()): Promise<string[]> {
  const [, undone] = (await conn.migrate.rollback({ migrationSource })) as [number, string[]];
  return undone;
}

export async function closeDb(): Promise<void> {
  await instance?.destroy();
  instance = undefined;
}

/** Inserts a row and returns its generated id on every supported engine. */
export async function insertReturningId(trx: Knex | Knex.Transaction, table: string, row: Record<string, unknown>): Promise<number> {
  const result = await trx(table).insert(row, ['id']);
  const first = result[0] as unknown;
  return Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first);
}

export async function countRows(trx: Knex | Knex.Transaction, table: string): Promise<number> {
  const row = await trx(table).count({ n: '*' }).first();
  return Number(row?.n ?? 0);
}

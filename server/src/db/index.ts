import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import knex, { type Knex } from 'knex';
import { CONFIG_DIR, DATA_DIR, DRIVERS_DIR, ROOT_DIR, ensureDir } from '../config.js';
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

export interface DbConfig {
  client: DbClient;
  connection: Record<string, unknown>;
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
  if (!(cfg.client in KNEX_CLIENTS)) throw new Error(`Unsupported database client "${cfg.client}" in ${DB_CONFIG_FILE}`);
  return cfg;
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

function buildKnexConfig(cfg: DbConfig): Knex.Config {
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
  return { client: KNEX_CLIENTS[cfg.client], connection: cfg.connection, pool: { min: 0, max: 10 } };
}

let instance: Knex | undefined;
let activeClient: DbClient | undefined;

export function initDb(cfg: DbConfig = loadDbConfig()): Knex {
  registerDriversPath();
  ensureDir(DATA_DIR);
  instance = knex(buildKnexConfig(cfg));
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

export async function migrateLatest(): Promise<string[]> {
  const [, applied] = (await db().migrate.latest({ migrationSource })) as [number, string[]];
  return applied;
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

import type { Knex } from 'knex';
import * as m001 from './001_initial.js';
import * as m002 from './002_qr_codes.js';
import * as m003 from './003_short_links.js';
import * as m004 from './004_email_log.js';
import * as m005 from './005_clicks.js';

// Migrations are registered in code rather than discovered from disk, so the same list
// works from both src (tsx) and dist (compiled), on every database engine.
const migrations: Record<string, Knex.Migration> = {
  '001_initial': m001,
  '002_qr_codes': m002,
  '003_short_links': m003,
  '004_email_log': m004,
  '005_clicks': m005,
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name],
};

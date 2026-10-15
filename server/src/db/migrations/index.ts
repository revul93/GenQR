import type { Knex } from 'knex';
import * as m001 from './001_initial.js';

// Migrations are registered in code rather than discovered from disk, so the same list
// works from both src (tsx) and dist (compiled), on every database engine.
const migrations: Record<string, Knex.Migration> = {
  '001_initial': m001,
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name],
};

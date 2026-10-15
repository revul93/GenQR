import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // One row per redirect. Rows older than the retention period are rolled up into
  // clicks_daily and deleted.
  await knex.schema.createTable('clicks', (t) => {
    t.increments('id').primary();
    t.integer('short_link_id').unsigned().notNullable().references('id').inTable('short_links').onDelete('CASCADE');
    t.bigInteger('ts').notNullable();
    t.string('source', 10).notNullable(); // qr | direct
    t.string('referrer_host', 255).nullable();
    t.string('browser', 50).nullable();
    t.string('os', 50).nullable();
    t.string('device', 10).notNullable(); // mobile | tablet | desktop | other
    t.string('country', 2).nullable(); // ISO code, when a GeoIP database is installed
    t.string('visitor', 64).notNullable(); // keyed hash of IP + user agent; never the IP itself
    t.boolean('is_bot').notNullable().defaultTo(false);
    t.index(['short_link_id', 'ts']);
    t.index(['ts']);
  });

  await knex.schema.createTable('clicks_daily', (t) => {
    t.integer('short_link_id').unsigned().notNullable().references('id').inTable('short_links').onDelete('CASCADE');
    t.string('day', 10).notNullable(); // YYYY-MM-DD (UTC)
    t.integer('clicks').notNullable();
    t.integer('visitors').notNullable();
    t.integer('qr').notNullable();
    t.integer('direct').notNullable();
    t.primary(['short_link_id', 'day']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('clicks_daily');
  await knex.schema.dropTableIfExists('clicks');
}

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('logos', (t) => {
    t.increments('id').primary();
    t.string('name', 200).notNullable();
    t.string('file_name', 100).notNullable(); // normalised PNG under data/uploads/logos/
    t.integer('width').notNullable();
    t.integer('height').notNullable();
    // Shared logos form the company library managed by admins; others belong to their uploader.
    t.boolean('is_shared').notNullable().defaultTo(false);
    t.integer('owner_id').unsigned().nullable().references('id').inTable('users');
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('style_presets', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable().unique();
    t.text('style').notNullable(); // JSON
    t.integer('logo_id').unsigned().nullable().references('id').inTable('logos');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.integer('created_by').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('qr_codes', (t) => {
    t.increments('id').primary();
    t.integer('owner_id').unsigned().notNullable().references('id').inTable('users');
    t.string('title', 200).notNullable();
    t.string('content_type', 20).notNullable(); // url | text
    t.text('content').notNullable(); // what the user entered
    t.text('encoded_data').notNullable(); // what the symbol encodes
    t.text('style').notNullable(); // JSON
    t.integer('logo_id').unsigned().nullable().references('id').inTable('logos');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('deleted_at').nullable();
    t.index(['owner_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('qr_codes');
  await knex.schema.dropTableIfExists('style_presets');
  await knex.schema.dropTableIfExists('logos');
}

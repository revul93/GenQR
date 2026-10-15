import crypto from 'node:crypto';
import type { Knex } from 'knex';

// Kept local: migrations must not change behaviour when application code changes later.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from(crypto.randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('');

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('short_links', (t) => {
    t.increments('id').primary();
    t.string('code', 64).notNullable().unique();
    t.text('target_url').notNullable();
    t.integer('owner_id').unsigned().notNullable().references('id').inTable('users');
    t.integer('qr_code_id').unsigned().nullable().unique().references('id').inTable('qr_codes');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('expires_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['owner_id']);
  });

  await knex.schema.createTable('short_link_history', (t) => {
    t.increments('id').primary();
    t.integer('short_link_id').unsigned().notNullable().references('id').inTable('short_links').onDelete('CASCADE');
    t.string('field', 20).notNullable(); // target | active | expires
    t.text('old_value').nullable();
    t.text('new_value').nullable();
    t.integer('changed_by').nullable();
    t.string('changed_by_name', 100).notNullable();
    t.bigInteger('changed_at').notNullable();
    t.index(['short_link_id', 'changed_at']);
  });

  // Existing URL codes (created before short links existed) get a short link now.
  const setting = await knex('settings').where({ key: 'app.publicBaseUrl' }).first();
  if (!setting) return;
  const base = String(JSON.parse(String(setting.value))).replace(/\/+$/, '');
  const urlCodes = await knex('qr_codes').where({ content_type: 'url' });
  for (const qr of urlCodes) {
    const code = randomCode();
    const now = Date.now();
    await knex('short_links').insert({
      code,
      target_url: qr.content,
      owner_id: qr.owner_id,
      qr_code_id: qr.id,
      is_active: qr.deleted_at == null,
      created_at: now,
      updated_at: now,
    });
    await knex('qr_codes').where({ id: qr.id }).update({ encoded_data: `${base}/short/${code}?s=qr` });
  }
}

export async function down(knex: Knex): Promise<void> {
  const links = await knex('short_links').whereNotNull('qr_code_id').select('qr_code_id', 'target_url');
  for (const l of links) await knex('qr_codes').where({ id: l.qr_code_id }).update({ encoded_data: l.target_url });
  await knex.schema.dropTableIfExists('short_link_history');
  await knex.schema.dropTableIfExists('short_links');
}

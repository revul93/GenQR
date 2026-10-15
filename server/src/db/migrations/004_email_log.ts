import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_log', (t) => {
    t.increments('id').primary();
    t.string('kind', 20).notNullable(); // qr | password_reset | test
    t.integer('qr_code_id').nullable();
    t.integer('sent_by').nullable();
    t.string('sent_by_name', 100).notNullable();
    t.text('recipients').notNullable(); // comma separated
    t.string('subject', 300).notNullable();
    t.string('formats', 100).nullable(); // e.g. "png,pdf"
    t.string('status', 10).notNullable(); // sent | failed
    t.text('error').nullable();
    t.bigInteger('sent_at').notNullable().index();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_log');
}

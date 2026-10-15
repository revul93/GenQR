import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 100).notNullable().unique();
    t.string('display_name', 200).notNullable();
    t.string('email', 255).nullable();
    t.string('source', 10).notNullable(); // local | ad
    t.string('role', 10).notNullable(); // admin | user
    t.string('password_hash', 255).nullable(); // local users only
    t.boolean('must_change_password').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('failed_logins').notNullable().defaultTo(0);
    t.bigInteger('locked_until').nullable();
    t.bigInteger('last_login_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('settings', (t) => {
    t.string('key', 100).primary();
    t.text('value').notNullable(); // JSON
    t.boolean('is_secret').notNullable().defaultTo(false);
    t.integer('updated_by').nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('sessions', (t) => {
    t.string('id', 64).primary(); // sha256 of the cookie value
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('last_seen_at').notNullable();
    t.bigInteger('expires_at').notNullable().index();
    t.string('ip', 64).nullable();
    t.string('user_agent', 500).nullable();
  });

  await knex.schema.createTable('password_resets', (t) => {
    t.string('token_hash', 64).primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('used_at').nullable();
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id').primary();
    t.integer('actor_id').nullable();
    t.string('actor_name', 100).notNullable(); // username snapshot, or "cli" / "system"
    t.string('action', 100).notNullable().index();
    t.string('entity_type', 50).nullable();
    t.string('entity_id', 100).nullable();
    t.text('details').nullable(); // JSON
    t.string('ip', 64).nullable();
    t.bigInteger('ts').notNullable().index();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('password_resets');
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('settings');
  await knex.schema.dropTableIfExists('users');
}

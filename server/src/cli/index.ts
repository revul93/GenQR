import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { env } from '../config.js';
import { closeDb, db, describeDbConfig, initDb, loadDbConfig, migrateLatest, migrateRollback } from '../db/index.js';
import { driverState, installDriver } from '../db/drivers.js';
import { configFor, runSwitch, switchTargetSchema, testTarget } from '../db/switch.js';
import { restoreDump, tableCounts, writeDump } from '../db/transfer.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { audit } from '../services/audit.js';
import { destroyUserSessions } from '../services/sessions.js';
import { readSetupToken } from '../services/setupToken.js';
import { getVersionInfo } from '../services/system.js';
import { countUsers, findUserByUsername, revokePasswordResets, setPasswordHash, unlockUser } from '../services/users.js';
import { promptHidden, readStdin } from './prompt.js';

const cliActor = () => ({ id: null, name: `cli:${os.userInfo().username}` });

const USAGE = `GenQR command-line tools

Usage: genqrctl <command> [options]   (or: npm run cli -- <command>)

  reset-password <username> [--password-stdin] [--unlock] [--must-change]
        Set a new password for a local user. Signs the user out everywhere.
        --unlock       also clear a lockout and re-enable a disabled account
        --must-change  require the user to change it at next sign-in
  setup-token     Show the first-launch setup token (only before setup is done)
  migrate         Apply pending database migrations
  migrate-rollback  Undo the most recent batch of migrations (used by the updater)
  backup <file>   Back up the database: a SQLite file copy, or for other engines a
                  compressed JSON dump (use a .json.gz name)
  restore <file>  Replace ALL data with a backup (.db file for SQLite, or a .json.gz
                  dump for any engine). Stop the service first.
  db-status       Show the database in use, its driver and row counts
  install-driver  Install the driver for the configured database
  db-switch --client <mysql|pg|sqlite> [connection options]
        Move all data to another (empty) database and switch GenQR to it.
        --host --port --database --user [--password-stdin] [--ssl] [--no-verify-cert]
        --filename <path>  (for sqlite)
        Stop the service first; start it again afterwards.
  version         Show version and commit
`;

class CliError extends Error {}

async function resetPassword(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'password-stdin': { type: 'boolean' }, unlock: { type: 'boolean' }, 'must-change': { type: 'boolean' } },
  });
  const username = positionals[0];
  if (!username) throw new CliError('Usage: reset-password <username> [--password-stdin] [--unlock] [--must-change]');

  initDb();
  const user = await findUserByUsername(username);
  if (!user) throw new CliError(`No user named "${username}".`);
  if (user.source !== 'local') throw new CliError(`"${user.username}" is an Active Directory user; their password is managed in AD.`);

  let password: string;
  if (values['password-stdin']) {
    password = await readStdin();
  } else {
    password = await promptHidden(`New password for ${user.username}: `);
    const confirm = await promptHidden('Repeat new password: ');
    if (password !== confirm) throw new CliError('Passwords do not match.');
  }
  const problem = passwordProblem(password);
  if (problem) throw new CliError(problem);

  await setPasswordHash(user.id, await hashPassword(password), !!values['must-change']);
  if (values.unlock) await unlockUser(user.id);
  await destroyUserSessions(user.id);
  await revokePasswordResets(user.id);
  await audit({
    actor: cliActor(),
    action: 'user.password_reset',
    entityType: 'user',
    entityId: user.id,
    details: { username: user.username, unlock: !!values.unlock, mustChange: !!values['must-change'] },
  });
  console.log(`Password for "${user.username}" updated${values.unlock ? ' and account unlocked' : ''}. Existing sessions were signed out.`);
}

async function showSetupToken(): Promise<void> {
  initDb();
  await migrateLatest();
  if ((await countUsers()) > 0) throw new CliError('Setup has already been completed; there is no setup token.');
  const token = readSetupToken();
  if (!token) throw new CliError('No setup token yet. Start the service once and it will be generated.');
  console.log(token);
}

async function migrate(): Promise<void> {
  initDb();
  const applied = await migrateLatest();
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date.');
}

async function backup(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) throw new CliError('Usage: backup <file>');
  initDb();
  const file = path.resolve(target);
  if (loadDbConfig().client === 'sqlite' && !file.endsWith('.json.gz')) {
    // better-sqlite3's online backup API is safe while the service is running.
    const conn = (await db().client.acquireConnection()) as { backup(file: string): Promise<unknown> };
    try {
      await conn.backup(file);
    } finally {
      await db().client.releaseConnection(conn);
    }
  } else {
    await writeDump(db(), file);
  }
  console.log(`Database backed up to ${file}`);
}

async function restore(args: string[]): Promise<void> {
  const source = args[0];
  if (!source) throw new CliError('Usage: restore <file>');
  const file = path.resolve(source);
  const cfg = loadDbConfig();
  if (file.endsWith('.json.gz')) {
    initDb();
    await migrateLatest();
    await restoreDump(db(), cfg.client, file, (l) => console.log(l));
  } else {
    if (cfg.client !== 'sqlite') throw new CliError('Only .json.gz dumps can be restored into a non-SQLite database.');
    const fs = await import('node:fs');
    const dbFile = path.resolve(String(cfg.connection.filename));
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    fs.copyFileSync(file, dbFile);
  }
  console.log(`Restored from ${file}.`);
}

async function migrateBack(): Promise<void> {
  initDb();
  const undone = await migrateRollback();
  console.log(undone.length ? `Rolled back: ${undone.join(', ')}` : 'Nothing to roll back.');
}

async function dbStatus(): Promise<void> {
  const cfg = loadDbConfig();
  const { connection } = describeDbConfig(cfg);
  const d = driverState(cfg.client);
  console.log(`engine:     ${cfg.client}`);
  console.log(`connection: ${JSON.stringify(connection)}`);
  console.log(`driver:     ${d.package} ${d.installed ?? 'NOT INSTALLED'}${d.installed && d.installed !== d.wanted ? ` (wanted ${d.wanted})` : ''}`);
  await installDriver(cfg.client);
  initDb();
  const counts = await tableCounts(db());
  console.log('rows:       ' + Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' '));
}

async function installActiveDriver(): Promise<void> {
  await installDriver(loadDbConfig().client, (l) => console.log(l));
  const d = driverState(loadDbConfig().client);
  console.log(`${d.package} ${d.installed} ready.`);
}

async function dbSwitch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      database: { type: 'string' },
      user: { type: 'string' },
      filename: { type: 'string' },
      ssl: { type: 'boolean' },
      'no-verify-cert': { type: 'boolean' },
      'password-stdin': { type: 'boolean' },
    },
  });
  const password = values['password-stdin'] ? await readStdin() : values.client && values.client !== 'sqlite' ? await promptHidden('Database password: ') : '';
  const parsed = switchTargetSchema.safeParse({
    client: values.client,
    filename: values.filename,
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    database: values.database,
    user: values.user,
    password,
    ssl: !!values.ssl,
    verifyCertificate: !values['no-verify-cert'],
  });
  if (!parsed.success) throw new CliError(parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('\n'));
  const target = parsed.data;

  const test = await testTarget(target, (l) => console.log(l));
  console.log(`Target: ${test.version}`);
  if (!test.empty) throw new CliError(test.problem ?? 'The target database is not empty.');

  initDb();
  await migrateLatest();
  await runSwitch(target, cliActor().name);
  await audit({ actor: cliActor(), action: 'database.switch_copied', details: { to: target.client, connection: describeDbConfig(configFor(target)).connection } });
  console.log('\nAll data copied and the configuration updated. Start GenQR to use the new database');
  console.log('(genqrctl start). If it cannot open the new database it switches back automatically.');
}

async function version(): Promise<void> {
  const v = await getVersionInfo();
  console.log(`GenQR ${v.version}\ncommit:   ${v.commit ?? 'unknown'}\nbranch:   ${v.branch ?? 'unknown'}\ndatabase: ${loadDbConfig().client}\nport:     ${env.port}`);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  'reset-password': resetPassword,
  'setup-token': showSetupToken,
  migrate,
  'migrate-rollback': migrateBack,
  backup,
  restore,
  'db-status': dbStatus,
  'db-switch': dbSwitch,
  'install-driver': installActiveDriver,
  version,
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const handler = command ? commands[command] : undefined;
  if (!handler) {
    console.log(USAGE);
    process.exitCode = command && command !== 'help' ? 1 : 0;
    return;
  }
  try {
    await handler(args);
  } catch (err) {
    process.exitCode = 1;
    console.error(err instanceof CliError ? `Error: ${err.message}` : err);
  } finally {
    await closeDb();
  }
}

await main();

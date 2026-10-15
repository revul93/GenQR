import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { env } from '../config.js';
import { closeDb, db, initDb, loadDbConfig, migrateLatest } from '../db/index.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { audit } from '../services/audit.js';
import { destroyUserSessions } from '../services/sessions.js';
import { readSetupToken } from '../services/setupToken.js';
import { getVersionInfo } from '../services/system.js';
import { countUsers, findUserByUsername, setPasswordHash, unlockUser } from '../services/users.js';
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
  backup <file>   Write an online backup of the SQLite database to <file>
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
  if (loadDbConfig().client !== 'sqlite') throw new CliError(`Online backup is only built in for SQLite (current: ${loadDbConfig().client}).`);
  initDb();
  // better-sqlite3's online backup API is safe while the service is running.
  const conn = (await db().client.acquireConnection()) as { backup(file: string): Promise<unknown> };
  try {
    await conn.backup(path.resolve(target));
  } finally {
    await db().client.releaseConnection(conn);
  }
  console.log(`Database backed up to ${path.resolve(target)}`);
}

async function version(): Promise<void> {
  const v = await getVersionInfo();
  console.log(`GenQR ${v.version}\ncommit:   ${v.commit ?? 'unknown'}\nbranch:   ${v.branch ?? 'unknown'}\ndatabase: ${loadDbConfig().client}\nport:     ${env.port}`);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  'reset-password': resetPassword,
  'setup-token': showSetupToken,
  migrate,
  backup,
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

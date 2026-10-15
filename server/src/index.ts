import { env } from './config.js';
import { closeDb, dbClient, initDb, loadDbConfig, migrateLatest } from './db/index.js';
import { installDriver } from './db/drivers.js';
import { confirmSwitch, pendingSwitch, revertSwitch } from './db/switch.js';
import { onShutdown } from './services/lifecycle.js';
import { createApp } from './app.js';
import { audit, SYSTEM_ACTOR } from './services/audit.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { applyRetention } from './services/clicks.js';
import { ensureSetupToken, printSetupBanner, removeSetupToken } from './services/setupToken.js';
import { getVersionInfo } from './services/system.js';
import { countUsers } from './services/users.js';

/** Opens the configured database; after a database switch, falls back to the previous one if the new one fails. */
async function openDatabase(): Promise<string[]> {
  try {
    await installDriver(loadDbConfig().client, (line) => console.log(line));
    initDb();
    return await migrateLatest();
  } catch (err) {
    if (!pendingSwitch()) throw err;
    console.error('The new database could not be opened; restoring the previous configuration.', err);
    await closeDb();
    revertSwitch(err as Error);
    initDb();
    return migrateLatest();
  }
}

async function main(): Promise<void> {
  const applied = await openDatabase();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  confirmSwitch();

  if ((await countUsers()) === 0) printSetupBanner(ensureSetupToken(), env.port);
  else removeSetupToken();

  const { version, commit } = await getVersionInfo();
  const server = createApp().listen(env.port, env.host, () => {
    console.log(`GenQR ${version} (${commit?.slice(0, 7) ?? 'no git'}) listening on ${env.host}:${env.port} using ${dbClient()}`);
  });
  await audit({ actor: SYSTEM_ACTOR, action: 'system.started', details: { version, commit } });

  const purge = setInterval(() => purgeExpiredSessions().catch((err) => console.error('Session purge failed', err)), 60 * 60 * 1000);
  const retention = () =>
    applyRetention()
      .then(({ archived }) => archived && console.log(`Archived ${archived} detailed clicks into daily totals`))
      .catch((err) => console.error('Click retention failed', err));
  const retentionTimer = setInterval(retention, 6 * 60 * 60 * 1000);
  setTimeout(retention, 60 * 1000).unref();

  const shutdown = (signal: string) => {
    console.log(signal === 'restart' ? 'Restarting' : `${signal} received, shutting down`);
    clearInterval(purge);
    clearInterval(retentionTimer);
    server.close(() => {
      closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  onShutdown(shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

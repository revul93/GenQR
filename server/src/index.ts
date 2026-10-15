import { env } from './config.js';
import { closeDb, dbClient, initDb, migrateLatest } from './db/index.js';
import { createApp } from './app.js';
import { audit, SYSTEM_ACTOR } from './services/audit.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { ensureSetupToken, printSetupBanner, removeSetupToken } from './services/setupToken.js';
import { getVersionInfo } from './services/system.js';
import { countUsers } from './services/users.js';

async function main(): Promise<void> {
  initDb();
  const applied = await migrateLatest();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  if ((await countUsers()) === 0) printSetupBanner(ensureSetupToken(), env.port);
  else removeSetupToken();

  const { version, commit } = await getVersionInfo();
  const server = createApp().listen(env.port, env.host, () => {
    console.log(`GenQR ${version} (${commit?.slice(0, 7) ?? 'no git'}) listening on ${env.host}:${env.port} using ${dbClient()}`);
  });
  await audit({ actor: SYSTEM_ACTOR, action: 'system.started', details: { version, commit } });

  const purge = setInterval(() => purgeExpiredSessions().catch((err) => console.error('Session purge failed', err)), 60 * 60 * 1000);

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(purge);
    server.close(() => {
      closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

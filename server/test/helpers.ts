import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDb, db, dbClient, initDb, migrateLatest } from '../src/db/index.js';
import { installDriver } from '../src/db/drivers.js';
import { loadDbConfig } from '../src/db/index.js';
import { dropAppTables } from '../src/db/transfer.js';
import { ensureSetupToken } from '../src/services/setupToken.js';

export const ADMIN = { username: 'admin', password: 'AdminPass123' };
export const BASE_URL = 'https://genqr.test';

/** Fresh, migrated database (cleared first when it is a shared server database) and the Express app. */
export async function startApp(): Promise<Express> {
  await installDriver(loadDbConfig().client);
  initDb();
  if (dbClient() !== 'sqlite') await dropAppTables(db());
  await migrateLatest();
  return createApp();
}

export async function stopApp(): Promise<void> {
  await closeDb();
}

/** A logged-in client that keeps its session cookie. */
export type Agent = ReturnType<typeof request.agent>;

export async function setupAdmin(app: Express): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/setup').send({
    token: ensureSetupToken(),
    username: ADMIN.username,
    displayName: 'Admin',
    email: 'admin@genqr.test',
    password: ADMIN.password,
    publicBaseUrl: BASE_URL,
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function login(app: Express, username: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function createUser(admin: Agent, username: string, role: 'user' | 'admin' = 'user', password = 'UserPass1234'): Promise<number> {
  const res = await admin.post('/api/admin/users/local').send({ username, displayName: username, role, password, mustChangePassword: false });
  if (res.status !== 201) throw new Error(`create user failed: ${JSON.stringify(res.body)}`);
  return res.body.user.id;
}

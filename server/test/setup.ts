/**
 * Runs before each test file, before any application module is imported: points GENQR_ROOT
 * at a fresh temporary folder so tests never touch real data.
 *
 * GENQR_TEST_DB (JSON) selects another engine, e.g.
 *   {"client":"pg","connection":{"host":"127.0.0.1","port":5432,"database":"genqr_test","user":"genqr_test","ssl":false,"verifyCertificate":true},"password":"..."}
 * GENQR_TEST_DRIVERS points at a folder with drivers already installed (node_modules inside).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genqr-test-'));
for (const dir of ['config', 'data', 'logs']) fs.mkdirSync(path.join(root, dir));
for (const file of ['package.json', 'drivers.manifest.json']) fs.copyFileSync(path.join(repo, file), path.join(root, file));

process.env.GENQR_ROOT = root;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.NODE_ENV = 'test';

if (process.env.GENQR_TEST_DRIVERS) fs.symlinkSync(path.resolve(process.env.GENQR_TEST_DRIVERS), path.join(root, 'drivers'), 'junction');

if (process.env.GENQR_TEST_DB) {
  const { password, ...cfg } = JSON.parse(process.env.GENQR_TEST_DB) as { password?: string; client: string; connection: unknown };
  const { encryptSecret } = await import('../src/services/crypto.js');
  fs.writeFileSync(path.join(root, 'config', 'database.json'), JSON.stringify({ ...cfg, passwordEnc: password ? encryptSecret(password) : null }));
}

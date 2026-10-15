import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled files live in server/dist, sources in server/src — both are two levels below the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = process.env.GENQR_ROOT ? path.resolve(process.env.GENQR_ROOT) : path.resolve(here, '..', '..');

export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const LOG_DIR = path.join(ROOT_DIR, 'logs');
export const DRIVERS_DIR = path.join(ROOT_DIR, 'drivers');
export const CLIENT_DIST_DIR = path.join(ROOT_DIR, 'client', 'dist');

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  // Express "trust proxy" value; the reverse proxy runs on the same host by default.
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
};

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}

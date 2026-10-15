import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir } from '../config.js';

/**
 * One-time token required by the first-launch setup wizard, so nobody else on the
 * network can claim the admin account before the operator does. It is printed in the
 * server log and can be shown again with `genqrctl setup-token`.
 */
const TOKEN_FILE = path.join(DATA_DIR, 'setup-token');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const normalize = (token: string) => token.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function readSetupToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function ensureSetupToken(): string {
  const existing = readSetupToken();
  if (existing) return existing;
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  const token = chars.match(/.{4}/g)!.join('-');
  ensureDir(DATA_DIR);
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

export function verifySetupToken(candidate: string): boolean {
  const expected = readSetupToken();
  if (!expected) return false;
  const a = Buffer.from(normalize(candidate));
  const b = Buffer.from(normalize(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function removeSetupToken(): void {
  fs.rmSync(TOKEN_FILE, { force: true });
}

export function printSetupBanner(token: string, port: number): void {
  const line = '='.repeat(64);
  console.log(`\n${line}\n  GenQR first-launch setup\n  Open http://<this-server>:${port}/ and enter this setup token:\n\n      ${token}\n\n  (show it again with: genqrctl setup-token)\n${line}\n`);
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DRIVERS_DIR, ROOT_DIR, ensureDir } from '../config.js';
import type { DbClient } from './index.js';

/**
 * Database drivers other than SQLite are installed on demand into drivers/ (git-ignored),
 * at the versions pinned in the tracked drivers.manifest.json.
 */

interface ManifestEntry {
  package: string;
  version: string;
}

export function driverManifest(): Partial<Record<DbClient, ManifestEntry>> {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'drivers.manifest.json'), 'utf8'));
}

export interface DriverState {
  client: DbClient;
  package: string;
  wanted: string;
  installed: string | null;
}

export function driverState(client: DbClient): DriverState {
  if (client === 'sqlite') return { client, package: 'better-sqlite3', wanted: 'bundled', installed: 'bundled' };
  const entry = driverManifest()[client];
  if (!entry) throw new Error(`No driver listed for ${client} in drivers.manifest.json`);
  let installed: string | null = null;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(DRIVERS_DIR, 'node_modules', entry.package, 'package.json'), 'utf8')).version;
  } catch {
    /* not installed */
  }
  return { client, package: entry.package, wanted: entry.version, installed };
}

export const driverReady = (client: DbClient) => {
  const s = driverState(client);
  return s.installed === s.wanted;
};

/** Installs (or re-pins) the driver for a client. `log` receives npm's output line by line. */
export async function installDriver(client: DbClient, log: (line: string) => void = () => {}): Promise<void> {
  if (client === 'sqlite' || driverReady(client)) return;
  const { package: pkg, wanted } = driverState(client);
  ensureDir(DRIVERS_DIR);
  // Its own package.json stops npm from treating the repository root (a workspace) as the project.
  const manifest = path.join(DRIVERS_DIR, 'package.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'genqr-drivers', private: true }, null, 2) + '\n');

  log(`Installing ${pkg}@${wanted} …`);
  const args = ['install', '--prefix', DRIVERS_DIR, `${pkg}@${wanted}`, '--save-exact', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'];
  await new Promise<void>((resolve, reject) => {
    // npm is a .cmd script on Windows, which Node only runs through a shell; there the command
    // is passed as one quoted string. All parts are fixed values, never user input.
    const child =
      process.platform === 'win32'
        ? spawn(['npm', ...args.map((a) => `"${a}"`)].join(' '), { cwd: DRIVERS_DIR, shell: true, env: process.env })
        : spawn('npm', args, { cwd: DRIVERS_DIR, env: process.env });
    const forward = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach(log);
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install ${pkg} failed (exit code ${code}). Check that this server can reach the npm registry.`))));
  });
  if (!driverReady(client)) throw new Error(`${pkg} did not install correctly.`);
  log(`${pkg}@${wanted} installed.`);
}

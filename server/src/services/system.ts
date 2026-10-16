import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, LOG_DIR, ROOT_DIR, ensureDir, readAppVersion } from '../config.js';

const run = promisify(execFile);

/** Container images are updated by pulling a new image, not by git (see Dockerfile). */
export const inContainer = () => process.env.GENQR_RUNTIME === 'container';

// Shared with scripts/update.sh: the web app only drops a request file; a separate,
// privileged job (systemd genqr-update.path → genqr-update.service) performs the update.
export const UPDATE_REQUEST_FILE = path.join(DATA_DIR, 'update.request');
export const UPDATE_STATUS_FILE = path.join(DATA_DIR, 'update-status.json');
export const UPDATE_LOG_FILE = path.join(LOG_DIR, 'update.log');

async function git(...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: ROOT_DIR, timeout: 15000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface VersionInfo {
  version: string;
  commit: string | null;
  branch: string | null;
  commitDate: string | null;
  commitSubject: string | null;
}

let cachedVersion: VersionInfo | undefined;

/** Read once at startup: the code on disk only changes through an update, which restarts the process. */
export async function getVersionInfo(): Promise<VersionInfo> {
  if (cachedVersion) return cachedVersion;
  const [commit, branch, log] = await Promise.all([
    git('rev-parse', 'HEAD'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('log', '-1', '--format=%cI%n%s'),
  ]);
  const [commitDate, commitSubject] = log ? log.split('\n') : [null, null];
  cachedVersion = {
    version: readAppVersion(),
    // Images have no .git; the build passes the commit in.
    commit: commit ?? (process.env.GENQR_COMMIT && process.env.GENQR_COMMIT !== 'unknown' ? process.env.GENQR_COMMIT : null),
    branch,
    commitDate: commitDate ?? null,
    commitSubject: commitSubject ?? null,
  };
  return cachedVersion;
}

export interface UpdateCheck {
  remoteCommit: string | null;
  updateAvailable: boolean;
  error?: string;
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  if (inContainer()) return { remoteCommit: null, updateAvailable: false, error: 'GenQR runs in a container: update it by pulling the new image and recreating the container.' };
  const { commit, branch } = await getVersionInfo();
  if (!commit || !branch) return { remoteCommit: null, updateAvailable: false, error: 'This installation is not a git checkout.' };
  const out = await git('ls-remote', 'origin', `refs/heads/${branch}`);
  if (out === null) return { remoteCommit: null, updateAvailable: false, error: 'Could not reach the git remote.' };
  const remoteCommit = out.split(/\s+/)[0] || null;
  return { remoteCommit, updateAvailable: !!remoteCommit && remoteCommit !== commit };
}

export interface UpdateStatus {
  state: 'idle' | 'requested' | 'running' | 'success' | 'failed' | 'up-to-date';
  message?: string;
  requestedBy?: string;
  fromCommit?: string;
  toCommit?: string;
  at?: string;
}

export function readUpdateStatus(): UpdateStatus {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')) as UpdateStatus;
  } catch {
    return { state: 'idle' };
  }
}

export function isUpdateInProgress(): boolean {
  const { state } = readUpdateStatus();
  return fs.existsSync(UPDATE_REQUEST_FILE) || fs.existsSync(UPDATE_REQUEST_FILE + '.processing') || state === 'running';
}

export function requestUpdate(requestedBy: string): void {
  ensureDir(DATA_DIR);
  const at = new Date().toISOString();
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'requested', requestedBy, at } satisfies UpdateStatus));
  fs.writeFileSync(UPDATE_REQUEST_FILE, JSON.stringify({ requestedBy, at }));
}

export function readUpdateLog(maxLines = 300): string {
  try {
    ensureDir(LOG_DIR);
    const lines = fs.readFileSync(UPDATE_LOG_FILE, 'utf8').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

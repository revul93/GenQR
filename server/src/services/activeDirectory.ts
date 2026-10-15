import { Client, InvalidCredentialsError, ResultCodeError, type Entry } from 'ldapts';
import { z } from 'zod';
import { HttpError } from '../http.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Active Directory access. Sign-in works in two steps: the service account looks the user
 * up (by sAMAccountName by default) to find their DN, then we bind as that DN with the
 * password the user typed.
 */

export const AD_SETTING_KEY = 'ad.config';

export const adConfigSchema = z.object({
  enabled: z.boolean(),
  // Tried in order; later URLs are fallbacks when earlier ones are unreachable.
  urls: z.array(z.string().trim().regex(/^ldaps?:\/\/[^\s/]+$/i, 'Use ldap://host[:port] or ldaps://host[:port]')).min(1).max(5),
  startTls: z.boolean(),
  rejectUnauthorized: z.boolean(),
  caCert: z.string().max(20000).default(''),
  bindDn: z.string().trim().min(1).max(500),
  baseDn: z.string().trim().min(1).max(500),
  // {{username}} is replaced with the escaped login name.
  userFilter: z.string().trim().min(1).max(1000).refine((f) => f.includes('{{username}}'), 'Must contain {{username}}'),
  // {{query}} is replaced with the escaped search text.
  searchFilter: z.string().trim().min(1).max(1000).refine((f) => f.includes('{{query}}'), 'Must contain {{query}}'),
  usernameAttribute: z.string().trim().min(1).max(100),
  displayNameAttribute: z.string().trim().min(1).max(100),
  emailAttribute: z.string().trim().min(1).max(100),
  timeoutSeconds: z.number().int().min(1).max(60),
});

export type AdConfig = z.infer<typeof adConfigSchema>;
type StoredAdConfig = AdConfig & { bindPasswordEnc: string | null };

export const DEFAULT_AD_CONFIG: AdConfig = {
  enabled: false,
  urls: ['ldaps://dc1.example.local:636'],
  startTls: false,
  rejectUnauthorized: true,
  caCert: '',
  bindDn: 'CN=svc-genqr,OU=Service Accounts,DC=example,DC=local',
  baseDn: 'DC=example,DC=local',
  userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))',
  searchFilter:
    '(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=*{{query}}*)(displayName=*{{query}}*)(mail=*{{query}}*)))',
  usernameAttribute: 'sAMAccountName',
  displayNameAttribute: 'displayName',
  emailAttribute: 'mail',
  timeoutSeconds: 10,
};

/** What the admin UI sees: never the password itself. */
export type PublicAdConfig = AdConfig & { hasBindPassword: boolean };

async function loadStored(): Promise<StoredAdConfig> {
  return getSetting<StoredAdConfig>(AD_SETTING_KEY, { ...DEFAULT_AD_CONFIG, bindPasswordEnc: null });
}

export async function getAdConfig(): Promise<PublicAdConfig> {
  const { bindPasswordEnc, ...cfg } = await loadStored();
  return { ...DEFAULT_AD_CONFIG, ...cfg, hasBindPassword: !!bindPasswordEnc };
}

/** An empty/omitted bindPassword keeps the stored one. */
export async function saveAdConfig(cfg: AdConfig, bindPassword: string | undefined, userId: number): Promise<void> {
  const current = await loadStored();
  const bindPasswordEnc = bindPassword ? encryptSecret(bindPassword) : current.bindPasswordEnc;
  await setSetting(AD_SETTING_KEY, { ...cfg, bindPasswordEnc }, { userId, secret: true });
}

/** Resolves the bind password for a config being tested: the typed one, else the stored one. */
async function resolveBindPassword(override?: string): Promise<string> {
  if (override) return override;
  const { bindPasswordEnc } = await loadStored();
  if (!bindPasswordEnc) throw new HttpError(400, 'No service-account password has been saved yet.', 'AD_NO_PASSWORD');
  return decryptSecret(bindPasswordEnc);
}

// RFC 4515 escaping for values placed inside a filter.
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export interface AdUser {
  dn: string;
  username: string;
  displayName: string;
  email: string | null;
  disabled: boolean;
}

const firstString = (v: Entry[string] | undefined): string | null => {
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null) return null;
  return Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
};

function toAdUser(cfg: AdConfig, e: Entry): AdUser {
  const username = firstString(e[cfg.usernameAttribute]) ?? '';
  // userAccountControl bit 0x2 = ACCOUNTDISABLE
  const uac = Number(firstString(e.userAccountControl) ?? 0);
  return {
    dn: e.dn,
    username,
    displayName: firstString(e[cfg.displayNameAttribute]) ?? username,
    email: firstString(e[cfg.emailAttribute]),
    disabled: (uac & 2) === 2,
  };
}

export class AdUnavailableError extends HttpError {
  constructor(detail: string) {
    super(503, `Could not reach Active Directory: ${detail}`, 'AD_UNAVAILABLE');
  }
}

function tlsOptions(cfg: AdConfig) {
  return { rejectUnauthorized: cfg.rejectUnauthorized, ...(cfg.caCert.trim() ? { ca: [cfg.caCert] } : {}) };
}

/**
 * Runs fn against each configured server in turn until one is reachable. ldapts connects
 * lazily, so "unreachable" shows up as a non-LDAP error from the first operation. LDAP
 * result errors (bad password, no such object, …) come from a reachable server and are final.
 */
async function withServer<T>(cfg: AdConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of cfg.urls) {
    const secure = url.toLowerCase().startsWith('ldaps://');
    // tlsOptions only for ldaps:// — ldapts would otherwise speak TLS to a plain LDAP port.
    const client = new Client({ url, timeout: cfg.timeoutSeconds * 1000, connectTimeout: cfg.timeoutSeconds * 1000, ...(secure ? { tlsOptions: tlsOptions(cfg) } : {}) });
    try {
      if (cfg.startTls && !secure) await client.startTLS(tlsOptions(cfg));
      return await fn(client);
    } catch (err) {
      if (err instanceof ResultCodeError || err instanceof HttpError) throw err;
      errors.push(`${url}: ${(err as Error).message}`);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
  throw new AdUnavailableError(errors.join('; '));
}

/** Runs fn with a client bound as the service account. */
async function withServiceBind<T>(cfg: AdConfig, bindPassword: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return withServer(cfg, async (client) => {
    try {
      await client.bind(cfg.bindDn, bindPassword);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) throw new HttpError(502, 'The service account DN or password was rejected by Active Directory.', 'AD_BIND_FAILED');
      throw err;
    }
    return fn(client);
  });
}

const userAttributes = (cfg: AdConfig) => [cfg.usernameAttribute, cfg.displayNameAttribute, cfg.emailAttribute, 'userAccountControl'];

async function lookup(client: Client, cfg: AdConfig, username: string): Promise<AdUser | null> {
  const filter = cfg.userFilter.replaceAll('{{username}}', escapeFilterValue(username));
  const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter, attributes: userAttributes(cfg), sizeLimit: 2 });
  return searchEntries.length === 1 ? toAdUser(cfg, searchEntries[0]!) : null;
}

async function activeConfig(): Promise<AdConfig> {
  const cfg = await getAdConfig();
  if (!cfg.enabled) throw new HttpError(503, 'Active Directory sign-in is not configured.', 'AD_NOT_CONFIGURED');
  return cfg;
}

export async function findAdUser(username: string): Promise<AdUser | null> {
  const cfg = await activeConfig();
  return withServiceBind(cfg, await resolveBindPassword(), (client) => lookup(client, cfg, username));
}

export async function searchAdUsers(query: string, limit = 25): Promise<AdUser[]> {
  const cfg = await activeConfig();
  const filter = cfg.searchFilter.replaceAll('{{query}}', escapeFilterValue(query));
  return withServiceBind(cfg, await resolveBindPassword(), async (client) => {
    const users: AdUser[] = [];
    // Paged search avoids the server's size-limit error on broad queries; stop once we have enough.
    for await (const page of client.searchPaginated(cfg.baseDn, { scope: 'sub', filter, attributes: userAttributes(cfg), paged: { pageSize: limit } })) {
      for (const e of page.searchEntries) users.push(toAdUser(cfg, e));
      if (users.length >= limit) break;
    }
    return users.slice(0, limit).sort((a, b) => a.username.localeCompare(b.username));
  });
}

export type AdLoginResult = { ok: true; user: AdUser } | { ok: false; reason: 'not_found' | 'disabled' | 'bad_password' };

export async function verifyAdCredentials(username: string, password: string): Promise<AdLoginResult> {
  // An empty password would be an "unauthenticated bind", which LDAP servers accept.
  if (!password) return { ok: false, reason: 'bad_password' };
  const cfg = await activeConfig();
  const user = await withServiceBind(cfg, await resolveBindPassword(), (client) => lookup(client, cfg, username));
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.disabled) return { ok: false, reason: 'disabled' };

  try {
    await withServer(cfg, (client) => client.bind(user.dn, password));
    return { ok: true, user };
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return { ok: false, reason: 'bad_password' };
    throw err;
  }
}

export interface AdTestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

/** Tests an (unsaved) configuration from the settings page: connect, service bind, optional lookup. */
export async function testAdConfig(cfg: AdConfig, bindPasswordOverride: string | undefined, testUsername: string | undefined): Promise<AdTestResult> {
  const steps: AdTestResult['steps'] = [];
  const record = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });
  try {
    const password = await resolveBindPassword(bindPasswordOverride);
    await withServiceBind(cfg, password, async (client) => {
      record('Connect and bind as service account', true, `Bound as ${cfg.bindDn}`);
      if (testUsername) {
        const user = await lookup(client, cfg, testUsername);
        if (user) record(`Look up "${testUsername}"`, true, `${user.displayName} <${user.email ?? 'no email'}>${user.disabled ? ' — account is DISABLED in AD' : ''} · ${user.dn}`);
        else record(`Look up "${testUsername}"`, false, 'No unique match for the user filter.');
      }
    });
  } catch (err) {
    record(steps.length ? 'Look up user' : 'Connect and bind as service account', false, (err as Error).message);
  }
  return { ok: steps.every((s) => s.ok), steps };
}

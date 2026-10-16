import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, BASE_URL, createUser, login, setupAdmin, startApp, stopApp, type Agent } from '../helpers.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let app: Express;
let admin: Agent;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);

describe('first-launch setup', () => {
  it('reports that setup is needed and rejects a wrong token', async () => {
    expect((await request(app).get('/api/setup/status')).body).toEqual({ needsSetup: true });
    const res = await request(app).post('/api/setup').send({ token: 'WRONG-TOKEN', username: 'someone', displayName: 'Someone', email: 'someone@example.com', password: 'Password1234', publicBaseUrl: BASE_URL });
    expect(res.status).toBe(403);
  });

  it('creates the administrator once', async () => {
    admin = await setupAdmin(app);
    expect((await admin.get('/api/auth/me')).body.user).toMatchObject({ username: 'admin', role: 'admin', source: 'local' });
    expect((await request(app).get('/api/setup/status')).body).toEqual({ needsSetup: false });
    const again = await request(app).post('/api/setup').send({ token: 'X', username: 'evil', displayName: 'Evil', email: 'someone@example.com', password: 'Password1234', publicBaseUrl: BASE_URL });
    expect(again.status).toBe(409);
  });
});

describe('authentication', () => {
  it('rejects unknown users and wrong passwords with the same message', async () => {
    const unknown = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'whatever123' });
    const wrong = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'whatever123' });
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it('locks an account after repeated failures', async () => {
    await createUser(admin, 'locky');
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ username: 'locky', password: 'bad-password-1' });
    const res = await request(app).post('/api/auth/login').send({ username: 'locky', password: 'UserPass1234' });
    expect(res.status).toBe(423);
  });

  it('rejects cross-site state-changing requests', async () => {
    const res = await admin.post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('requires a session for protected routes', async () => {
    expect((await request(app).get('/api/qr')).status).toBe(401);
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
  });
});

describe('users and permissions', () => {
  let bob: Agent;

  beforeAll(async () => {
    await createUser(admin, 'bob');
    bob = await login(app, 'bob', 'UserPass1234');
  });

  it('keeps normal users out of admin endpoints', async () => {
    for (const path of ['/api/admin/users', '/api/admin/audit', '/api/admin/system', '/api/admin/settings/email', '/api/admin/database']) {
      expect((await bob.get(path)).status, path).toBe(403);
    }
  });

  it('refuses usernames that already exist, in any case', async () => {
    const res = await admin.post('/api/admin/users/local').send({ username: 'BOB', displayName: 'x', role: 'user', password: 'UserPass1234' });
    expect(res.status).toBe(409);
  });

  it('protects the last administrator and the current user', async () => {
    const me = (await admin.get('/api/auth/me')).body.user.id;
    expect((await admin.patch(`/api/admin/users/${me}`).send({ role: 'user' })).status).toBe(409);
    expect((await admin.delete(`/api/admin/users/${me}`)).status).toBe(409);
  });

  it('signs a disabled user out immediately', async () => {
    const id = await createUser(admin, 'carol');
    const carol = await login(app, 'carol', 'UserPass1234');
    await admin.patch(`/api/admin/users/${id}`).send({ isActive: false });
    expect((await carol.get('/api/auth/me')).status).toBe(401);
  });

  it('isolates QR codes, links and stats between users', async () => {
    const created = await admin.post('/api/qr').send({ title: 'Admin only', contentType: 'url', content: 'https://example.com/a', style: {} });
    expect(created.status).toBe(201);
    const { id, shortLink } = created.body.qr;
    expect((await bob.get(`/api/qr/${id}`)).status).toBe(404);
    expect((await bob.put(`/api/qr/${id}`).send({ title: 'x', contentType: 'url', content: 'https://evil.example', style: {} })).status).toBe(404);
    expect((await bob.delete(`/api/qr/${id}`)).status).toBe(404);
    expect((await bob.get(`/api/qr/${id}/export?format=png`)).status).toBe(404);
    expect((await bob.patch(`/api/links/${shortLink.id}`).send({ isActive: false })).status).toBe(404);
    expect((await bob.get(`/api/links/${shortLink.id}/stats`)).status).toBe(404);
    expect((await bob.get(`/api/links/${shortLink.id}/clicks.csv`)).status).toBe(404);
    expect((await bob.get('/api/qr?all=1')).body.total).toBe(0);
  });
});

describe('QR codes and short links', () => {
  let qrId: number;
  let code: string;
  let linkId: number;
  let encoded: string;

  it('creates a URL code that encodes its short link', async () => {
    const res = await admin.post('/api/qr').send({ title: 'Brochure', contentType: 'url', content: 'https://example.com/brochure', style: { moduleShape: 'dots' }, alias: 'brochure' });
    expect(res.status).toBe(201);
    ({ id: qrId, encodedData: encoded } = res.body.qr);
    ({ code, id: linkId } = res.body.qr.shortLink);
    expect(code).toBe('brochure');
    expect(encoded).toBe(`${BASE_URL}/short/brochure?s=qr`);
  });

  it('rejects unsafe destinations and taken or reserved names', async () => {
    for (const content of ['javascript:alert(1)', 'https://user:pw@example.com/', `${BASE_URL}/short/brochure`, 'not a url']) {
      const res = await admin.post('/api/qr').send({ title: 'x', contentType: 'url', content, style: {} });
      expect(res.status, content).toBe(400);
    }
    for (const alias of ['BROCHURE', 'api']) {
      const res = await admin.post('/api/qr').send({ title: 'x', contentType: 'url', content: 'https://example.com', style: {}, alias });
      expect(res.status, alias).toBeGreaterThanOrEqual(400);
    }
  });

  it('redirects without caching and records the click', async () => {
    const res = await request(app).get(`/short/${code}?s=qr`).set('User-Agent', IPHONE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/brochure');
    expect(res.headers['cache-control']).toBe('no-store');
    await request(app).get(`/short/${code}`).set('User-Agent', DESKTOP).set('Referer', 'https://www.linkedin.com/feed/');
    await request(app).get(`/short/${code}`).set('User-Agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)');
    await request(app).head(`/short/${code}`).set('User-Agent', DESKTOP);
    await new Promise((r) => setTimeout(r, 300)); // clicks are written after the response

    const stats = (await admin.get(`/api/links/${linkId}/stats?days=7&tz=0`)).body;
    expect(stats.totals).toMatchObject({ clicks: 2, qr: 1, direct: 1, visitors: 2 });
    expect(stats.bots).toBe(1);
    expect(stats.devices.map((d: { name: string }) => d.name).sort()).toEqual(['desktop', 'mobile']);
    expect(stats.referrers.some((r: { name: string }) => r.name === 'www.linkedin.com')).toBe(true);
  });

  it('counts a quick repeat from the same visitor once', async () => {
    await request(app).get(`/short/${code}?s=qr`).set('User-Agent', IPHONE);
    await new Promise((r) => setTimeout(r, 300));
    expect((await admin.get(`/api/links/${linkId}/stats?days=7`)).body.totals.clicks).toBe(2);
  });

  it('exports clicks as CSV with formulas neutralised', async () => {
    const res1 = await admin.post('/api/qr').send({ title: '=HYPERLINK("http://evil")', contentType: 'url', content: 'https://example.com/f', style: {} });
    const formula = res1.body.qr.shortLink;
    await request(app).get(`/short/${formula.code}`).set('User-Agent', DESKTOP);
    await new Promise((r) => setTimeout(r, 300));
    const res = await admin.get(`/api/links/${formula.id}/clicks.csv?days=7`);
    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toContain('time_utc,short_code');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('changes the destination without changing the printed symbol', async () => {
    const res = await admin.put(`/api/qr/${qrId}`).send({ title: 'Brochure v2', contentType: 'url', content: 'https://example.com/v2', style: {}, logoId: null });
    expect(res.body.qr.encodedData).toBe(encoded);
    expect((await request(app).get(`/short/${code}`)).headers.location).toBe('https://example.com/v2');
    expect((await admin.put(`/api/qr/${qrId}`).send({ title: 'x', contentType: 'text', content: 'x', style: {}, logoId: null })).status).toBe(400);
    const history = (await admin.get(`/api/links/${linkId}`)).body.history;
    expect(history[0]).toMatchObject({ field: 'target', newValue: 'https://example.com/v2' });
  });

  it('serves branded pages for disabled, expired and unknown links', async () => {
    await admin.patch(`/api/links/${linkId}`).send({ isActive: false });
    expect((await request(app).get(`/short/${code}`)).status).toBe(410);
    await admin.patch(`/api/links/${linkId}`).send({ isActive: true, expiresAt: Date.now() - 1000 });
    expect((await request(app).get(`/short/${code}`)).status).toBe(410);
    await admin.patch(`/api/links/${linkId}`).send({ expiresAt: null });
    expect((await request(app).get(`/short/${code}`)).status).toBe(302);
    const missing = await request(app).get('/short/doesNotExist');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('Link not found');
  });

  it('exports every format', async () => {
    for (const format of ['png', 'jpg', 'svg', 'pdf', 'docx']) {
      const res = await admin.get(`/api/qr/${qrId}/export?format=${format}`).buffer(true);
      expect(res.status, format).toBe(200);
      expect(res.headers['content-disposition']).toContain(`brochure-v2-${qrId}.${format}`);
    }
  });

  it('switches the link off when the code is deleted', async () => {
    await admin.delete(`/api/qr/${qrId}`);
    expect((await request(app).get(`/short/${code}`)).status).toBe(410);
    expect((await admin.get(`/api/qr/${qrId}`)).status).toBe(404);
  });

  it('enforces the admin domain policy', async () => {
    await admin.put('/api/admin/settings/links').send({ publicBaseUrl: BASE_URL, policy: { mode: 'allowlist', domains: ['example.com'] } });
    expect((await admin.post('/api/qr').send({ title: 'ok', contentType: 'url', content: 'https://shop.example.com/x', style: {} })).status).toBe(201);
    expect((await admin.post('/api/qr').send({ title: 'no', contentType: 'url', content: 'https://other.test/x', style: {} })).status).toBe(400);
    await admin.put('/api/admin/settings/links').send({ publicBaseUrl: BASE_URL, policy: { mode: 'off', domains: [] } });
  });
});

describe('logos', () => {
  it('rasterises SVG uploads (no user SVG is ever served)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>alert(1)</script><rect width="40" height="40" fill="red"/></svg>');
    const res = await admin.post('/api/qr/logos').send({ name: 'svg', dataUrl: `data:image/svg+xml;base64,${svg.toString('base64')}` });
    expect(res.status).toBe(201);
    const img = await admin.get(`/api/qr/logos/${res.body.logo.id}/image`).buffer(true);
    expect(img.headers['content-type']).toContain('image/png');
  });

  it('rejects non-images', async () => {
    expect((await admin.post('/api/qr/logos').send({ name: 'x', dataUrl: 'data:text/html;base64,PGgxPg==' })).status).toBe(400);
  });
});

describe('hardening', () => {
  it('hides version details from remote callers of /api/health', async () => {
    expect((await request(app).get('/api/health')).body.commit).toBeDefined();
    expect(Object.keys((await request(app).get('/api/health').set('X-Forwarded-For', '203.0.113.9')).body)).toEqual(['status']);
  });

  it('does not send saved secrets to a different server from the test buttons', async () => {
    const ad = { enabled: false, urls: ['ldaps://dc1.genqr.test:636'], startTls: false, rejectUnauthorized: true, caCert: '', bindDn: 'CN=svc,DC=genqr,DC=test', baseDn: 'DC=genqr,DC=test', userFilter: '(sAMAccountName={{username}})', searchFilter: '(cn=*{{query}}*)', usernameAttribute: 'sAMAccountName', displayNameAttribute: 'displayName', emailAttribute: 'mail', timeoutSeconds: 2 };
    expect((await admin.put('/api/admin/settings/ad').send({ ...ad, bindPassword: 'SavedSecret1' })).status).toBe(200);
    const probe = await admin.post('/api/admin/settings/ad/test').send({ ...ad, urls: ['ldap://attacker.example:389'] });
    expect(probe.body.steps[0].detail).toMatch(/type the bind password again/);

    const mail = { enabled: false, host: 'smtp.genqr.test', port: 587, security: 'starttls', username: 'svc@genqr.test', fromAddress: 'svc@genqr.test', fromName: 'GenQR', rejectUnauthorized: true };
    expect((await admin.put('/api/admin/settings/email').send({ ...mail, password: 'SavedSecret2' })).status).toBe(200);
    const mailProbe = await admin.post('/api/admin/settings/email/test').send({ ...mail, host: 'attacker.example', security: 'none', testRecipient: 'x@example.com' });
    expect(mailProbe.status).toBe(400);
    expect(mailProbe.body.code).toBe('PASSWORD_REQUIRED');
  });
});

describe('email', () => {
  it('is refused while switched off', async () => {
    const qr = (await admin.post('/api/qr').send({ title: 'mail', contentType: 'text', content: 'hi', style: {} })).body.qr;
    const res = await admin.post(`/api/qr/${qr.id}/email`).send({ to: ['a@b.test'], subject: 's', formats: ['png'] });
    expect(res.status).toBe(403);
    expect((await request(app).post('/api/auth/forgot').send({ login: 'admin' })).status).toBe(403);
  });
});

describe('audit log', () => {
  it('records security-relevant actions', async () => {
    const actions = (await admin.get('/api/admin/audit?limit=200')).body.items.map((i: { action: string }) => i.action);
    for (const a of ['setup.completed', 'auth.login_failed', 'user.created', 'qr.created', 'link.updated', 'qr.deleted']) expect(actions, a).toContain(a);
  });

  it('never stores passwords', async () => {
    const all = JSON.stringify((await admin.get('/api/admin/audit?limit=200')).body);
    expect(all).not.toContain(ADMIN.password);
    expect(all).not.toContain('UserPass1234');
  });
});

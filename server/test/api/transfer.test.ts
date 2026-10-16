import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnex, db, dbClient, migrateLatest } from '../../src/db/index.js';
import { copyDatabase, restoreDump, tableCounts, writeDump } from '../../src/db/transfer.js';
import { createUser, setupAdmin, startApp, stopApp } from '../helpers.js';

beforeAll(async () => {
  const app = await startApp();
  const admin = await setupAdmin(app);
  await createUser(admin, 'dana');
  for (let i = 0; i < 3; i++) await admin.post('/api/qr').send({ title: `Code ${i}`, contentType: 'url', content: `https://example.com/${i}`, style: { moduleShape: 'rounded' } });
});
afterAll(stopApp);

describe('copying between databases', () => {
  it('copies every table to an empty SQLite database with identical counts', async () => {
    const target = createKnex({ client: 'sqlite', connection: { filename: 'data/copy.db' } });
    try {
      await migrateLatest(target);
      await copyDatabase(db(), target, 'sqlite', () => {});
      expect(await tableCounts(target)).toEqual(await tableCounts(db()));
      // booleans and ids survive the copy
      const user = await target('users').where({ username: 'dana' }).first();
      expect(Boolean(user.is_active)).toBe(true);
      const ids = (await target('qr_codes').select('id').orderBy('id')).map((r) => Number(r.id));
      expect(ids).toEqual((await db()('qr_codes').select('id').orderBy('id')).map((r) => Number(r.id)));
    } finally {
      await target.destroy();
    }
  });
});

describe('SQLite location', () => {
  it('refuses database files outside the data folder', () => {
    expect(() => createKnex({ client: 'sqlite', connection: { filename: path.join(os.tmpdir(), 'elsewhere.db') } })).toThrow(/inside/);
    expect(() => createKnex({ client: 'sqlite', connection: { filename: 'data/../config/x.db' } })).toThrow(/inside/);
  });
});

describe('JSON dumps', () => {
  it(`round-trips all data on ${process.env.GENQR_TEST_DB ? 'the configured engine' : 'SQLite'}`, async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'genqr-dump-')), 'dump.json.gz');
    const before = await tableCounts(db());
    await writeDump(db(), file);
    await db()('qr_codes').update({ title: 'changed' });
    await db()('clicks').delete();
    await restoreDump(db(), dbClient(), file);
    expect(await tableCounts(db())).toEqual(before);
    expect((await db()('qr_codes').select('title')).map((r) => r.title).sort()).toEqual(['Code 0', 'Code 1', 'Code 2']);
    // new rows still get fresh ids after explicit-id inserts (sequence/identity reset)
    const [row] = await db()('audit_log').insert({ actor_name: 't', action: 'test', ts: Date.now() }, ['id']);
    expect(Number(typeof row === 'object' ? row.id : row)).toBeGreaterThan(before.audit_log!);
  });

  it('rejects files that are not GenQR dumps', async () => {
    const file = path.join(os.tmpdir(), `not-a-dump-${Date.now()}.json.gz`);
    fs.writeFileSync(file, (await import('node:zlib')).gzipSync('{"hello":1}\n'));
    await expect(restoreDump(db(), dbClient(), file)).rejects.toThrow(/Not a GenQR dump/);
  });
});

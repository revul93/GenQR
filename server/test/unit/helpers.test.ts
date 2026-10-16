import { describe, expect, it } from 'vitest';
import { escapeFilterValue } from '../../src/services/activeDirectory.js';
import { decryptSecret, encryptSecret } from '../../src/services/crypto.js';
import { escapeHtml } from '../../src/services/email.js';
import { passwordProblem } from '../../src/auth/password.js';
import { rangeFor } from '../../src/services/stats.js';

describe('LDAP filter escaping', () => {
  it('escapes RFC 4515 special characters', () => {
    expect(escapeFilterValue('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    expect(escapeFilterValue('a\\b\0')).toBe('a\\5cb\\00');
    expect(escapeFilterValue('john.doe')).toBe('john.doe');
  });
});

describe('secret encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('s3cret!');
    const b = encryptSecret('s3cret!');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('s3cret!');
  });

  it('detects tampering', () => {
    const parts = encryptSecret('value').split(':');
    parts[3] = Buffer.from('other').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('password policy', () => {
  it('requires length, letters and digits', () => {
    expect(passwordProblem('short1')).toMatch(/at least/);
    expect(passwordProblem('onlyletterslong')).toMatch(/letters and digits/);
    expect(passwordProblem('Letters12345')).toBeNull();
  });
});

describe('HTML escaping for emails', () => {
  it('escapes markup', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('stats ranges', () => {
  it('covers whole local days, including today', () => {
    const now = Date.UTC(2026, 9, 15, 22, 30); // 01:30 on 16 Oct in UTC+3
    const r = rangeFor(7, -180, now);
    expect(r.to - r.from).toBe(7 * 86400000);
    expect(new Date(r.to - 1 - 180 * -60000).toISOString().slice(0, 10)).toBe('2026-10-16');
    expect(new Date(r.from + 180 * 60000).toISOString().slice(0, 10)).toBe('2026-10-10');
  });
});

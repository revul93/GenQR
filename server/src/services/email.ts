import nodemailer from 'nodemailer';
import { z } from 'zod';
import { db } from '../db/index.js';
import { HttpError } from '../http.js';
import type { Actor } from './audit.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getSetting, setSetting } from './settings.js';

/** Outgoing email over SMTP. Admins can switch sending off entirely. */

export const EMAIL_SETTING_KEY = 'email.config';

export const emailConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  // starttls: plain connection upgraded (usually 587); tls: TLS from the start (465); none: unencrypted relay
  security: z.enum(['starttls', 'tls', 'none']),
  username: z.string().trim().max(255).default(''),
  fromAddress: z.email('Enter the sender address.'),
  fromName: z.string().trim().max(100).default('GenQR'),
  rejectUnauthorized: z.boolean().default(true),
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;
type StoredEmailConfig = EmailConfig & { passwordEnc: string | null };

const DEFAULT_CONFIG: EmailConfig = {
  enabled: false,
  host: 'smtp.gmail.com',
  port: 587,
  security: 'starttls',
  username: '',
  fromAddress: 'genqr@example.com',
  fromName: 'GenQR',
  rejectUnauthorized: true,
};

export type PublicEmailConfig = EmailConfig & { hasPassword: boolean };

async function loadStored(): Promise<StoredEmailConfig> {
  return getSetting<StoredEmailConfig>(EMAIL_SETTING_KEY, { ...DEFAULT_CONFIG, passwordEnc: null });
}

export async function getEmailConfig(): Promise<PublicEmailConfig> {
  const { passwordEnc, ...cfg } = await loadStored();
  return { ...DEFAULT_CONFIG, ...cfg, hasPassword: !!passwordEnc };
}

export async function isEmailEnabled(): Promise<boolean> {
  return (await loadStored()).enabled;
}

/** An empty/omitted password keeps the stored one. */
export async function saveEmailConfig(cfg: EmailConfig, password: string | undefined, userId: number): Promise<void> {
  const current = await loadStored();
  const passwordEnc = password ? encryptSecret(password) : current.passwordEnc;
  await setSetting(EMAIL_SETTING_KEY, { ...cfg, passwordEnc }, { userId, secret: true });
}

async function resolvePassword(override?: string): Promise<string | null> {
  if (override) return override;
  const { passwordEnc } = await loadStored();
  return passwordEnc ? decryptSecret(passwordEnc) : null;
}

function transport(cfg: EmailConfig, password: string | null) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    auth: cfg.username ? { user: cfg.username, pass: password ?? '' } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid?: string; // for inline images
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export interface LogMeta {
  kind: 'qr' | 'password_reset' | 'test';
  actor: Actor;
  qrCodeId?: number;
  formats?: string[];
}

async function writeLog(mail: OutgoingMail, meta: LogMeta, error: string | null): Promise<void> {
  await db()('email_log').insert({
    kind: meta.kind,
    qr_code_id: meta.qrCodeId ?? null,
    sent_by: meta.actor.id,
    sent_by_name: meta.actor.name,
    recipients: [...mail.to, ...(mail.cc ?? [])].join(', ').slice(0, 4000),
    subject: mail.subject.slice(0, 300),
    formats: meta.formats?.join(',') ?? null,
    status: error ? 'failed' : 'sent',
    error,
    sent_at: Date.now(),
  });
}

/** Friendlier messages for the usual SMTP failures. */
function explain(err: Error & { code?: string; responseCode?: number }): string {
  if (err.code === 'EAUTH' || err.responseCode === 535) {
    return 'The mail server rejected the username or password. For Gmail, use an app password (Google Account → Security → App passwords).';
  }
  if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'EDNS') {
    return `Could not connect to the mail server (${err.message}). Check host, port and security settings.`;
  }
  return err.message;
}

/** Sends with an explicit configuration (used by the settings "send test" button). */
async function sendWith(cfg: EmailConfig, password: string | null, mail: OutgoingMail, meta: LogMeta): Promise<void> {
  try {
    await transport(cfg, password).sendMail({
      from: { name: cfg.fromName, address: cfg.fromAddress },
      to: mail.to,
      cc: mail.cc,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: mail.attachments,
    });
    await writeLog(mail, meta, null);
  } catch (err) {
    const message = explain(err as Error);
    await writeLog(mail, meta, message);
    throw new HttpError(502, `Email could not be sent: ${message}`, 'EMAIL_FAILED');
  }
}

export async function sendMail(mail: OutgoingMail, meta: LogMeta): Promise<void> {
  const stored = await loadStored();
  if (!stored.enabled) throw new HttpError(403, 'Sending email is switched off by the administrator.', 'EMAIL_DISABLED');
  const { passwordEnc: _p, ...cfg } = stored;
  await sendWith(cfg, await resolvePassword(), mail, meta);
}

export async function sendTestEmail(cfg: EmailConfig, passwordOverride: string | undefined, to: string, actor: Actor): Promise<void> {
  if (!passwordOverride && cfg.username) {
    // Never send the saved password to a server or account other than the saved one.
    const saved = await getEmailConfig();
    if (saved.host !== cfg.host || saved.port !== cfg.port || saved.username !== cfg.username || saved.security !== cfg.security) {
      throw new HttpError(400, 'The server or username changed: type the password again to test.', 'PASSWORD_REQUIRED');
    }
  }
  const mail: OutgoingMail = {
    to: [to],
    subject: 'GenQR test email',
    text: 'This is a test email from GenQR. Your email settings work.',
    html: layout('Email settings work', '<p>This is a test email from GenQR. Your email settings work.</p>'),
  };
  await sendWith(cfg, await resolvePassword(passwordOverride), mail, { kind: 'test', actor });
}

export interface EmailLogEntry {
  id: number;
  kind: string;
  qrCodeId: number | null;
  sentByName: string;
  recipients: string;
  subject: string;
  formats: string | null;
  status: 'sent' | 'failed';
  error: string | null;
  sentAt: number;
}

export async function listEmailLog(limit: number, offset: number): Promise<{ items: EmailLogEntry[]; total: number }> {
  const totalRow = await db()('email_log').count({ n: '*' }).first();
  const rows = await db()('email_log').orderBy([{ column: 'sent_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit).offset(offset);
  return {
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      qrCodeId: r.qr_code_id == null ? null : Number(r.qr_code_id),
      sentByName: r.sent_by_name,
      recipients: r.recipients,
      subject: r.subject,
      formats: r.formats,
      status: r.status,
      error: r.error,
      sentAt: Number(r.sent_at),
    })),
  };
}

// --- Message helpers --------------------------------------------------------------------

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, email-client-safe HTML wrapper. `body` must already be escaped. */
export function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="background:#0b5394;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0">GenQR</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.5"><h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${body}</td></tr>
</table></td></tr></table></body></html>`;
}

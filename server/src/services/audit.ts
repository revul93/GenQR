import type { Knex } from 'knex';
import { db } from '../db/index.js';

export interface Actor {
  id: number | null;
  name: string;
}

export const SYSTEM_ACTOR: Actor = { id: null, name: 'system' };

export const actorOf = (user: { id: number; username: string }): Actor => ({ id: user.id, name: user.username });

export interface AuditEvent {
  actor: Actor;
  action: string;
  entityType?: string;
  entityId?: string | number;
  details?: unknown;
  ip?: string | null;
}

export async function audit(event: AuditEvent, trx: Knex | Knex.Transaction = db()): Promise<void> {
  try {
    await trx('audit_log').insert({
      actor_id: event.actor.id,
      actor_name: event.actor.name,
      action: event.action,
      entity_type: event.entityType ?? null,
      entity_id: event.entityId == null ? null : String(event.entityId),
      details: event.details == null ? null : JSON.stringify(event.details),
      ip: event.ip ?? null,
      ts: Date.now(),
    });
  } catch (err) {
    // Auditing must never break the action being audited.
    console.error('Failed to write audit log entry', event.action, err);
  }
}

export interface AuditEntry {
  id: number;
  actorId: number | null;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ip: string | null;
  ts: number;
}

export async function listAudit(opts: { limit: number; offset: number; search?: string }): Promise<{ items: AuditEntry[]; total: number }> {
  const base = db()('audit_log');
  if (opts.search) {
    const term = `%${opts.search.toLowerCase()}%`;
    base.where((q) => q.whereRaw('LOWER(action) LIKE ?', [term]).orWhereRaw('LOWER(actor_name) LIKE ?', [term]));
  }
  const totalRow = await base.clone().count({ n: '*' }).first();
  const rows = await base.clone().orderBy([{ column: 'ts', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(opts.limit).offset(opts.offset);
  return {
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id == null ? null : Number(r.actor_id),
      actorName: r.actor_name,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details ? JSON.parse(r.details) : null,
      ip: r.ip,
      ts: Number(r.ts),
    })),
  };
}

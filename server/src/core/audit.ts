import type { ContrailDb } from './db.js';
import type { AuditEvent } from './types.js';
import { log } from './log.js';

/**
 * Every executed write, approval, refusal, and connection lifecycle change
 * emits an AuditEvent to the local log (spec §5). Audit failures never block
 * the operation they describe — they log to stderr instead.
 */
export type AuditEventType =
  | 'connection.created'
  | 'connection.reauthorized'
  | 'connection.grants_changed'
  | 'connection.removed'
  | 'oauth.flow_started'
  | 'oauth.flow_completed'
  | 'oauth.flow_failed'
  | 'oauth.flow_superseded'
  | 'oauth.callback_refused'
  | 'local_request.refused'
  | 'grant.refused'
  | (string & {});

export class AuditLog {
  constructor(private readonly db: ContrailDb) {}

  record(
    eventType: AuditEventType,
    input: {
      connectionId?: string | null;
      tool?: string | null;
      outcome?: 'success' | 'refused' | 'error';
      detail?: Record<string, unknown> | null;
    } = {},
  ): void {
    try {
      this.db.insertAuditEvent({
        eventType,
        connectionId: input.connectionId ?? null,
        tool: input.tool ?? null,
        outcome: input.outcome ?? 'success',
        detail: input.detail ?? null,
      });
    } catch (err) {
      log('error', 'audit event write failed', { eventType, err: String(err) });
    }
  }

  query(filter: { connectionId?: string; since?: string; limit?: number }): AuditEvent[] {
    return this.db.queryAuditEvents(filter);
  }
}

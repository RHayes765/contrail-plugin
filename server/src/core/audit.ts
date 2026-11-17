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
  // S45: the execute-time "target moved" guard voided a code (per kind), the
  // guard could not re-read the org and the write proceeded unverified, the
  // revert package was written / swept, and the validate-time sweep expired
  // stale codes.
  | 'deploy.target_moved'
  | 'dml.target_moved'
  | 'activation.target_moved'
  | 'deploy.target_check_unavailable'
  | 'deploy.revert_written'
  | 'deploy.revert_swept'
  | 'deploy.expired'
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

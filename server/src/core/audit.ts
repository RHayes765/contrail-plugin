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
  // S46 (governance): a proposal, a deploy mint, an agent test-run start or
  // an execute was refused by policy; the human recorded an emergency reason
  // during a freeze; an engine saw a policies fingerprint no engine on this
  // database had recorded; the human saved a different justification; a
  // change-evidence dossier was written.
  | 'policy.refused'
  | 'policy.freeze_overridden'
  | 'policy.config_seen'
  | 'approval.justification_edited'
  | 'evidence.exported'
  // S46 (re-baseline): a member-scoped snapshot refresh finished or failed,
  // and the post-deploy re-read did not run or did not finish.
  | 'snapshot.members_refreshed'
  | 'snapshot.members_refresh_failed'
  | 'deploy.snapshot_rebaseline_unavailable'
  | (string & {});

/**
 * What the audit log can be filtered by. `requestId` keeps the events whose
 * detail names that request; `eventType` is one type, or every type under a
 * prefix ending in a dot (`policy.`); `until` is inclusive.
 */
export interface AuditQueryFilter {
  connectionId?: string;
  since?: string;
  until?: string;
  requestId?: string;
  eventType?: string;
  limit?: number;
}

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

  query(filter: AuditQueryFilter): AuditEvent[] {
    return this.db.queryAuditEvents(filter);
  }
}

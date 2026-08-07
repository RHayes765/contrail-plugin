import { GrantDeniedError } from './errors.js';
import { TOOL_GRANT_MAP, type Grant } from './grants.js';
import type { ConnectionRecord } from './types.js';
import type { AuditLog } from './audit.js';

/**
 * The layer-2 gate: independently classifies every operation by tool name
 * and refuses anything outside the connection's grants. Called by every
 * granted tool before doing any work; refusals are audited.
 */
export function assertGrant(
  connection: ConnectionRecord,
  tool: string,
  audit: AuditLog,
): void {
  if (!(tool in TOOL_GRANT_MAP)) {
    // Unclassified tools are refused outright — a tool must be classified
    // before it can run against any org.
    audit.record('grant.refused', {
      connectionId: connection.id,
      tool,
      outcome: 'refused',
      detail: { reason: 'tool_not_classified' },
    });
    throw new GrantDeniedError(connection.alias, '(unclassified)', tool);
  }
  const required: Grant | null = TOOL_GRANT_MAP[tool] ?? null;
  if (required === null) return;
  if (!connection.grants[required]) {
    audit.record('grant.refused', {
      connectionId: connection.id,
      tool,
      outcome: 'refused',
      detail: { required },
    });
    throw new GrantDeniedError(connection.alias, required, tool);
  }
}

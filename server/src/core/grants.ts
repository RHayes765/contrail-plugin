/**
 * The five-grant permission model (spec §3). Grants are per-connection,
 * set by a human on the localhost management page only, and enforced
 * server-side here — the layer-2 gate. The model can never choose or
 * change its own permissions.
 */

export const GRANTS = [
  'metadata_read',
  'metadata_write',
  'diagnostics_read',
  'data_read',
  'data_write',
] as const;

export type Grant = (typeof GRANTS)[number];
export type GrantSet = Record<Grant, boolean>;

/** write grants require their corresponding read grant */
export const GRANT_DEPENDENCIES: Readonly<Partial<Record<Grant, Grant>>> = {
  metadata_write: 'metadata_read',
  data_write: 'data_read',
};

export const GRANT_DESCRIPTIONS: Readonly<Record<Grant, string>> = {
  metadata_read:
    'Read metadata: retrieve flows, Apex, objects/fields; search, diff, and dependency analysis.',
  metadata_write:
    'Validate and execute metadata deploys. Requires metadata_read. Every deploy requires explicit human confirmation.',
  diagnostics_read:
    'Read debug logs and flow error details, run Apex tests (test transactions always ' +
    'roll back), and set trace flags. May expose incidental record data present in logs.',
  data_read: 'Run SOQL queries and read records (row-capped).',
  data_write:
    'Propose and execute DML and anonymous Apex scripts. Requires data_read. Every write ' +
    'requires explicit human confirmation.',
};

export function emptyGrantSet(): GrantSet {
  return {
    metadata_read: false,
    metadata_write: false,
    diagnostics_read: false,
    data_read: false,
    data_write: false,
  };
}

export function isGrant(value: string): value is Grant {
  return (GRANTS as readonly string[]).includes(value);
}

/** Parse an untrusted object (form post, stored JSON) into a strict GrantSet. */
export function normalizeGrants(input: unknown): GrantSet {
  const out = emptyGrantSet();
  if (input && typeof input === 'object') {
    for (const grant of GRANTS) {
      // Own properties only — never values inherited via the prototype chain.
      if (!Object.hasOwn(input, grant)) continue;
      const v = (input as Record<string, unknown>)[grant];
      out[grant] = v === true || v === 'true' || v === 'on' || v === 1;
    }
  }
  return out;
}

/**
 * Returns human-readable violations ([] means valid). Enforced server-side
 * on every save — the completion page mirrors this client-side but is not
 * trusted.
 */
export function grantDependencyViolations(grants: GrantSet): string[] {
  const violations: string[] = [];
  for (const [dependent, required] of Object.entries(GRANT_DEPENDENCIES) as [Grant, Grant][]) {
    if (grants[dependent] && !grants[required]) {
      violations.push(`${dependent} requires ${required}`);
    }
  }
  return violations;
}

export function grantedList(grants: GrantSet): Grant[] {
  return GRANTS.filter((g) => grants[g]);
}

export function notGrantedList(grants: GrantSet): Grant[] {
  return GRANTS.filter((g) => !grants[g]);
}

/**
 * Every tool maps to exactly one required grant (or null for zero-cost /
 * lifecycle tools). The server refuses anything outside the connection's
 * grants; this table is the single source of truth for that classification.
 * Tools arriving in later milestones are classified here as they land.
 */
export const TOOL_GRANT_MAP: Readonly<Record<string, Grant | null>> = {
  connect_org: null,
  disconnect_org: null,
  manage_connection: null,
  list_connections: null,
  get_permissions: null,
  get_audit_log: null,
  list_metadata: 'metadata_read',
  retrieve_metadata: 'metadata_read',
  describe_schema: 'metadata_read',
  search_metadata: 'metadata_read',
  get_dependencies: 'metadata_read',
  refresh_snapshot: 'metadata_read',
  // Diff tools are gated per connection — BOTH sides must hold the grant.
  diff_orgs: 'metadata_read',
  diff_artifact: 'metadata_read',
  // Org-state investigation: drift vs the snapshot, and Setup's own audit
  // trail — config-change history is metadata-class information.
  get_org_changes: 'metadata_read',
  get_setup_audit: 'metadata_read',
  soql_query: 'data_read',
  get_record: 'data_read',
  // Resolved entirely from permission sobjects the data API already exposes
  // to data_read — the tool adds interpretation, not new reach.
  explain_access: 'data_read',
  get_debug_logs: 'diagnostics_read',
  run_apex_tests: 'diagnostics_read',
  get_flow_errors: 'diagnostics_read',
  validate_deploy: 'metadata_write',
  execute_deploy: 'metadata_write',
  deactivate_flow: 'metadata_write',
  dml_propose: 'data_write',
  dml_execute: 'data_write',
  apex_propose: 'data_write',
  apex_execute: 'data_write',
  set_trace_flag: 'diagnostics_read',
};

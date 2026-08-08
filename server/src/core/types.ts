import type { GrantSet } from './grants.js';

export type OrgType = 'production' | 'sandbox' | 'developer' | 'trial' | 'unknown';

/**
 * A stored org connection. Tokens are never part of this record — the
 * refresh token lives in the OS keychain under the connection id.
 */
export interface ConnectionRecord {
  /** Stable UUID; keychain alias and audit references point at this. */
  id: string;
  /** Future multi-workspace support (main spec schema discipline); 'default' in Phase 0. */
  workspaceId: string;
  /** Human-chosen label, unique; how the agent names the org. */
  alias: string;
  instanceUrl: string;
  /** Login endpoint the OAuth flow ran against (needed for refresh + revoke). */
  loginUrl: string;
  orgId: string;
  orgName: string | null;
  orgType: OrgType;
  isSandbox: boolean;
  username: string | null;
  userId: string | null;
  grants: GrantSet;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** One indexed metadata artifact from a snapshot (or a child, e.g. a field of an object). */
export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  /** Metadata type: ApexClass, ApexTrigger, Flow, CustomObject, CustomField, ValidationRule, CustomLabel, ... */
  type: string;
  /** Full API name; children are dotted (Account.MyField__c). */
  apiName: string;
  /** Path within the snapshot's current/ tree holding the source (parent file for children). */
  filePath: string | null;
  contentHash: string | null;
  lastModifiedDate: string | null;
  lastModifiedBy: string | null;
  retrievedAt: string;
}

export interface DependencyEdge {
  connectionId: string;
  /** The artifact that references... */
  fromType: string;
  fromName: string;
  /** ...the artifact being referenced. */
  toType: string;
  toName: string;
  /** 'org' = MetadataComponentDependency API; 'extractor' = Contrail's own reference extractor. */
  source: 'org' | 'extractor';
}

/** A validated write awaiting (or past) human approval — deploys and DML share the table. */
export interface DeployRequestRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  kind: 'deploy' | 'dml';
  confirmationCode: string;
  status:
    | 'validated'
    | 'executing'
    | 'executed'
    | 'expired'
    | 'superseded'
    | 'execution_failed'
    | 'locked';
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  /** Deploy zip on disk (deploys). */
  payloadPath: string | null;
  /** Proposed records JSON (DML). */
  payloadJson: string | null;
  summaryJson: string;
  validationId: string | null;
  /** Execution outcome JSON, set once terminal, so late polls still get the result. */
  resultJson: string | null;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  ts: string;
  eventType: string;
  connectionId: string | null;
  tool: string | null;
  outcome: 'success' | 'refused' | 'error';
  detail: Record<string, unknown> | null;
}

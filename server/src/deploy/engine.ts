import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContrailDb } from '../core/db.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type {
  ArtifactRecord,
  ConnectionRecord,
  DeployRequestKind,
  DeployRequestRecord,
} from '../core/types.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { SnapshotStore } from '../snapshot/store.js';
import {
  MetadataSoapClient,
  type DeployResult,
  type FileProperties,
  type TestLevel,
} from '../salesforce/metadataSoap.js';
import {
  RestClient,
  stripAttributes,
  type CompositeSubrequest,
  type CompositeSubresponse,
} from '../salesforce/rest.js';
import {
  abortIngestJob,
  closeIngestJob,
  createIngestJob,
  fetchFailedResults,
  fetchSuccessfulResults,
  fetchUnprocessedRecords,
  getIngestJob,
  isTerminalIngestState,
  uploadIngestBatch,
  type IngestJobInfo,
  type IngestOperation,
} from '../salesforce/bulk.js';
import { scanCsv, UTF8_BOM } from './csv.js';

// ── bulk data loads ──────────────────────────────────────────────────────

/**
 * One step of a bulk load plan. The engine receives sourcePath already
 * AUTHORIZED by the calling surface (plugin: resolveSourcePath containment;
 * desktop: linked-folder resolution keyed on the session's own project) — the
 * engine re-stats and size-caps as defense in depth, but the authorization
 * decision belongs to whichever surface matched the path.
 */
export interface BulkLoadStep {
  /** Absolute path to the CSV; read ONCE at propose and frozen. */
  sourcePath: string;
  /** What the human sees on the approval page (path or folder/relPath). */
  displayName: string;
  object: string;
  operation: IngestOperation;
  /** Required for upsert ('Id' spells update); forbidden for insert/delete. */
  externalIdField?: string;
}

export interface BulkLoadInput {
  /** true (default): a step with failed rows halts the remaining steps. */
  stopOnFailure: boolean;
  steps: BulkLoadStep[];
}

/** The frozen-payload manifest stored in payload_json (files relative to the payload dir). */
interface BulkManifest {
  bulk: true;
  version: 1;
  stop_on_failure: boolean;
  steps: Array<{
    n: number;
    object: string;
    operation: IngestOperation;
    external_id_field: string | null;
    file: string;
    display_name: string;
    sha256: string;
    row_count: number;
    headers: string[];
    line_ending: 'LF' | 'CRLF';
    /** S40: absent on pre-S40 manifests — treat as COMMA. */
    column_delimiter?: 'COMMA' | 'TAB';
    bytes: number;
  }>;
}

// ── multi-step DML plans ─────────────────────────────────────────────────

/**
 * One step of an ordered DML plan. Later steps may cite an EARLIER insert
 * step's created id with the token "@{ref.id}" (whole-value only) — in field
 * values, or as the id of an update/delete. The token is passed to Salesforce
 * verbatim; the org's Composite API substitutes the real id server-side, so
 * the id never round-trips through the agent.
 */
export interface DmlPlanStep {
  /** Optional handle for this step's created id; /^[A-Za-z][A-Za-z0-9_]*$/, unique. */
  ref?: string;
  operation: 'insert' | 'update' | 'delete';
  object: string;
  /** insert/update: the field map (never contains Id — the target is `id`). */
  record?: Record<string, unknown>;
  /** update/delete: a literal record id or "@{ref.id}". */
  id?: string;
}

/** The plan shape stored verbatim in payload_json (discriminated by `plan`). */
export interface DmlPlanInput {
  plan: true;
  version: 2;
  all_or_none: boolean;
  steps: DmlPlanStep[];
}

export interface DmlFlatInput {
  operation: 'insert' | 'update' | 'delete';
  object: string;
  records?: Array<Record<string, unknown>>;
  ids?: string[];
}

export type DmlInput = DmlFlatInput | DmlPlanInput;

export function isDmlPlan(input: DmlInput): input is DmlPlanInput {
  return (input as DmlPlanInput).plan === true;
}

/** The whole value must be the token — a token embedded in prose is a mistake. */
export const REF_TOKEN_RE = /^@\{([A-Za-z][A-Za-z0-9_]*)\.id\}$/;

/** The org-side referenceId for step i (explicit ref wins; tokens may only cite explicit refs). */
function stepReferenceId(step: DmlPlanStep, index: number): string {
  return step.ref ?? `step_${index + 1}`;
}
import { queryDependencies } from '../deps/graph.js';
import {
  NOT_COVERED,
  collectObjectAutomation,
  parseApexObjectTargets,
  type ObjectAutomation,
} from '../deps/automation.js';
import { deploysDir, stagingDir } from '../core/paths.js';
import { ContrailError } from '../core/errors.js';
import { generateConfirmationCode } from './codes.js';
import { ApprovalPageServer } from './approval.js';
import {
  renderApprovalPage,
  type ApprovalPageOptions,
  type ApprovalRowDiff,
} from '../connect/pages.js';
import { diffText, semanticDiff, type Change, type DiffLimits } from '../diff/semantic.js';
import {
  buildPreImageListQueries,
  finalizeRevertPackage,
  hhmm,
  listedPropFor,
  preImageKey,
  preImageListQueryFor,
  retrievePreImages,
  revertDirFor,
  summarizePreImage,
  targetMovedRefusalText,
  writeRevertPreImages,
  type DeployMovedMember,
  type PreImage,
  type PreImageResult,
  type RevertPlan,
  type RevertPlanMember,
  type RevertPlanReason,
  type RevertPreImageEntry,
  type RevertTargetCheck,
  type RevertWriteResult,
} from './preimage.js';
import {
  NullNotifier,
  describePhoneOutcome,
  type ApprovalNotifier,
  type NotifyOutcome,
  type PhoneNotification,
} from '../core/notify.js';
import {
  AURA_DEFTYPE_FILES,
  analyzeChanges,
  analyzePermissionCoverage,
  auraBundleReferenced,
  buildDeployZip,
  changeDependentWarnings,
  deployZipEntryPath,
  isRegisteredType,
  parseEnvelopeFor,
  readBundleFiles,
  readOldContent,
  retrieveMemberFor,
  type ComponentChange,
  type ProposedComponent,
  type ProposedDeletion,
} from './package.js';
import { log } from '../core/log.js';

/**
 * The write pipeline (spec §5): every deploy and every DML change is a
 * two-step — validate/propose computes the full consequence summary, issues a
 * confirmation code on the human-only approval page, and only the human
 * reading that code back arms execution. Codes are single-use, expire, and
 * die on re-validation. Every decision lands in the audit log.
 */

export interface DeployValidationSummary {
  connection: string;
  org_type: string;
  /** null on a dry run — no approval request exists, nothing is executable. */
  request_id: string | null;
  validation_id: string;
  /** null = unspecified — the org applied its own default test behavior. */
  test_level: TestLevel | null;
  changes: ComponentChange[];
  destructive: ComponentChange[];
  components_total: number;
  component_errors: number;
  tests_run: number;
  test_failures: number;
  test_failure_detail: unknown;
  code_coverage_warnings: string[];
  blast_radius: string[];
  /** Advisory: new components that will be invisible/inaccessible without permissions. */
  permission_warning: string | null;
  /** null on a dry run — there is no code to expire. */
  expires_at: string | null;
  /**
   * S45: the live pre-image check the classifications and the approval
   * page's diffs rest on. null on a dry run — no retrieve is issued.
   */
  live_check: LiveCheckSummary | null;
}

/**
 * S45: the validate-time live check as persisted in summaryJson (and handed
 * to the agent). `status: 'unavailable'` means the RETRIEVE failed — the org
 * was not re-read and everything on the page came from the local snapshot;
 * a listing fault only nulls dates (dates_unavailable_types /
 * dates_unavailable). `org_clock` carries the checkOnly DeployResult's
 * org-side stamps — the execute-time guard's clock when no live baseline
 * exists. The diffs themselves are NOT persisted (they would ride every
 * execute result); they live on the approval page's rows.
 */
export interface LiveCheckSummary {
  status: 'ok' | 'unavailable';
  /** 'timeout' | 'cancelled' | 'retrieve_failed:<message>' — unavailable only. */
  reason?: string;
  started_at: string;
  at: string;
  org_clock?: { created_date: string; completed_date?: string };
  dates_unavailable_types: string[];
  dates_unavailable?: string;
  /** Package members (components + deletions) the live check covered. */
  members: number;
}

type JobOutcome<T> =
  | { status: 'complete'; result: T }
  | { status: 'failed'; error: string }
  | { status: 'in_progress'; progress: string; started_at: string };

type ValidateInput = {
  components: ProposedComponent[];
  destructive: ProposedDeletion[];
  /** Omitted = the ORG's default behavior (prod refuses an explicit NoTestRun). */
  testLevel?: TestLevel;
  runTests: string[];
  /**
   * S41 (§3.15): required true for a destructive member whose type Contrail
   * cannot read — the delete then proceeds with the UNREGISTERED TYPE
   * DELETE warning instead of being refused.
   */
  allowUnregisteredDelete?: boolean;
  /**
   * S38: true = org-side validation ONLY. No approval request, code,
   * payload, or page is created, nothing becomes executable, and any
   * PENDING request on the connection is left untouched (a normal
   * validate supersedes it). Mid-build checks use this; the final
   * validate omits it so the human sees exactly one meaningful approval.
   */
  dryRun?: boolean;
};

type ValidateResult = {
  summary: DeployValidationSummary | null;
  validation_passed: boolean;
  failure?: Record<string, unknown>;
  approval: Record<string, unknown> | null;
};

/** Finished-but-never-collected jobs are swept after this long. */
const STALE_JOB_MS = 30 * 60_000;

/**
 * S45 F2: the execute-time "target moved" guard's budget for its org read. A
 * hung SOAP/REST call must not delay an approved write for minutes — past
 * this the guard reports the check unavailable and (Ryley's fail-open
 * decision, 2026-11-14) the write proceeds with the disclosure.
 */
const TARGET_CHECK_DEADLINE_MS = 15_000;

/**
 * S45 F2: the degrade path's ordering allowance. With no live baseline from
 * validate, a member last modified at or after the checkOnly deploy's
 * org-side creation stamp minus this margin counts as moved — both stamps
 * are the org's, so this orders two org events; it is not a clock-skew guess.
 */
const ORG_CLOCK_MARGIN_MS = 5_000;

/**
 * S45 F1: a child whose snapshot row carries its CONTAINER's stamp is judged
 * by comparing its live (ORG-clock) stamp with the snapshot's retrievedAt,
 * which is the HOST's clock. Unlike the margin above, this one IS a
 * clock-skew allowance: only a stamp more than this far after the snapshot
 * earns the attributed CHANGED IN TARGET warning; within it, the row falls
 * back to the byte comparison and the neutral note.
 */
const CHILD_STAMP_MARGIN_MS = 60_000;

/** S45 F2: the guard's verdict on an anonymous Apex result — a script has no fixed target to re-read. */
const TARGET_CHECK_NOT_APPLICABLE = {
  status: 'not_applicable',
  note: 'no fixed org target to re-check',
} as const;

/**
 * S45 F2: the guard's verdict on a bulk-load result. A bulk update or delete
 * step does target specific record Ids — Contrail does not re-check them
 * because the approval page showed no current values to compare against.
 */
const TARGET_CHECK_NOT_APPLICABLE_BULK = {
  status: 'not_applicable',
  note:
    'bulk loads are not re-checked before executing — the approval page showed no current ' +
    'values for their rows, so there is nothing to compare against',
} as const;

/**
 * S45 F2: the unchecked reasons that mean "no baseline was recorded to
 * compare against" — as opposed to a member the guard could not compare
 * (an unenumerable type, a stamp missing at validate). When EVERY member is
 * unchecked for one of these and none was checked, the target_check status
 * is 'not_checked'.
 */
const NO_BASELINE_REASONS = new Set([
  'live_check_unavailable_no_org_clock',
  'no_precheck_recorded',
  'precheck_failed_at_propose',
  'no_baseline_recorded',
]);

/**
 * S45 F2: unchecked reasons whose member WAS compared for existence — a DML
 * record the preview returned whose approval showed no before-value: the
 * re-query proved it still exists, there was just no value to compare. Such
 * a member counts as a comparison, so it alone never makes 'not_checked'.
 */
const EXISTENCE_CHECKED_REASONS = new Set(['no_before_value_shown']);

/** The generic 'not_checked' note: members were named, none could be compared. */
const NOTHING_COMPARED_NOTE =
  "No member could be compared (each one's reason is under unchecked), so this write ran " +
  'without a target check.';

/**
 * S45 F2: does this target_check name members of which none was compared?
 * Every unchecked reason is a no-baseline one → 'no_baseline'; otherwise
 * (an unenumerable type, a stamp missing at validate, a record not found at
 * propose…) → 'nothing_compared'. null when at least one member was compared.
 */
function nothingComparedReason(
  checked: unknown[],
  unchecked: Array<{ reason: string }>,
): 'no_baseline' | 'nothing_compared' | null {
  if (checked.length > 0 || unchecked.length === 0) return null;
  if (unchecked.some((u) => EXISTENCE_CHECKED_REASONS.has(u.reason))) return null;
  return unchecked.every((u) => NO_BASELINE_REASONS.has(u.reason))
    ? 'no_baseline'
    : 'nothing_compared';
}

/**
 * S45 F2: the target_check a probe reports when nothing moved. Every shape
 * carries an explicit status:
 *   'ok'             — the guard ran and passed: at least one member was
 *                      compared and none had moved — {checked_at, checked,
 *                      unchecked} (unchecked names the members it could not
 *                      compare);
 *   'not_checked'    — members were named but NONE could be compared: no
 *                      baseline existed (a deploy validated with the live
 *                      check unavailable and no org clock, or before S45; a
 *                      DML whose propose recorded no before-values; an
 *                      activation with no starting status — the caller's
 *                      note), or every member was unchecked for its own
 *                      reason (types the org cannot enumerate, stamps
 *                      unavailable at validate, records not found at
 *                      propose — the generic note);
 *   'unavailable'    — the guard's own org read failed or hit its deadline
 *                      (built in preflightTargetMoved — fail-open);
 *   'not_applicable' — apex, a DML insert: nothing fixed to re-read; bulk:
 *                      not re-checked (no current values were shown).
 * The desktop's "executed without a target check" notice keys on status
 * 'unavailable' OR 'not_checked' — both mean the write ran unverified.
 */
function targetCheckOf(
  checkedAt: string,
  checked: unknown[],
  unchecked: Array<{ reason: string }>,
  noBaselineNote: string,
): Record<string, unknown> {
  const nothing = nothingComparedReason(checked, unchecked);
  if (nothing === null) return { status: 'ok', checked_at: checkedAt, checked, unchecked };
  return {
    status: 'not_checked',
    checked_at: checkedAt,
    checked,
    unchecked,
    note: nothing === 'no_baseline' && noBaselineNote ? noBaselineNote : NOTHING_COMPARED_NOTE,
  };
}

/**
 * S45 F2: what the deploy-exec job body resolves to. The body never throws
 * for an outcome it understands — runJob would turn a rejection into
 * {status:'failed'}, rendered "Deploy errored" for something that did not
 * run — so a claim refusal travels back as a value and is re-thrown by
 * executeDeploy exactly as the synchronous path throws it.
 */
type DeployExecStep =
  | { kind: 'result'; result: Record<string, unknown> }
  | { kind: 'refused'; error: ContrailError }
  | { kind: 'running' };

/**
 * S45 F2: the execute-time guard's verdict. `proceed` carries the
 * target_check the result reports (a pass list, or the fail-open
 * `unavailable` disclosure); `moved` carries the terminal result — the
 * request is already voided, its payload removed and the refusal audited;
 * `lost_race` means the void found the request no longer 'validated'
 * (another caller claimed or voided it first) — claimCode decides.
 */
type TargetGuardOutcome =
  | { verdict: 'proceed'; targetCheck: Record<string, unknown> }
  | { verdict: 'moved'; result: Record<string, unknown> }
  | { verdict: 'lost_race' };

/** What one kind's org read concluded: a terminal moved result, or the pass list. */
type TargetProbe = {
  moved: Record<string, unknown> | null;
  targetCheck: Record<string, unknown>;
  /** The `<kind>.target_moved` audit detail (names and counts only — no field values). */
  audit: Record<string, unknown>;
};

/**
 * S41 (§3.1): a validation job's identity is a digest of exactly what will
 * be validated — resolved component content included — plus every option
 * that changes the outcome. Keying by input instead of by connection means
 * a caller can only ever collect the result of ITS OWN validation; two
 * concurrent dry runs, a dry run beside a real validate (the S38 split now
 * rides the id prefix), or two sessions' validations never cross-deliver.
 * Re-sending identical arguments attaches to the running job, so the old
 * poll-by-resend pattern still works.
 */
function validateJobId(input: ValidateInput): string {
  const h = crypto.createHash('sha256');
  // Every record is a JSON-framed array: field boundaries survive any
  // characters a name or option could carry, so no two distinct inputs can
  // collide into one digest stream via crafted separators.
  h.update(
    `${JSON.stringify([
      input.dryRun === true,
      input.testLevel ?? null,
      input.runTests ?? null,
      input.allowUnregisteredDelete === true,
    ])}\n`,
  );
  for (const c of input.components) {
    const contentSha = crypto.createHash('sha256').update(c.content).digest('hex');
    h.update(`${JSON.stringify(['C', c.type, c.api_name, contentSha])}\n`);
  }
  for (const d of input.destructive) h.update(`${JSON.stringify(['D', d.type, d.api_name])}\n`);
  return `${input.dryRun ? 'vdry' : 'val'}-${h.digest('hex').slice(0, 12)}`;
}

/**
 * Fired once per SUCCESSFULLY executed request, after the terminal row is
 * written and — critically — BEFORE the frozen payload is deleted, so an
 * observer can still read the exact deployed bytes (a zip for deploys, a
 * directory of CSVs for bulk loads; null for dml/apex, whose payload is the
 * row itself). The desktop app hooks this to build the project manifest; the
 * plugin leaves it unset. Observers are best-effort: a throw is swallowed
 * and audited, and can never alter the execution result.
 */
export type ExecutionObserver = (info: {
  request: DeployRequestRecord;
  payload: Record<string, unknown>;
  payloadPath: string | null;
}) => void;

interface Job<T> {
  promise: Promise<T>;
  progress: string;
  startedAt: string;
  done: boolean;
  finishedAt?: number;
  result?: T;
  error?: string;
}

export class DeployEngine {
  private readonly jobs = new Map<string, Job<unknown>>();
  private executionObserver: ExecutionObserver | null = null;
  private notifier: ApprovalNotifier = new NullNotifier();

  /**
   * S42: register the approval notifier (the phone push of a freshly minted
   * code). A setter for the same reason as setExecutionObserver: the real
   * notifier needs the TokenStore, which the engine deliberately never holds.
   * Unset = notifications off, so every existing construction keeps working.
   */
  setApprovalNotifier(notifier: ApprovalNotifier): void {
    this.notifier = notifier;
  }

  /**
   * Best-effort phone delivery of a just-presented approval. Fired AFTER the
   * page exists, bounded by the notifier's own timeout, never allowed to fail
   * the proposal. Audit rows carry outcome categories only — never the code,
   * never a key. `mode: 'native'` (the desktop's in-app review) sends the
   * summary WITHOUT the code: there is nowhere to type it.
   */
  private async notifyApproval(
    view: ApprovalPageOptions,
    requestId: string,
    connectionId: string,
    mode: 'page' | 'native',
  ): Promise<PhoneNotification> {
    let outcome: NotifyOutcome;
    try {
      outcome = await this.notifier.notify(view, { includeCode: mode === 'page' });
    } catch (err) {
      // Category only: a notifier's error MESSAGE could carry the code, and
      // this seam exists to keep the code out of every log line.
      log('warn', 'approval notifier threw; treating as not delivered', {
        err: err instanceof Error ? err.name : typeof err,
      });
      outcome = { status: 'failed', reason: 'network' };
    }
    if (outcome.status === 'sent') {
      this.audit.record('approval.notified', {
        connectionId,
        tool: proposeToolFor(view.kind),
        detail: { requestId, kind: view.kind, method: 'pushover', codeIncluded: mode === 'page' },
      });
    } else if (outcome.status === 'failed') {
      this.audit.record('approval.notify_failed', {
        connectionId,
        tool: proposeToolFor(view.kind),
        outcome: 'error',
        detail: { requestId, kind: view.kind, reason: outcome.reason },
      });
    } else if (outcome.status === 'skipped') {
      // S43: the notifier held the push back on purpose (Remote Control gate).
      this.audit.record('approval.notify_skipped', {
        connectionId,
        tool: proposeToolFor(view.kind),
        detail: { requestId, kind: view.kind, reason: outcome.reason },
      });
    }
    return describePhoneOutcome(outcome, { includeCode: mode === 'page' });
  }

  /**
   * Register the (single) execution observer. A setter rather than a ctor
   * argument because the observing service is constructed after the engine
   * in every bootstrap.
   */
  setExecutionObserver(obs: ExecutionObserver): void {
    this.executionObserver = obs;
  }

  /** Best-effort observer dispatch — never allowed to touch the outcome. */
  private notifyExecuted(request: DeployRequestRecord, payload: Record<string, unknown>): void {
    if (!this.executionObserver) return;
    try {
      this.executionObserver({ request, payload, payloadPath: request.payloadPath ?? null });
    } catch (err) {
      this.audit.record('deploy.observer_failed', {
        connectionId: request.connectionId,
        tool: 'execution_observer',
        outcome: 'error',
        detail: { requestId: request.id, error: String(err).slice(0, 500) },
      });
    }
  }

  constructor(
    private readonly db: ContrailDb,
    private readonly store: SnapshotStore,
    private readonly tokenMgr: AccessTokenManager,
    private readonly config: ContrailConfig,
    private readonly audit: AuditLog,
    private readonly approvals: ApprovalPageServer = new ApprovalPageServer(),
  ) {}

  // ── deploys ────────────────────────────────────────────────────────────

  async validateDeploy(
    conn: ConnectionRecord,
    input: ValidateInput,
  ): Promise<JobOutcome<ValidateResult> & { job_id: string }> {
    // S41 (§3.1): keyed by INPUT, never by connection alone — see
    // validateJobId. The S38 dry/real split is part of the id.
    const jobId = validateJobId(input);
    const outcome = await this.runJob(`${conn.id}:${jobId}`, () => this.doValidate(conn, input));
    return { ...outcome, job_id: jobId };
  }

  /**
   * S41 (§3.1): attach to a validation job by its id — polling without
   * re-sending components or re-reading content files. Returns null when no
   * running or uncollected job with that id exists for this connection.
   */
  async pollValidate(
    conn: ConnectionRecord,
    jobId: string,
  ): Promise<(JobOutcome<ValidateResult> & { job_id: string }) | null> {
    const key = `${conn.id}:${jobId}`;
    const existing = this.jobs.get(key);
    if (!existing) return null;
    // runJob attaches to the stored job (or delivers its kept result); the
    // work thunk is unreachable because the key is present.
    const outcome = await this.runJob(key, () => existing.promise as Promise<ValidateResult>);
    return { ...outcome, job_id: jobId };
  }

  /**
   * S41: live org checks for Aura bundles — the two lies the local snapshot
   * can tell about them. (1) MISCLASSIFIED ADD: a bundle the org has (e.g.
   * hand-made in Developer Console) but the index lacks would classify as
   * ADD and hide the overwrite of someone's work — re-read it live through
   * Tooling AuraDefinition rows and show the file-level delta instead.
   * (2) NAME COLLISION: an Aura bundle and an LWC in the same namespace
   * cannot share a name, and the index holds only a fraction of an org's
   * LWC bundles, so only a live check answers. Best-effort by design: a
   * failed live check degrades to an honest "could not check" warning and
   * never blocks the validation (the org gate still has the final word).
   * S45: returns the entries it flipped ADD → MODIFY, so the live pre-image
   * pass does not stack a second "exists in the org" warning on them, and
   * the entries whose Tooling check FAILED (with the warning it attached),
   * so that pass can correct the "classification is from the local
   * snapshot only" sentence when its own retrieve classified the row.
   */
  private async auraLiveChecks(
    conn: ConnectionRecord,
    input: ValidateInput,
    changes: ComponentChange[],
  ): Promise<{
    flipped: Set<ComponentChange>;
    toolingFailed: Map<ComponentChange, { warning: string; reason: string }>;
  }> {
    const flipped = new Set<ComponentChange>();
    const toolingFailed = new Map<ComponentChange, { warning: string; reason: string }>();
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    for (const c of input.components) {
      if (c.type !== 'AuraDefinitionBundle') continue;
      const entry = changes.find((e) => e.type === c.type && e.api_name === c.api_name);
      if (!entry) continue;
      const esc = c.api_name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      // Set inside the try, thrown OUTSIDE it: the per-component catch
      // exists to degrade FAILED live checks, and must not be able to
      // swallow a refusal the live check succeeded in establishing.
      let liveKindConflict: { live: string; env: string } | null = null;
      try {
        const lwc = await rest.toolingQuery<{ Id: string }>(
          `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${esc}' ` +
            `AND NamespacePrefix = null LIMIT 1`,
          1,
        );
        if (lwc.length > 0) {
          entry.warnings.push(
            `NAME COLLISION — the org has an LWC named "${c.api_name}" (live check); an ` +
              `Aura bundle and an LWC in the same namespace cannot share a name, so this ` +
              `deploy will fail org-side.`,
          );
        }
        if (entry.change !== 'add') continue;
        const defs = await rest.toolingQuery<{ DefType: string; Source: string | null }>(
          `SELECT DefType, Source FROM AuraDefinition WHERE ` +
            `AuraDefinitionBundle.DeveloperName = '${esc}' AND ` +
            `AuraDefinitionBundle.NamespacePrefix = null`,
          50,
        );
        if (defs.length === 0) continue;
        const { files: proposed, main } = parseEnvelopeFor(
          'AuraDefinitionBundle',
          c.api_name,
          c.content,
        );
        // The snapshot-based KIND CHANGE refusal cannot see an org-held
        // bundle the index lacks — the LIVE rows can. Same refusal, same
        // reason: untested platform behavior stays off client orgs.
        const kinds = ['.cmp', '.app', '.evt', '.intf', '.tokens'];
        const livePrimary = defs
          .map((d) => AURA_DEFTYPE_FILES[d.DefType])
          .find((s): s is string => s !== undefined && kinds.includes(s));
        const envKind = main.slice(c.api_name.length);
        if (livePrimary && livePrimary !== envKind) {
          // Recorded, then thrown AFTER the catch below: the degrade path
          // exists for FAILED checks and must not swallow a refusal this
          // check succeeded in making. The sentinel just exits the try.
          liveKindConflict = { live: livePrimary, env: envKind };
          throw new ContrailError('aura kind conflict (rethrown below)', 'bad_component');
        }
        // The org HAS this bundle: never present the overwrite as an ADD —
        // and retract the INERT UNTIL PLACED warning attached while this
        // entry was still believed one ("renders NOWHERE" is false for a
        // bundle the org already places; the snapshot just can't see it).
        entry.change = 'modify';
        entry.warnings = entry.warnings.filter((w) => !w.startsWith('INERT UNTIL PLACED'));
        flipped.add(entry);
        const metaName = `${main}-meta.xml`;
        const live = new Map(
          defs.map((d) => [
            `${c.api_name}${AURA_DEFTYPE_FILES[d.DefType] ?? `.${d.DefType.toLowerCase()}`}`,
            d.Source ?? '',
          ]),
        );
        const changed: string[] = [];
        const added: string[] = [];
        for (const [rel, body] of Object.entries(proposed)) {
          if (rel === metaName) continue; // compared as apiVersion below
          const liveBody = live.get(rel);
          if (liveBody === undefined) added.push(rel);
          else if (liveBody.trim() !== body.trim()) changed.push(rel);
        }
        const removed = [...live.keys()].filter((rel) => !(rel in proposed));
        const bundleRow = await rest.toolingQuery<{ ApiVersion: number | null }>(
          `SELECT ApiVersion FROM AuraDefinitionBundle WHERE DeveloperName = '${esc}' ` +
            `AND NamespacePrefix = null LIMIT 1`,
          1,
        );
        const liveVer = bundleRow[0]?.ApiVersion ?? null;
        const propVer = proposed[metaName]?.match(/<apiVersion>\s*([\d.]+)/)?.[1] ?? null;
        const describe = (label: string, list: string[]) =>
          list.length > 0
            ? `${label} ${list.slice(0, 8).join(', ')}${list.length > 8 ? '…' : ''}`
            : '';
        const delta =
          [describe('changed:', changed), describe('added:', added), describe('removed:', removed)]
            .filter(Boolean)
            .join('; ') || 'no file-content differences';
        entry.warnings.push(
          `ORG HAS THIS BUNDLE (live check — it is not in the local snapshot; e.g. built ` +
            `by hand in Developer Console). This deploy OVERWRITES it: ${delta}. Files the ` +
            `org has that this envelope omits are DELETED (whole-bundle replace).` +
            (liveVer !== null && propVer !== null && Number(liveVer) !== Number(propVer)
              ? ` apiVersion changes ${liveVer} → ${propVer} (Developer Console creates ` +
                `bundles at the org's current version).`
              : ''),
        );
      } catch (err) {
        if (!liveKindConflict) {
          const reason = String(err instanceof Error ? err.message : err).slice(0, 120);
          const warning =
            `could not live-check "${c.api_name}" against the org ` +
            `(${reason}) — the ` +
            `ADD/MODIFY classification is from the local snapshot only.`;
          entry.warnings.push(warning);
          toolingFailed.set(entry, { warning, reason });
        }
      }
      if (liveKindConflict) {
        throw new ContrailError(
          `AuraDefinitionBundle ${c.api_name}: the ORG's bundle is ${liveKindConflict.live} ` +
            `(live check) and this envelope is ${liveKindConflict.env} — changing a ` +
            `bundle's kind under the same name is untested platform behavior. Delete the ` +
            `old bundle first (its own destructive approval) or use a new name.`,
          'bad_component',
        );
      }
    }
    return { flipped, toolingFailed };
  }

  /**
   * S45 hook 3: apply the live pre-image to the change entries IN PLACE (the
   * auraLiveChecks precedent), PRESENCE and CONTENT apart. Presence comes
   * from the org for every member it could enumerate: absent → ADD (NOT IN
   * TARGET when the snapshot had it); present where the snapshot said ADD →
   * MODIFY (EXISTS IN TARGET — skipped for Aura entries auraLiveChecks
   * already flipped). Content comes from the org only for COMPARABLE
   * members: documents and children trim-compared, bundles PER FILE against
   * the retrieved file map (never as envelopes). CHANGED IN TARGET is driven
   * by last-modified DATES, never by a byte mismatch; with a date missing on
   * either side the row gets only the neutral note, and only when the bytes
   * differ. The FlowDefinition deactivation entry is never reclassified
   * (analyzeChanges forces its MODIFY + DEACTIVATES). The change-dependent
   * warnings are recomputed against the live copy (refreshChangeWarnings)
   * for every reclassified entry AND every MODIFY that stays a MODIFY
   * against a comparable live copy — its diff is against the live version,
   * so its warnings must be too. Every entry gets its frozen pre_image.
   * Who/when go to `attributions` (the row detail), never into a warning.
   * Aura: the S41 KIND CHANGE refusal is re-run against the LIVE bundle
   * files first (throws before anything is reclassified, so no code is
   * issued), and a failed Tooling check's "classification is from the
   * local snapshot only" sentence is corrected where this retrieve
   * classified the row.
   */
  private applyLivePreImages(
    conn: ConnectionRecord,
    input: ValidateInput,
    changes: ComponentChange[],
    destructive: ComponentChange[],
    live: PreImageResult,
    aura: {
      flipped: Set<ComponentChange>;
      toolingFailed: Map<ComponentChange, { warning: string; reason: string }>;
    },
  ): { attributions: Map<ComponentChange, string>; changedInTarget: number } {
    const attributions = new Map<ComponentChange, string>();
    let changedInTarget = 0;
    if (live.status !== 'ok') return { attributions, changedInTarget };
    const auraFlipped = aura.flipped;
    const at = hhmm(live.at);
    // The S41 KIND CHANGE refusal against the LIVE retrieve: the snapshot
    // and the Tooling rows (auraLiveChecks) are not the only places the
    // org's bundle kind shows — the retrieved files are the org's own.
    for (const c of input.components) {
      if (c.type !== 'AuraDefinitionBundle') continue;
      const image = live.images.get(preImageKey(c.type, c.api_name));
      if (image?.present !== true || !image.files) continue;
      const files = image.files;
      const livePrimary = ['.cmp', '.app', '.evt', '.intf', '.tokens']
        .map((s) => c.api_name + s)
        .find((f) => files.has(f));
      if (!livePrimary) continue;
      const { main } = parseEnvelopeFor(c.type, c.api_name, c.content);
      if (livePrimary !== main) {
        throw new ContrailError(
          `AuraDefinitionBundle ${c.api_name}: the ORG's bundle is ` +
            `${livePrimary.slice(c.api_name.length)} (live retrieve) and this envelope is ` +
            `${main.slice(c.api_name.length)} — changing a bundle's kind under the same name ` +
            `is untested platform behavior. Delete the old bundle first (its own destructive ` +
            `approval) or use a new name.`,
          'bad_component',
        );
      }
    }
    input.components.forEach((c, i) => {
      const entry = entryFor(changes, i, c);
      const image = live.images.get(preImageKey(c.type, c.api_name));
      if (!entry || !image) return;
      entry.pre_image = summarizePreImage(image);
      // The classification analyzeChanges made (auraLiveChecks flips its
      // entries from an ADD), and the one this check starts from.
      const analyzed: ComponentChange['change'] = auraFlipped.has(entry) ? 'add' : entry.change;
      const startedAs = entry.change;
      // Live-check verdicts lead the row: they reframe everything after them.
      const lead: string[] = [];
      if (image.present !== null && !isFlowDeactivation(c)) {
        if (image.present === false) {
          if (entry.change !== 'add') {
            entry.change = 'add';
            lead.push(notInTargetText(c.type, c.api_name, at));
          }
        } else {
          if (entry.change === 'add' && !auraFlipped.has(entry)) {
            // (INERT UNTIL PLACED and the other add-only advisories go with
            // the stale change-dependent warnings below.)
            entry.change = 'modify';
            lead.push(existsInTargetText(c.type, c.api_name, at, image.comparable));
            const who = lastModifiedDetail(image);
            if (who) attributions.set(entry, who);
          }
          if (image.comparable) {
            entry.change = liveMatchesProposal(c, image) ? 'unchanged_content' : 'modify';
          }
        }
      }
      // Reclassified rows, and MODIFYs that stay MODIFY against a comparable
      // live copy (their diff is against live — a FIELD TYPE CHANGE or a
      // BUNDLE REPLACE delta read from the snapshot would contradict it).
      // Aura entries auraLiveChecks flipped stay out (analyzed is 'add'):
      // their ORG HAS THIS BUNDLE warning already describes the overwrite.
      if (
        entry.change !== startedAs ||
        (entry.change === 'modify' &&
          analyzed === 'modify' &&
          image.present === true &&
          image.comparable)
      ) {
        this.refreshChangeWarnings(conn, input.components, c, entry, analyzed, image);
      }
      // A failed Tooling check said the classification came from the local
      // snapshot only — untrue once this retrieve classified the row.
      const tooling = aura.toolingFailed.get(entry);
      if (tooling && image.present !== null) {
        const idx = entry.warnings.indexOf(tooling.warning);
        if (idx >= 0) {
          entry.warnings[idx] =
            `the Tooling live check for "${c.api_name}" could not complete (${tooling.reason}) ` +
            `— the LWC NAME COLLISION check may not have run; the ADD/MODIFY classification ` +
            `above comes from the live Metadata API retrieve.`;
        }
      }
      const row =
        image.present === true ? this.db.getArtifact(conn.id, c.type, c.api_name) : null;
      if (row) {
        const moved = this.changedSinceSnapshot(conn, c, row, image);
        if (moved === true) {
          changedInTarget += 1;
          lead.push(changedInTargetText(at, shortStamp(row.retrievedAt), image.comparable));
          const who = lastModifiedDetail(image);
          if (who) attributions.set(entry, who);
        } else if (
          (moved === null || moved === 'within_margin') &&
          image.comparable &&
          this.snapshotBytesDiffer(conn, c, row, image)
        ) {
          lead.push(liveBytesDifferText(at, moved === null ? 'no_dates' : 'within_margin'));
        }
      }
      entry.warnings.unshift(...lead);
    });
    input.destructive.forEach((d, i) => {
      const entry = entryFor(destructive, i, d);
      const image = live.images.get(preImageKey(d.type, d.api_name));
      if (!entry || !image) return;
      entry.pre_image = summarizePreImage(image);
      // Only when the listing actually enumerated the type: present:null
      // (unenumerable) never claims absence.
      if (image.present === false && listingCovers(live, d)) {
        entry.warnings.push(destructiveAbsentText(at));
      }
    });
    return { attributions, changedInTarget };
  }

  /**
   * S45: a row the live check reclassified (ADD→MODIFY, MODIFY↔UNCHANGED,
   * MODIFY→ADD) — and a MODIFY that stayed a MODIFY against a comparable
   * live copy — must carry the change-dependent warnings analyzeChanges
   * would have produced for its classification, computed against the LIVE
   * copy — not the ones it produced for the snapshot verdict against the
   * snapshot copy (a WHOLE-DOCUMENT REPLACE on what is now an ADD, an
   * add-only "surfaced nowhere" advisory on what is now an overwrite, a
   * FIELD TYPE CHANGE read from a snapshot type the org no longer has). The
   * stale set is recomputed with the same pure helper and the same inputs
   * analyzeChanges had, removed, and the fresh set takes its place — the
   * change-dependent arms lead a row's own warnings, so position is kept.
   * When the live copy equals the snapshot copy the two sets are identical
   * and this is a no-op.
   */
  private refreshChangeWarnings(
    conn: ConnectionRecord,
    components: ProposedComponent[],
    c: ProposedComponent,
    entry: ComponentChange,
    analyzed: ComponentChange['change'],
    image: PreImage,
  ): void {
    // The snapshot row analyzeChanges classified against (none for an ADD).
    const row = analyzed === 'add' ? null : this.db.getArtifact(conn.id, c.type, c.api_name);
    // The live copy is the baseline only where it was retrieved and can be
    // compared; an ADD has no baseline at all.
    const liveBaseline = entry.change !== 'add' && image.comparable;
    const referenced = () => auraBundleReferenced(this.db, conn, components, c);
    const common = { type: c.type, api_name: c.api_name, proposed: c.content, referenced };
    const root = bundleRootOf(c.type, c.api_name);
    let stale: string[];
    let fresh: string[];
    if (root !== null) {
      const { files, main } = parseEnvelopeFor(c.type, c.api_name, c.content);
      stale = changeDependentWarnings({
        ...common,
        change: analyzed,
        before: null,
        bundleFiles: {
          proposed: files,
          main,
          before: row ? readBundleFiles(this.store, conn, root, c.api_name) : {},
        },
      });
      fresh = changeDependentWarnings({
        ...common,
        change: entry.change,
        before: null,
        bundleFiles: {
          proposed: files,
          main,
          before: liveBaseline && image.files ? Object.fromEntries(image.files) : {},
        },
      });
    } else {
      stale = changeDependentWarnings({
        ...common,
        change: analyzed,
        before: row?.filePath
          ? readOldContent(this.store, conn, c.type, c.api_name, row.filePath)
          : null,
      });
      fresh = changeDependentWarnings({
        ...common,
        change: entry.change,
        before: liveBaseline ? (image.content ?? null) : null,
      });
    }
    const positions = stale.map((w) => entry.warnings.indexOf(w)).filter((i) => i >= 0);
    const at = positions.length > 0 ? Math.min(...positions) : 0;
    const drop = new Set(positions);
    entry.warnings = entry.warnings.filter((_, i) => !drop.has(i));
    entry.warnings.splice(at, 0, ...fresh);
  }

  /**
   * S45: did the org's copy change since the snapshot? true/false from the
   * last-modified DATES; null when a date is missing on either side (or a
   * stamp does not parse) — the caller then shows only the neutral note.
   * A child row the indexer stamped with its CONTAINER's date (the refresh
   * lists top-level types, so CustomField rows inherit their object's
   * stamp) holds no stamp of its own to compare with the child's live
   * stamp; for those, the live stamp is compared with the time the snapshot
   * was retrieved instead — "modified after your snapshot was taken".
   * 'within_margin' — that comparison sets an ORG stamp against the HOST's
   * retrievedAt, two different clocks: only a stamp more than
   * CHILD_STAMP_MARGIN_MS after the snapshot (or before it) is decisive;
   * inside the margin the caller falls back to the byte comparison and the
   * neutral note, never the attributed warning.
   */
  private changedSinceSnapshot(
    conn: ConnectionRecord,
    c: ProposedComponent,
    row: ArtifactRecord,
    image: PreImage,
  ): boolean | null | 'within_margin' {
    const liveMs = image.last_modified_date ? Date.parse(image.last_modified_date) : NaN;
    const snapMs = row.lastModifiedDate ? Date.parse(row.lastModifiedDate) : NaN;
    if (Number.isNaN(liveMs) || Number.isNaN(snapMs)) return null;
    const entry = deployZipEntryPath(c.type, c.api_name);
    const container = entry?.child ? retrieveMemberFor(c.type, c.api_name) : null;
    const parent = container
      ? this.db.getArtifact(conn.id, container.type, container.member)
      : null;
    if (
      parent &&
      parent.lastModifiedDate === row.lastModifiedDate &&
      parent.lastModifiedBy === row.lastModifiedBy
    ) {
      const retrievedMs = Date.parse(row.retrievedAt);
      if (Number.isNaN(retrievedMs)) return null;
      if (liveMs > retrievedMs + CHILD_STAMP_MARGIN_MS) return true;
      if (liveMs < retrievedMs - CHILD_STAMP_MARGIN_MS) return false;
      return 'within_margin';
    }
    return liveMs !== snapMs;
  }

  /**
   * S45: do the live bytes differ from the snapshot's copy? Bundles compare
   * PER FILE against readBundleFiles — never readOldContent, whose bundle
   * copy is the main file alone.
   */
  private snapshotBytesDiffer(
    conn: ConnectionRecord,
    c: ProposedComponent,
    row: ArtifactRecord,
    image: PreImage,
  ): boolean {
    const root = bundleRootOf(c.type, c.api_name);
    if (root !== null) {
      const snap = readBundleFiles(this.store, conn, root, c.api_name);
      const liveFiles = image.files ?? new Map<string, string>();
      if (Object.keys(snap).length !== liveFiles.size) return true;
      for (const [rel, body] of liveFiles) {
        const old = snap[rel];
        if (old === undefined || old.trim() !== body.trim()) return true;
      }
      return false;
    }
    const old = row.filePath
      ? readOldContent(this.store, conn, c.type, c.api_name, row.filePath)
      : null;
    return old !== null && image.content !== undefined && old.trim() !== image.content.trim();
  }

  /**
   * S45 hook 5: each component row's collapsed diff. Against the live
   * version when the retrieve succeeded and the member is comparable; else
   * against the snapshot copy (labelled "diff vs your snapshot"); none for
   * true adds. Bundles diff per file. A page-wide budget bounds the page:
   * once it is spent, rows keep their summary line and counts only.
   */
  private rowDiffs(
    conn: ConnectionRecord,
    input: ValidateInput,
    changes: ComponentChange[],
    live: PreImageResult,
  ): Map<ComponentChange, ApprovalRowDiff> {
    const out = new Map<ComponentChange, ApprovalRowDiff>();
    let budget = PAGE_DIFF_BUDGET_CHARS;
    input.components.forEach((c, i) => {
      const entry = entryFor(changes, i, c);
      if (!entry || entry.change === 'add') return;
      let diff: ApprovalRowDiff | null;
      try {
        diff = this.rowDiff(conn, c, live);
      } catch (err) {
        // A diff is presentation: it must never fail a passed validation.
        log('warn', 'approval-page diff failed', {
          type: c.type,
          err: String(err instanceof Error ? err.message : err).slice(0, 200),
        });
        diff = null;
      }
      if (!diff) return;
      // Only a diff with a body spends (or is cut by) the budget: an
      // identical or zero-change diff has nothing to omit, so it must never
      // be marked truncated or carry the "diff body omitted" note.
      const body = diff.xml_changes ?? diff.text_hunks ?? [];
      if (body.length > 0) {
        const size = JSON.stringify(body).length;
        if (size > budget) {
          budget = 0;
          delete diff.xml_changes;
          delete diff.text_hunks;
          diff.truncated = true;
          diff.note = PAGE_DIFF_BUDGET_NOTE;
        } else {
          budget -= size;
        }
      }
      out.set(entry, diff);
    });
    return out;
  }

  private rowDiff(
    conn: ConnectionRecord,
    c: ProposedComponent,
    live: PreImageResult,
  ): ApprovalRowDiff | null {
    const image =
      live.status === 'ok' ? live.images.get(preImageKey(c.type, c.api_name)) : undefined;
    const root = bundleRootOf(c.type, c.api_name);
    if (live.status === 'ok' && image?.present === true && image.comparable) {
      const label = `diff vs live org (retrieved ${hhmm(live.at)})`;
      return root !== null
        ? bundleRowDiff(image.files ?? new Map(), proposedBundleFiles(c), label, true)
        : documentRowDiff(image.content ?? '', c.content, label, true);
    }
    const row = this.db.getArtifact(conn.id, c.type, c.api_name);
    if (!row) return null;
    const label = `diff vs your snapshot (${shortStamp(row.retrievedAt)})`;
    if (root !== null) {
      const old = readBundleFiles(this.store, conn, root, c.api_name);
      if (Object.keys(old).length === 0) return null;
      return bundleRowDiff(new Map(Object.entries(old)), proposedBundleFiles(c), label, false);
    }
    const old = row.filePath
      ? readOldContent(this.store, conn, c.type, c.api_name, row.filePath)
      : null;
    return old === null ? null : documentRowDiff(old, c.content, label, false);
  }

  /**
   * S45 hook 6: the page-top live-check lines — the UNAVAILABLE banner when
   * the retrieve failed (the only case where "the org was not re-read" is
   * true), else the CHANGED-IN-TARGET summary and the dates-unavailable line.
   */
  private liveCheckWarnings(
    conn: ConnectionRecord,
    input: ValidateInput,
    live: PreImageResult,
    changedInTarget: number,
  ): string[] {
    if (live.status === 'unavailable') {
      // The members' snapshot rows can have different ages (a refresh of
      // some types only): name the range, never the newest alone — the
      // older rows must not be presented as that fresh.
      let oldest: string | null = null;
      let newest: string | null = null;
      for (const m of [...input.components, ...input.destructive]) {
        const row = this.db.getArtifact(conn.id, m.type, m.api_name);
        if (!row) continue;
        if (oldest === null || row.retrievedAt < oldest) oldest = row.retrievedAt;
        if (newest === null || row.retrievedAt > newest) newest = row.retrievedAt;
      }
      const from =
        oldest === null || newest === null
          ? null
          : shortStamp(oldest) === shortStamp(newest)
            ? shortStamp(oldest)
            : `${shortStamp(oldest)} to ${shortStamp(newest)}`;
      return [liveUnavailableText(live.reason.slice(0, 200), from)];
    }
    const at = hhmm(live.at);
    const out: string[] = [];
    if (changedInTarget > 0) out.push(changedSummaryText(changedInTarget, conn.alias, at));
    if (live.dates_unavailable !== undefined) {
      const types = [
        ...new Set([...input.components, ...input.destructive].map((m) => m.type)),
      ];
      out.push(datesUnavailableText(at, types, live.dates_unavailable.slice(0, 160)));
    } else if (live.dates_unavailable_types.length > 0) {
      out.push(
        datesUnavailableText(
          at,
          live.dates_unavailable_types,
          'listMetadata reported INVALID_TYPE',
        ),
      );
    }
    return out;
  }

  /**
   * S45 hook 7: write the pre-image files a revert re-deploys into
   * staging/_reverts/<requestId>/ — every present member's bytes (restorable
   * ones written, the rest listed with a reason), the package's adds listed
   * as absent. Deletions contribute only what existed: a delete of a member
   * the org lacks is not a revert ADD. `_reverts` must be the REAL
   * staging/_reverts (revertsRootReal — never a link, never staging itself
   * or a folder inside it), and `_reverts/<id>` is created non-recursively,
   * so an entry an agent planted there first aborts the write instead of
   * being written through. Never fails the validation: a failure is
   * returned (and persisted) for the execute-time revert package to
   * disclose.
   */
  private writeRevertFiles(
    requestId: string,
    input: ValidateInput,
    live: Extract<PreImageResult, { status: 'ok' }>,
  ):
    | ({ dir: string } & ReturnType<typeof writeRevertPreImages>)
    | { dir: string | null; error: string } {
    const entries: RevertPreImageEntry[] = [];
    for (const c of input.components) {
      const image = live.images.get(preImageKey(c.type, c.api_name));
      if (image) entries.push({ type: c.type, api_name: c.api_name, image });
    }
    for (const d of input.destructive) {
      const image = live.images.get(preImageKey(d.type, d.api_name));
      if (image && image.present !== false) {
        entries.push({ type: d.type, api_name: d.api_name, image });
      }
    }
    let dir: string | null = null;
    let contained = false;
    try {
      fs.mkdirSync(path.join(stagingDir(), '_reverts'), { recursive: true });
      const root = revertsRootReal();
      dir = revertDirFor(stagingDir(), requestId);
      // Non-recursive: a pre-existing _reverts/<id> (planted before this
      // write) fails with EEXIST rather than being written through.
      fs.mkdirSync(dir);
      assertRealRevertDir(root, requestId);
      contained = true;
      return { dir, ...writeRevertPreImages(dir, entries) };
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err).slice(0, 300);
      log('warn', 'could not write revert pre-images', { requestId, error });
      // Never leave a half-written package where a revert could be read from.
      if (contained && dir) fs.rmSync(dir, { recursive: true, force: true });
      return { dir, error };
    }
  }

  /**
   * S45 F4: remove one request's revert package (staging/_reverts/<id>) —
   * the inline cleanup a return site decides (payload missing, org-reported
   * rollback, supersede, expired or locked code). Best-effort and contained:
   * removed only when `_reverts` is the real staging/_reverts and the entry
   * is a real directory directly under it — a link (at either level) is
   * never followed and never removed; the skip is logged.
   */
  private removeRevertDir(requestId: string): void {
    try {
      const dir = revertDirFor(stagingDir(), requestId);
      if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return;
      // Checked immediately before the removal (see sweepRevertDirs).
      assertRealRevertDir(revertsRootReal(), requestId);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log('warn', 'could not remove revert package', {
        requestId,
        error: String(err instanceof Error ? err.message : err).slice(0, 300),
      });
    }
  }

  /**
   * S45 F4: the revert-package sweep. Runs only where a new deploy code is
   * about to be issued — never on a dry run. It first expires stale
   * 'validated' requests of every kind and connection (expiry used to be
   * lazy, so a never-executed validation kept its payload and pre-images
   * forever), then removes each staging/_reverts/<id> its request can no
   * longer use: no request, superseded, expired or locked; execution_failed
   * without a revert-plan.json (rollback or missing payload — nothing
   * committed); executed, or an outcome-unknown plan, older than
   * deploy.revertRetentionDays (0 = never). validated and executing are kept
   * (execute finalizes into the dir). Best-effort: never blocks a validation.
   * Containment: links are never followed — `_reverts` must be the real
   * staging/_reverts (revertsRootReal), only UUID-named real directories
   * directly under it are ever removed (any other entry is skipped and
   * logged), and both facts are re-checked immediately before each removal;
   * a mismatch stops the sweep. A residual microsecond race between that
   * re-check and the removal can at worst hit a UUID-named directory.
   */
  private sweepRevertDirs(): void {
    try {
      const expired = this.db.expireStaleValidatedRequests(new Date().toISOString());
      for (const e of expired) if (e.payloadPath) safeUnlink(e.payloadPath);
      if (expired.length > 0) {
        this.audit.record('deploy.expired', {
          tool: 'validate_deploy',
          detail: { count: expired.length, requestIds: expired.map((e) => e.id) },
        });
      }
    } catch (err) {
      log('warn', 'could not expire stale validations', { err: String(err) });
    }
    let root: string;
    let entries: fs.Dirent[];
    try {
      if (!fs.lstatSync(path.join(stagingDir(), '_reverts'), { throwIfNoEntry: false })) return;
      // A `_reverts` linked to staging itself, to a project folder inside
      // it, or anywhere else must not turn the sweep into a delete there.
      root = revertsRootReal();
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log('warn', 'could not sweep revert packages', { err: String(err) });
      return;
    }
    const days = this.config.deploy.revertRetentionDays;
    const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    let skippedNames = 0;
    for (const d of entries) {
      // Never follow a link; only real, UUID-named directories (request ids)
      // are revert packages — anything else is left alone.
      if (d.isSymbolicLink() || !d.isDirectory()) continue;
      if (!REQUEST_ID_RE.test(d.name)) {
        skippedNames += 1;
        continue;
      }
      const dir = path.join(stagingDir(), '_reverts', d.name);
      try {
        const status = this.db.getDeployRequestStatus(d.name);
        const planFile = path.join(dir, 'revert-plan.json');
        let reason: string | null = null;
        if (
          status === null ||
          status === 'superseded' ||
          status === 'expired' ||
          status === 'locked'
        ) {
          reason = status ?? 'no_request';
        } else if (status === 'execution_failed' && !fs.existsSync(planFile)) {
          reason = 'execution_failed';
        } else if ((status === 'executed' || status === 'execution_failed') && cutoff !== null) {
          // execution_failed WITH a plan is the outcome-unknown package: kept
          // like an executed one. Its age is the plan's (written at execute).
          const age = fs.statSync(fs.existsSync(planFile) ? planFile : dir).mtimeMs;
          if (age < cutoff) reason = 'retention';
        }
        if (reason === null) continue;
        // Re-checked immediately before the removal: the entries were read
        // once, and a `_reverts` swapped for a link since must stop the
        // sweep, never redirect it.
        try {
          if (!samePath(revertsRootReal(), root)) throw new Error('_reverts moved');
          assertRealRevertDir(root, d.name);
        } catch (err) {
          log('warn', 'revert sweep stopped: _reverts changed under it', {
            dir: d.name,
            err: String(err),
          });
          return;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        this.audit.record('deploy.revert_swept', {
          tool: 'validate_deploy',
          detail: { requestId: d.name, reason },
        });
      } catch (err) {
        // One unreadable entry never stops the sweep.
        log('warn', 'could not sweep a revert package', { dir: d.name, err: String(err) });
      }
    }
    if (skippedNames > 0) {
      log('warn', 'revert sweep skipped entries that are not request ids', {
        count: skippedNames,
      });
    }
  }

  /**
   * S45 F4: finalize the frozen revert package beside the pre-images
   * validate wrote — revert-plan.json + README.txt — on 'executed', and with
   * outcome:'unknown' when Contrail lost track of the deploy (it MAY have
   * committed). Returns the payload fields: `revert_package`, or null plus a
   * `revert_note` when no package exists — never a snapshot-based revert,
   * which could restore a state the org never had. `targetCheck` is the
   * execute-time guard's pass result (null until that guard runs). Never
   * throws: the deploy's own outcome stands whatever happens here.
   */
  private finalizeRevert(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    summary: Record<string, unknown>,
    opts: { targetCheck?: RevertTargetCheck; unknown?: { error: string; deployId?: string } },
  ): { revert_package: Record<string, unknown> | null; revert_note?: string } {
    const live = summary.live_check as LiveCheckSummary | null | undefined;
    if (!live) {
      return {
        revert_package: null,
        revert_note:
          'No revert package: this request was validated without a live pre-image retrieve, ' +
          'so Contrail holds no copy of what the org had before.',
      };
    }
    if (live.status !== 'ok') {
      return {
        revert_package: null,
        revert_note:
          `No revert package: the live pre-image retrieve was unavailable when this deploy ` +
          `was validated (${live.reason ?? 'no reason recorded'}), so Contrail holds no copy ` +
          `of what the org had before. It does not build a revert from the local snapshot — ` +
          `that could restore a state the org never had.`,
      };
    }
    const pre = summary.revert_preimages as
      | ({ dir: string } & RevertWriteResult)
      | { dir: string | null; error: string }
      | undefined;
    if (!pre || 'error' in pre) {
      return {
        revert_package: null,
        revert_note:
          `No revert package: Contrail could not write the pre-image files when this deploy ` +
          `was validated (${pre?.error ?? 'none were recorded'}).`,
      };
    }
    let dir: string | null = null;
    try {
      dir = revertDirFor(stagingDir(), request.id);
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory()) {
        return {
          revert_package: null,
          revert_note:
            `No revert package: the pre-image files Contrail wrote at validate are no longer ` +
            `under ${dir}.`,
        };
      }
      // An agent-planted junction must not redirect the plan/README writes
      // (at _reverts or at _reverts/<id>), and neither may a link planted at
      // either file name: each is unlinked (a link is removed, never followed;
      // a directory there is refused, never deleted recursively), then written
      // exclusively ('wx'). Unlink-only bounds what a junction swapped in after
      // the assert could reach to these two file names.
      assertRealRevertDir(revertsRootReal(), request.id);
      for (const name of ['revert-plan.json', 'README.txt']) {
        const target = path.join(dir, name);
        const st = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory() && !st.isSymbolicLink()) {
          throw new ContrailError(`${target} is a directory, not a revert file`, 'unsafe_path');
        }
        fs.unlinkSync(target);
      }
      const unknown = opts.unknown;
      const plan: RevertPlan = {
        request_id: request.id,
        connection: conn.alias,
        executed_at: unknown ? null : new Date().toISOString(),
        retrieved_at: live.at,
        retrieve_started_at: live.started_at,
        target_check: opts.targetCheck ?? null,
        components: pre.components,
        destructive: pre.absent,
        not_restorable: pre.not_restorable,
        // Requests validated before covered existed carry none.
        covered: pre.covered ?? [],
        note: unknown
          ? `Contrail lost track of this deploy (${unknown.error.slice(0, 300)}); check Setup → ` +
            `Deployment Status. If it committed, these files are what the org held when this ` +
            `package was validated.`
          : 'Pre-images retrieved when this deploy was validated; README.txt says what a ' +
            'revert does and does not undo. Contrail never deploys a revert on its own.',
        ...(unknown
          ? {
              outcome: 'unknown' as const,
              ...(unknown.deployId ? { deploy_id: unknown.deployId } : {}),
            }
          : {}),
      };
      const finalized = finalizeRevertPackage(dir, plan);
      this.audit.record('deploy.revert_written', {
        connectionId: conn.id,
        tool: 'execute_deploy',
        detail: {
          requestId: request.id,
          dir,
          restores: plan.components.length,
          deletes: plan.destructive.length,
          not_restorable: plan.not_restorable.length,
          ...(unknown ? { outcome: 'unknown' } : {}),
        },
      });
      return {
        revert_package: {
          dir,
          ...(unknown ? { outcome: 'unknown' } : {}),
          restores: plan.components,
          deletes: plan.destructive,
          not_restorable: plan.not_restorable,
          ...(plan.covered.length > 0 ? { covered: plan.covered } : {}),
          plan: finalized.plan_path,
          note: finalized.readme,
        },
      };
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err).slice(0, 300);
      log('warn', 'could not finalize the revert package', { requestId: request.id, error });
      // Say what is on disk, never assume it: finalizeRevertPackage removes a
      // plan it wrote when the README write fails, but only best-effort, and
      // a failure can leave a plan this call did not remove.
      let planOnDisk: 'absent' | 'present' | 'unknown' | null = null;
      if (dir) {
        try {
          planOnDisk = fs.lstatSync(path.join(dir, 'revert-plan.json'), {
            throwIfNoEntry: false,
          })
            ? 'present'
            : 'absent';
        } catch {
          planOnDisk = 'unknown';
        }
      }
      return {
        revert_package: null,
        revert_note:
          `No revert package: Contrail could not finalize the revert files` +
          (dir ? ` under ${dir}` : '') +
          ` (${error})` +
          (planOnDisk === 'present'
            ? `; a revert-plan.json is still there, but this package was not finished — ` +
              `do not treat it as complete.`
            : planOnDisk === 'absent'
              ? `; any pre-image files there have no revert-plan.json.`
              : planOnDisk === 'unknown'
                ? `; Contrail could not check whether a revert-plan.json is there.`
                : `.`),
      };
    }
  }

  private async doValidate(
    conn: ConnectionRecord,
    input: ValidateInput,
    job?: Job<unknown>,
  ): Promise<ValidateResult> {
    const versionNumber = this.config.salesforce.apiVersion.replace(/^v/, '');

    // NOTE: we deliberately do NOT auto-inject a FlowDefinition deactivation
    // when deleting a Flow. Deactivation only takes effect on execute, but the
    // checkOnly validation gate evaluates the destructive delete against the
    // org's current (still-active) state, so a combined package never
    // validates. Flow deactivation is its own step (deactivate_flow); flow
    // deletion via the Metadata API is unreliable regardless (see the failure
    // guidance below).
    //
    // S41 (§3.15): the destructive path accepts ANY type by design (cleanup
    // is a feature; the guard is the human approval) — but a delete of a
    // type Contrail cannot read proceeds BLIND, so it takes an explicit
    // flag, and translation types are refused outright: a file-level delete
    // clobbers per-entry work whose safe write route is Setup's Translation
    // Workbench or the per-entry Tooling path (ExternalStringLocalization).
    const translationTypes = new Set([
      'Translations',
      'CustomObjectTranslation',
      'StandardValueSetTranslation',
      'GlobalValueSetTranslation',
    ]);
    for (const d of input.destructive) {
      if (translationTypes.has(d.type)) {
        throw new ContrailError(
          `${d.type} ${d.api_name}: translation components are not deletable through ` +
            `Contrail — remove entries in Setup (Translation Workbench), or per-entry ` +
            `via Tooling ExternalStringLocalization for custom-label translations.`,
          'bad_component',
        );
      }
      if (!isRegisteredType(d.type) && input.allowUnregisteredDelete !== true) {
        throw new ContrailError(
          `${d.type} ${d.api_name}: this type is not registered — Contrail cannot read ` +
            `it or list its dependents, so the delete would be blind. Pass ` +
            `allow_unregistered_delete: true to proceed anyway (the approval page will ` +
            `carry the UNREGISTERED TYPE DELETE warning).`,
          'bad_component',
        );
      }
    }

    // S41: superseding happens only when a NEW code is about to be issued
    // (immediately before insertDeployRequest, below) — so neither a local
    // grammar refusal from these two lines, nor an org-FAILED validation,
    // ever kills a pending approval on its way to not producing one.
    const built = buildDeployZip(input.components, input.destructive, versionNumber, (type, name) =>
      this.metaXmlFromSnapshot(conn, type, name),
    );
    const { changes, destructive } = analyzeChanges(
      this.db,
      this.store,
      conn,
      input.components,
      input.destructive,
    );

    const permCoverage = analyzePermissionCoverage(input.components);

    // S41: Aura bundles get two LIVE org checks the local snapshot cannot
    // answer — see auraLiveChecks. Mutates the change entries in place.
    let aura: Awaited<ReturnType<DeployEngine['auraLiveChecks']>> = {
      flipped: new Set<ComponentChange>(),
      toolingFailed: new Map(),
    };
    if (input.components.some((c) => c.type === 'AuraDefinitionBundle')) {
      if (job) job.progress = 'live-checking Aura bundles against the org';
      aura = await this.auraLiveChecks(conn, input, changes);
    }

    // Blast radius per touched component; deletions with dependents get an
    // explicit warning on the destructive entry itself.
    const blast: string[] = [];
    for (const item of [...changes, ...destructive]) {
      // Dependency edges for a flow are keyed on type 'Flow'; a FlowDefinition
      // change (a deactivation) must look up dependents as its flow, or a
      // widely-depended-on flow would show "nothing depends on this".
      const lookupType = item.type === 'FlowDefinition' ? 'Flow' : item.type;
      const graph = queryDependencies(this.db, conn.id, lookupType, item.api_name, 'used_by', 1);
      if (graph.nodes.length > 0) {
        const names = graph.nodes.slice(0, 5).map((n) => `${n.type}:${n.name}`);
        const parts =
          names.join(', ') +
          (graph.nodes.length > names.length ? ` +${graph.nodes.length - names.length} more` : '');
        blast.push(`${lookupType}:${item.api_name} ← used by ${parts}`);
        if (item.change === 'delete') {
          item.warnings.push(`deleting this breaks dependents: ${parts}`);
        } else if (item.type === 'FlowDefinition') {
          item.warnings.push(`deactivating this flow may break dependents: ${parts}`);
        }
      }
    }

    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    // S45 hook 1: the live pre-image — what the org holds for every member
    // (deletions included: a revert of a delete needs the deleted bytes) —
    // retrieved CONCURRENTLY with the checkOnly deploy. Never on a dry run:
    // nothing from a dry run is approvable, so there is nothing to diff.
    // retrievePreImages never rejects; the controller stops its polling
    // when the validation fails or throws, so a failed validate never waits
    // out preImageTimeoutMs.
    const liveCheckStartedAt = new Date().toISOString();
    const ctl = new AbortController();
    let awaitingPreImages = false;
    let preImagesP: Promise<PreImageResult> | null = null;
    if (!input.dryRun) {
      preImagesP = retrievePreImages(soap, [...input.components, ...input.destructive], {
        startedAt: liveCheckStartedAt,
        timeoutMs: this.config.deploy.preImageTimeoutMs,
        pollIntervalMs: this.config.snapshot.pollIntervalMs,
        extractZip: (zip) => this.store.extractRetrieveZip(zip),
        signal: ctl.signal,
        onProgress: (p) => {
          if (job && awaitingPreImages) job.progress = p;
        },
      });
    }
    if (job) {
      job.progress = input.dryRun
        ? 'validating with Salesforce (checkOnly)'
        : 'validating with Salesforce (checkOnly) · retrieving live pre-images';
    }
    let validationId: string;
    let result: DeployResult;
    let pre: PreImageResult | null = null;
    try {
      validationId = await soap.deploy(built.zip, {
        checkOnly: true,
        testLevel: input.testLevel,
        runTests: input.runTests,
      });
      result = await this.pollDeploy(soap, validationId, job);
      // S45 hook 2: only a PASSED, approvable validation waits for the
      // pre-image; a failed one (or a dry run) discards it unread.
      if (result.success && preImagesP) {
        awaitingPreImages = true;
        if (job) job.progress = 'retrieving live pre-images';
        pre = await preImagesP;
      }
    } finally {
      // Harmless after a completed retrieve; on a failed or THROWN
      // validation it stops the retrieve's polling at its next tick.
      ctl.abort();
    }

    if (!result.success) {
      this.audit.record('deploy.validation_failed', {
        connectionId: conn.id,
        tool: 'validate_deploy',
        outcome: 'error',
        detail: {
          validationId,
          componentErrors: result.numberComponentErrors,
          testErrors: result.numberTestErrors,
        },
      });
      const deletingFlow = input.destructive.some((d) => d.type === 'Flow');
      const note = input.dryRun
        ? 'Dry run: validation FAILED. Fix the failures and check again (dry_run), or ' +
          'validate for approval once the package is final.'
        : deletingFlow
        ? 'Validation failed — no confirmation code was issued. Deleting a flow via the ' +
          'Metadata API is unreliable: an ACTIVE flow must be turned off first with ' +
          'deactivate_flow, and even an INACTIVE flow often fails validation with ' +
          '"insufficient access rights on cross-reference id". If it does, delete the flow in ' +
          'Setup → Flows (its objects can be deleted here once the flow is gone). Fix any other ' +
          'failures and re-validate.'
        : 'Validation failed — no confirmation code was issued. Fix the failures and validate again.';
      return {
        summary: null,
        validation_passed: false,
        failure: {
          status: result.status,
          error_message: result.errorMessage ?? null,
          component_failures: result.componentFailures.slice(0, 25),
          tests_run: result.numberTestsTotal,
          test_failures: result.numberTestErrors,
          test_failure_detail: this.gateTestDetail(conn, result),
          note,
        },
        approval: null,
      };
    }

    if (input.dryRun) {
      // S38: validation passed, and that is the WHOLE result — no code is
      // generated, no request row exists, no payload is frozen, no page is
      // presented. Nothing from this call can ever be executed.
      this.audit.record('deploy.validated', {
        connectionId: conn.id,
        tool: 'validate_deploy',
        detail: {
          dryRun: true,
          validationId,
          components: input.components.length,
          deletions: input.destructive.length,
          testLevel: input.testLevel,
          ...sourceProvenance(input.components),
        },
      });
      const drySummary: DeployValidationSummary = {
        connection: conn.alias,
        org_type: conn.orgType,
        request_id: null,
        validation_id: validationId,
        test_level: input.testLevel ?? null,
        changes,
        destructive,
        components_total: result.numberComponentsTotal,
        component_errors: result.numberComponentErrors,
        tests_run: result.numberTestsTotal,
        test_failures: result.numberTestErrors,
        test_failure_detail: this.gateTestDetail(conn, result),
        code_coverage_warnings: result.codeCoverageWarnings.slice(0, 10),
        blast_radius: blast,
        permission_warning: permCoverage.warning,
        expires_at: null,
        live_check: null,
      };
      return { summary: drySummary, validation_passed: true, approval: null };
    }

    // S45 hook 3: classify against the LIVE org, not the snapshot — in place,
    // before the supersede, so the persisted summary is the live one. Only a
    // failed RETRIEVE leaves the snapshot verdicts standing (the page then
    // says the org was not re-read).
    const live: PreImageResult = pre ?? {
      status: 'unavailable',
      started_at: liveCheckStartedAt,
      at: new Date().toISOString(),
      reason: 'retrieve_failed:not started',
    };
    const liveCheck: LiveCheckSummary = {
      status: live.status,
      ...(live.status === 'unavailable' ? { reason: live.reason } : {}),
      started_at: live.started_at,
      at: live.at,
      ...(result.createdDate
        ? {
            org_clock: {
              created_date: result.createdDate,
              ...(result.completedDate ? { completed_date: result.completedDate } : {}),
            },
          }
        : {}),
      dates_unavailable_types: live.status === 'ok' ? live.dates_unavailable_types : [],
      ...(live.status === 'ok' && live.dates_unavailable !== undefined
        ? { dates_unavailable: live.dates_unavailable }
        : {}),
      members: input.components.length + input.destructive.length,
    };
    const review = this.applyLivePreImages(conn, input, changes, destructive, live, aura);

    // S41 (review fix): supersede IMMEDIATELY before inserting the new
    // request — atomically close the old approval as the new one opens.
    // At doValidate's start it left a minutes-wide window (while org tests
    // ran) in which a second input-keyed validate could also supersede
    // nothing and leave TWO live codes on one connection; and superseding
    // only here means an org-FAILED validation (which issues no code)
    // leaves the pending approval intact, exactly like a local refusal.
    // Dry runs never reach this line (returned above).
    // S45 F4: a new code is about to be issued — sweep stale validations and
    // revert packages first (the sweepBulkResultDirs precedent).
    this.sweepRevertDirs();
    {
      const superseded = this.db.supersedePendingRequests(conn.id, 'deploy');
      if (superseded > 0) {
        for (const p of this.db.takeSupersededPayloadPaths(conn.id, 'deploy')) {
          safeUnlink(p);
          // The zip is <requestId>.zip, so its basename names the revert dir.
          this.removeRevertDir(path.basename(p, '.zip'));
        }
        this.audit.record('deploy.superseded', {
          connectionId: conn.id,
          tool: 'validate_deploy',
          detail: { count: superseded },
        });
      }
    }
    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    const request = this.db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'deploy',
      confirmationCode: code,
      expiresAt,
      payloadJson: JSON.stringify({ testLevel: input.testLevel, runTests: input.runTests }),
      summaryJson: JSON.stringify({ changes, destructive, blast, live_check: liveCheck }),
      validationId,
    });
    const zipPath = path.join(deploysDir(), `${request.id}.zip`);
    fs.writeFileSync(zipPath, built.zip);
    this.db.setDeployRequestPayloadPath(request.id, zipPath);
    // S45 hook 7: freeze the pre-image bytes a revert needs — the retrieve
    // already happened, and execute must not re-read the org for them.
    if (live.status === 'ok') {
      const revert = this.writeRevertFiles(request.id, input, live);
      this.db.setDeployRequestSummaryJson(
        request.id,
        JSON.stringify({
          changes,
          destructive,
          blast,
          live_check: liveCheck,
          revert_preimages: revert,
        }),
      );
    }

    const summary: DeployValidationSummary = {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      validation_id: validationId,
      test_level: input.testLevel ?? null,
      changes,
      destructive,
      components_total: result.numberComponentsTotal,
      component_errors: result.numberComponentErrors,
      tests_run: result.numberTestsTotal,
      test_failures: result.numberTestErrors,
      test_failure_detail: this.gateTestDetail(conn, result),
      code_coverage_warnings: result.codeCoverageWarnings.slice(0, 10),
      blast_radius: blast,
      permission_warning: permCoverage.warning,
      expires_at: expiresAt,
      live_check: liveCheck,
    };

    // S45 hook 5: each row's diff — against the live version when the
    // retrieve succeeded and the type is comparable, else the snapshot (the
    // label says which); a page-wide budget keeps the page bounded.
    const diffs = this.rowDiffs(conn, input, changes, live);
    const view: ApprovalPageOptions = {
      kind: 'deploy',
      code,
      expiresAt,
      org: {
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        instanceUrl: conn.instanceUrl,
      },
      changes: changes.map((c) => {
        // Who/when live in the detail, never in a warning — composePushover
        // reads labels and warnings only, so editor names never reach a phone.
        const detail = [
          c.source_path
            ? `from ${c.source_path}  ·  sha256 ${(c.source_sha256 ?? '').slice(0, 16)}…`
            : null,
          review.attributions.get(c) ?? null,
        ]
          .filter((d): d is string => d !== null)
          .join('\n');
        const diff = diffs.get(c);
        return {
          label: `${c.change.toUpperCase()}  ${c.type}:${c.api_name}`,
          warnings: c.warnings,
          ...(detail ? { detail } : {}),
          ...(diff ? { diff } : {}),
        };
      }),
      destructive: destructive.map((c) => ({
        label: `DELETE  ${c.type}:${c.api_name}`,
        warnings: c.warnings,
      })),
      results: [
        { label: 'Validation', value: 'passed (checkOnly)' },
        { label: 'Components', value: String(result.numberComponentsTotal) },
        {
          label: 'Tests',
          value:
            result.numberTestsTotal > 0
              ? `${result.numberTestsTotal} run, ${result.numberTestErrors} failed`
              : `none run (${input.testLevel ?? 'org default'})`,
          bad: result.numberTestErrors > 0,
        },
      ],
      blast,
      // S45 hook 6: the live-check lines ride view.warnings, so the phone's
      // warning count includes them with notify.ts untouched.
      warnings: [
        ...(permCoverage.warning ? [permCoverage.warning] : []),
        ...this.liveCheckWarnings(conn, input, live, review.changedInTarget),
      ],
    };
    const approval = await this.approvals.present(
      renderApprovalPage(view),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );
    const phone = await this.notifyApproval(view, request.id, conn.id, 'page');

    this.audit.record('deploy.validated', {
      connectionId: conn.id,
      tool: 'validate_deploy',
      detail: {
        requestId: request.id,
        validationId,
        components: input.components.length,
        deletions: input.destructive.length,
        testLevel: input.testLevel,
        ...sourceProvenance(input.components),
      },
    });
    return {
      summary,
      validation_passed: true,
      approval: { ...approvalForAgent('deploy', approval), phone_notification: phone },
    };
  }

  async executeDeploy(
    conn: ConnectionRecord,
    code: string,
  ): Promise<JobOutcome<Record<string, unknown>>> {
    // S45 F2: a SYNCHRONOUS read-only peek decides whether the execute-time
    // "target moved" guard runs. It never counts an attempt: a wrong code
    // (null), a request that is not 'validated', or an expired one takes
    // today's synchronous claimCode path untouched — lockout accounting,
    // code_unusable, re-attaching to an 'executing' row — with ONE exception
    // below: a 'superseded' row whose guard job is still uncollected.
    const peek = this.db.findRequestByCode(conn.id, 'deploy', code);
    if (
      !peek ||
      peek.status !== 'validated' ||
      new Date(peek.expiresAt).getTime() < Date.now()
    ) {
      // S45 F2: a guard verdict that outlived the first call's soft-wait
      // (deploy.toolWaitMs below the guard's runtime) voided the row while its
      // job sat uncollected. The poll collects THAT structured result
      // ({target_moved:true, moved, refusal}), as the in-progress contract
      // promises. Only 'superseded': every other status keeps today's
      // claimCode path. Once collected, runJob drops the job, so a later
      // resend gets claimCode's code_unusable replay. A non-null peek means
      // the code matched, so no attempt accounting is skipped.
      if (peek && peek.status === 'superseded' && this.jobs.has(`deploy-exec:${peek.id}`)) {
        return this.runDeployExecJob(`deploy-exec:${peek.id}`, peek, async () => ({
          kind: 'running',
        }));
      }
      // Resolve the code synchronously (better-sqlite3), before any await, so
      // the atomic claim and job creation cannot interleave with a second call.
      const claim = this.claimCode(conn, 'deploy', code, 'execute_deploy');
      if (claim.kind === 'terminal') {
        return { status: 'complete', result: claim.result };
      }
      const jobKey = `deploy-exec:${claim.request.id}`;
      if (claim.kind === 'running' && !this.jobs.has(jobKey)) {
        // Status is 'executing' but no live job — a concurrent call owns it, or
        // a prior process was mid-deploy. Never dispatch a second deploy here.
        return {
          status: 'in_progress',
          progress: 'a deploy for this code is already in progress',
          started_at: claim.request.createdAt,
        };
      }
      // Job keyed by request id: the claiming call starts it; a poll with the
      // same code re-attaches to the same running job, never a second deploy.
      return this.runDeployExecJob(jobKey, claim.request, async (job) => ({
        kind: 'result',
        result: await this.doExecute(conn, claim.request, job),
      }));
    }
    // S45 F2: a live, unexpired code. The guard runs INSIDE the job keyed by
    // REQUEST id, ahead of the claim: the soft-wait covers the org read, and
    // two concurrent calls with the same code attach to one job through
    // runJob's key semantics (the second never re-reads or re-claims).
    const request = peek;
    return this.runDeployExecJob(`deploy-exec:${request.id}`, request, async (job) => {
      job.progress = 're-checking the target org before claiming the code';
      const guard = await this.preflightTargetMoved(conn, 'deploy', request, 'execute_deploy', {
        deadlineMs: TARGET_CHECK_DEADLINE_MS,
      });
      if (guard.verdict === 'moved') return { kind: 'result', result: guard.result };
      // Resolve the code synchronously (better-sqlite3) inside the job body —
      // no await between the claim and doExecute's start, so a concurrent
      // call cannot interleave a second claim; it re-attaches to this job.
      let claim: ReturnType<DeployEngine['claimCode']>;
      try {
        claim = this.claimCode(conn, 'deploy', code, 'execute_deploy');
      } catch (err) {
        if (err instanceof ContrailError) return { kind: 'refused', error: err };
        throw err;
      }
      if (claim.kind === 'terminal') return { kind: 'result', result: claim.result };
      // Another process claimed it first (or the void lost a race): poll
      // again — never a second dispatch.
      if (claim.kind === 'running') return { kind: 'running' };
      const targetCheck =
        guard.verdict === 'proceed' ? (guard.targetCheck as RevertTargetCheck) : undefined;
      return {
        kind: 'result',
        result: await this.doExecute(conn, claim.request, job, targetCheck),
      };
    });
  }

  /**
   * S45 F2: run (or re-attach to) the deploy-exec job and map its step to
   * the tool's outcome. A claim refusal raised inside the job is re-thrown
   * here, exactly as the synchronous path throws it; a claim another caller
   * won maps to the same poll-again shape as today's 'running' case.
   */
  private async runDeployExecJob(
    jobKey: string,
    request: DeployRequestRecord,
    work: (job: Job<DeployExecStep>) => Promise<DeployExecStep>,
  ): Promise<JobOutcome<Record<string, unknown>>> {
    const outcome = await this.runJob<DeployExecStep>(jobKey, work);
    if (outcome.status !== 'complete') return outcome;
    const step = outcome.result;
    if (step.kind === 'refused') throw step.error;
    if (step.kind === 'running') {
      return {
        status: 'in_progress',
        progress: 'a deploy for this code is already in progress',
        started_at: request.createdAt,
      };
    }
    return { status: 'complete', result: step.result };
  }

  private async doExecute(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    job?: Job<unknown>,
    // S45 F2/F4: the execute-time guard's verdict — its pass list, or the
    // fail-open `unavailable` disclosure — reported as target_check on every
    // result where the deploy was submitted (not on payload_missing —
    // nothing ran) and frozen into the revert plan (undefined when no guard
    // ran for this call → no target_check key, and the plan says null).
    targetCheck?: RevertTargetCheck,
  ): Promise<Record<string, unknown>> {
    // The code is already spent (status='executing') — any failure below
    // leaves it non-reusable, so a retry cannot re-drive the deploy.
    // S45 F4: each return site below decides its revert package INLINE —
    // finishExecution's two-valued status cannot tell a rollback from a
    // deploy Contrail lost track of.
    const summary = JSON.parse(request.summaryJson) as Record<string, unknown>;
    const checkField = targetCheck ? { target_check: targetCheck } : {};
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);

    if (!request.payloadPath || !fs.existsSync(request.payloadPath)) {
      this.audit.record('deploy.execution_failed', {
        connectionId: conn.id,
        tool: 'execute_deploy',
        outcome: 'error',
        detail: { requestId: request.id, reason: 'payload_missing' },
      });
      // Nothing was submitted, so nothing needs reverting — and no
      // target_check: its notes say the deploy "ran", which it did not.
      this.removeRevertDir(request.id);
      return this.finishExecution(conn, request, 'execution_failed', {
        connection: conn.alias,
        deployed: false,
        error_message: 'The validated deploy package is missing from disk.',
        note: 'Re-validate to produce a fresh package and code.',
      });
    }
    const zip = fs.readFileSync(request.payloadPath);
    const options = JSON.parse(request.payloadJson ?? '{}') as {
      testLevel?: TestLevel;
      runTests?: string[];
    };
    if (job) job.progress = 'deploying (checkOnly=false)';

    // Quick deploy when the validation ran tests: the org deploys the
    // package it already validated (same bytes, its own guarantee) without
    // re-running the tests. Both faster and STRICTER than replaying the zip —
    // nothing between validation and execution can substitute a package.
    // NoTestRun validations are not eligible; any org-side refusal falls back
    // to the classic full deploy of the stored zip.
    // With an EXPLICIT level, eligibility is knowable locally. With the level
    // omitted, the org chose: production defaults to running local tests when
    // the package carries Apex (quick-deployable), sandboxes to none. Try the
    // quick path for production and let the org's refusal fall back — the
    // catch below already handles exactly that.
    const quickEligible =
      typeof request.validationId === 'string' &&
      request.validationId.length > 0 &&
      (options.testLevel !== undefined
        ? options.testLevel !== 'NoTestRun'
        : conn.orgType === 'production');
    let quickDeploy = false;
    let quickFallbackReason: string | null = null;

    let deployId: string | undefined;
    let result;
    try {
      if (quickEligible) {
        try {
          deployId = await soap.deployRecentValidation(request.validationId as string);
          quickDeploy = true;
        } catch (err) {
          quickFallbackReason = String(err instanceof Error ? err.message : err).slice(0, 300);
          deployId = await soap.deploy(zip, {
            checkOnly: false,
            testLevel: options.testLevel,
            runTests: options.runTests ?? [],
          });
        }
      } else {
        deployId = await soap.deploy(zip, {
          checkOnly: false,
          testLevel: options.testLevel,
          runTests: options.runTests ?? [],
        });
      }
      result = await this.pollDeploy(soap, deployId, job, async (id) => {
        // On timeout, try to cancel the in-flight deploy so it does not
        // commit after we have given up waiting.
        await soap.cancelDeploy(id);
      });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      this.audit.record('deploy.execution_failed', {
        connectionId: conn.id,
        tool: 'execute_deploy',
        outcome: 'error',
        detail: { requestId: request.id, error: message },
      });
      // S45 F4: outcome unknown (a timeout after a best-effort cancel, or a
      // transport error) — the deploy MAY have committed, so the pre-images
      // are KEPT and finalized with outcome:'unknown'.
      const revert = this.finalizeRevert(conn, request, summary, {
        targetCheck,
        unknown: { error: message, ...(deployId ? { deployId } : {}) },
      });
      const kept = revert.revert_package?.dir;
      return this.finishExecution(conn, request, 'execution_failed', {
        connection: conn.alias,
        deployed: false,
        error_message: message,
        note:
          'The deploy did not complete cleanly. The confirmation code is spent — check the ' +
          'org (Setup → Deployment Status) before retrying, and re-validate for a new code.' +
          (typeof kept === 'string'
            ? ` If it committed, what the org held when this package was validated is kept ` +
              `under ${kept} (revert-plan.json, outcome "unknown").`
            : ''),
        ...checkField,
        ...revert,
      });
    }

    const payload: Record<string, unknown> = {
      connection: conn.alias,
      deployed: result.success,
      status: result.status,
      quick_deploy: quickDeploy,
      ...(quickFallbackReason ? { quick_deploy_fallback: quickFallbackReason } : {}),
      components_deployed: result.numberComponentsDeployed,
      component_errors: result.numberComponentErrors,
      component_failures: result.componentFailures.slice(0, 25),
      tests_run: result.numberTestsTotal,
      test_failures: result.numberTestErrors,
      test_failure_detail: this.gateTestDetail(conn, result),
      changes: summary.changes,
      destructive: summary.destructive,
      ...checkField,
      ...(result.success
        ? { note: 'Deployed. Run refresh_snapshot to bring the local snapshot up to date.' }
        : {
            error_message: result.errorMessage ?? null,
            note: 'Deploy failed and rolled back (rollbackOnError).',
          }),
    };
    this.audit.record(result.success ? 'deploy.executed' : 'deploy.execution_failed', {
      connectionId: conn.id,
      tool: 'execute_deploy',
      outcome: result.success ? 'success' : 'error',
      detail: {
        requestId: request.id,
        deployId,
        validationId: request.validationId,
        componentsDeployed: result.numberComponentsDeployed,
        status: result.status,
      },
    });
    if (result.success) {
      // S45 F4: finalize the revert package immediately before the request
      // is marked executed — inline, not via the (desktop-only, best-effort)
      // ExecutionObserver.
      Object.assign(payload, this.finalizeRevert(conn, request, summary, { targetCheck }));
    } else {
      // The org rolled back (rollbackOnError is pinned true): nothing
      // committed, nothing to revert.
      this.removeRevertDir(request.id);
    }
    return this.finishExecution(
      conn,
      request,
      result.success ? 'executed' : 'execution_failed',
      payload,
    );
  }

  /** Status probe for the approval page: active only while the code is still executable. */
  private requestStatusCheck(requestId: string): () => { active: boolean; status: string } {
    return () => {
      const status = this.db.getDeployRequestStatus(requestId) ?? 'gone';
      return { active: status === 'validated', status };
    };
  }

  /** Persist the terminal outcome, clean up the zip, and return the payload. */
  private finishExecution(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    status: 'executed' | 'execution_failed',
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    this.db.finishDeployRequest(request.id, status, JSON.stringify(payload));
    // Observer runs BEFORE the unlink: it is the last moment the frozen
    // payload (the exact deployed bytes) still exists on disk.
    if (status === 'executed') this.notifyExecuted(request, payload);
    if (request.payloadPath) safeUnlink(request.payloadPath);
    return payload;
  }

  // ── dml ────────────────────────────────────────────────────────────────

  async proposeDml(conn: ConnectionRecord, input: DmlInput): Promise<Record<string, unknown>> {
    const superseded = this.db.supersedePendingRequests(conn.id, 'dml');
    if (superseded > 0) {
      this.audit.record('dml.superseded', {
        connectionId: conn.id,
        tool: 'dml_propose',
        detail: { count: superseded },
      });
    }
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const preview = isDmlPlan(input)
      ? await this.buildDmlPlanPreview(rest, input)
      : await this.buildDmlPreview(rest, input);

    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    const request = this.db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'dml',
      confirmationCode: code,
      expiresAt,
      payloadJson: JSON.stringify(input),
      summaryJson: JSON.stringify(preview),
    });

    const allRows = preview.rows as Array<{
      label: string;
      warnings: string[];
      detail?: string;
      destructive?: boolean;
    }>;
    const rowLabels = allRows.slice(0, 50);
    const extra = allRows.length - rowLabels.length;
    const overflow = extra > 0 ? [{ label: `… and ${extra} more rows`, warnings: [] }] : [];
    // Per-row routing: a plan can MIX operations, so delete steps go to the
    // danger card individually. The flat path keeps its single-operation split.
    const isDelete = (row: { destructive?: boolean }) =>
      isDmlPlan(input) ? row.destructive === true : input.operation === 'delete';
    const changes = [...rowLabels.filter((r) => !isDelete(r)), ...overflow];
    const destructive = rowLabels.filter((r) => isDelete(r));

    // The Mode line is a PROMISE about failure behaviour — it must match what
    // execution will actually do, per plan.
    const allOrNone = isDmlPlan(input) ? input.all_or_none : true;
    const results = isDmlPlan(input)
      ? [
          { label: 'Plan', value: `${input.steps.length} steps` },
          {
            label: 'Operations',
            value: summarizeOps(input.steps),
          },
          {
            label: 'Mode',
            value: allOrNone
              ? 'all-or-none (any failure rolls back every step)'
              : 'continue-on-failure (successful steps are KEPT; steps referencing a failed step fail)',
          },
        ]
      : [
          { label: 'Operation', value: `${input.operation.toUpperCase()} ${input.object}` },
          { label: 'Rows', value: String(preview.row_count) },
          { label: 'Mode', value: 'all-or-none (any failure rolls back every row)' },
        ];

    const view: ApprovalPageOptions = {
      kind: 'dml',
      code,
      expiresAt,
      org: {
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        instanceUrl: conn.instanceUrl,
      },
      changes,
      destructive,
      automation: this.automationCard(
        conn,
        isDmlPlan(input) ? input.steps.map((s) => s.object) : [input.object],
      ),
      results,
      blast: [],
      ...(isDmlPlan(input) && !input.all_or_none
        ? {
            warnings: [
              'This plan is NOT atomic — approve only if partial completion is acceptable.',
            ],
          }
        : {}),
    };
    const approval = await this.approvals.present(
      renderApprovalPage(view),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );
    const phone = await this.notifyApproval(view, request.id, conn.id, 'page');

    this.audit.record('dml.proposed', {
      connectionId: conn.id,
      tool: 'dml_propose',
      detail: isDmlPlan(input)
        ? {
            requestId: request.id,
            plan: true,
            steps: input.steps.length,
            operations: summarizeOps(input.steps),
            all_or_none: input.all_or_none,
          }
        : {
            requestId: request.id,
            operation: input.operation,
            object: input.object,
            rows: preview.row_count,
          },
    });
    // S45 F2: the pre-check's before-values, found ids and verdict are the
    // execute-time guard's data (persisted untruncated in summaryJson above),
    // not agent-facing — the tool result carries the page's rows only.
    const { before, found, precheck, ...shown } = preview;
    return {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      ...shown,
      expires_at: expiresAt,
      approval_page: { ...approvalForAgent('dml', approval), phone_notification: phone },
    };
  }

  async executeDml(conn: ConnectionRecord, code: string): Promise<Record<string, unknown>> {
    // S45 F2: SYNC read-only peek (never counts an attempt) → the
    // execute-time guard inline, ahead of the claim. A wrong, spent or
    // expired code skips the guard and meets claimCode's accounting as today.
    let targetCheck: Record<string, unknown> | undefined;
    const peek = this.db.findRequestByCode(conn.id, 'dml', code);
    if (
      peek &&
      peek.status === 'validated' &&
      new Date(peek.expiresAt).getTime() >= Date.now()
    ) {
      const guard = await this.preflightTargetMoved(conn, 'dml', peek, 'dml_execute', {
        deadlineMs: TARGET_CHECK_DEADLINE_MS,
      });
      if (guard.verdict === 'moved') return guard.result;
      if (guard.verdict === 'proceed') targetCheck = guard.targetCheck;
    }
    const claim = this.claimCode(conn, 'dml', code, 'dml_execute');
    if (claim.kind === 'terminal') return claim.result;
    if (claim.kind === 'running') {
      return {
        connection: conn.alias,
        executed: false,
        note: 'This change is already being executed by a concurrent call — not re-applied.',
      };
    }
    const request = claim.request;
    const input = JSON.parse(request.payloadJson ?? '{}') as DmlInput;
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    if (isDmlPlan(input)) {
      return this.executeDmlPlan(conn, rest, request, input, targetCheck);
    }
    const version = this.config.salesforce.apiVersion;
    const checkField = targetCheck ? { target_check: targetCheck } : {};

    let results: Array<{ id?: string; success: boolean; errors?: unknown[] }>;
    try {
      if (input.operation === 'delete') {
        const ids = input.ids ?? [];
        const res = await rest.request(
          `/services/data/${version}/composite/sobjects?ids=${ids.join(',')}&allOrNone=true`,
          { method: 'DELETE' },
        );
        results = (await res.json()) as typeof results;
      } else {
        const records = (input.records ?? []).map((r) => ({
          attributes: { type: input.object },
          ...r,
        }));
        const res = await rest.request(`/services/data/${version}/composite/sobjects`, {
          method: input.operation === 'insert' ? 'POST' : 'PATCH',
          body: JSON.stringify({ allOrNone: true, records }),
        });
        results = (await res.json()) as typeof results;
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const payload = {
        connection: conn.alias,
        operation: input.operation,
        object: input.object,
        executed: false,
        error_message: message,
        note:
          'The change did not complete. The confirmation code is spent — verify the org state ' +
          'and re-propose for a fresh code if you still want the change.',
        ...checkField,
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(payload));
      this.audit.record('dml.execution_failed', {
        connectionId: conn.id,
        tool: 'dml_execute',
        outcome: 'error',
        detail: { requestId: request.id, error: message },
      });
      return payload;
    }

    const failures = results.filter((r) => !r.success);
    const succeeded = failures.length === 0;
    // Created ids used to be thrown away — the agent needs them for follow-up
    // work (and cleanup plans need them to name their targets).
    const createdIds =
      input.operation === 'insert'
        ? results.filter((r) => r.success && r.id).map((r) => r.id as string)
        : [];
    const payload = {
      connection: conn.alias,
      operation: input.operation,
      object: input.object,
      executed: succeeded,
      rows: results.length,
      ...(createdIds.length ? { created_ids: createdIds } : {}),
      failures: failures.slice(0, 25).map((f) => stripAttributes(f)),
      ...checkField,
      ...(succeeded
        ? {}
        : { note: 'all-or-none: every row was rolled back because at least one failed.' }),
    };
    this.db.finishDeployRequest(request.id, succeeded ? 'executed' : 'execution_failed', JSON.stringify(payload));
    if (succeeded) this.notifyExecuted(request, payload);
    this.audit.record(succeeded ? 'dml.executed' : 'dml.execution_failed', {
      connectionId: conn.id,
      tool: 'dml_execute',
      outcome: succeeded ? 'success' : 'error',
      detail: {
        requestId: request.id,
        operation: input.operation,
        object: input.object,
        rows: results.length,
        failures: failures.length,
      },
    });
    return payload;
  }

  /**
   * Execute an approved multi-step plan as ONE Composite API call. Reference
   * tokens are passed through verbatim — the org substitutes created ids
   * server-side, so ids never transit the agent. Success is judged per
   * subrequest httpStatusCode (the top-level call returns 200 even when steps
   * failed — there is no `success` flag to read here).
   */
  private async executeDmlPlan(
    conn: ConnectionRecord,
    rest: RestClient,
    request: DeployRequestRecord,
    input: DmlPlanInput,
    // S45 F2: the execute-time guard's verdict, reported as target_check.
    targetCheck?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const version = this.config.salesforce.apiVersion;
    const checkField = targetCheck ? { target_check: targetCheck } : {};
    const refIds = input.steps.map((s, i) => stepReferenceId(s, i));
    const subrequests: CompositeSubrequest[] = input.steps.map((step, i) => {
      const base = `/services/data/${version}/sobjects/${step.object}`;
      if (step.operation === 'insert') {
        return { method: 'POST' as const, url: base, referenceId: refIds[i]!, body: step.record ?? {} };
      }
      if (step.operation === 'update') {
        return {
          method: 'PATCH' as const,
          url: `${base}/${step.id}`,
          referenceId: refIds[i]!,
          body: step.record ?? {},
        };
      }
      return { method: 'DELETE' as const, url: `${base}/${step.id}`, referenceId: refIds[i]! };
    });

    let responses: CompositeSubresponse[];
    try {
      responses = (await rest.composite(subrequests, input.all_or_none)).compositeResponse;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const payload = {
        connection: conn.alias,
        plan: true,
        all_or_none: input.all_or_none,
        executed: false,
        error_message: message,
        note:
          'The plan did not complete. The confirmation code is spent — verify the org state ' +
          'and re-propose for a fresh code if you still want the change.',
        ...checkField,
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(payload));
      this.audit.record('dml.execution_failed', {
        connectionId: conn.id,
        tool: 'dml_execute',
        outcome: 'error',
        detail: { requestId: request.id, plan: true, error: message },
      });
      return payload;
    }

    const byRef = new Map(responses.map((r) => [r.referenceId, r]));
    // Which refs actually failed (non-2xx, not counting rollback/halt markers)?
    // PROCESSING_HALTED is overloaded: with all_or_none it marks rolled-back or
    // halted SIBLINGS of the real failure; without it, it marks steps whose
    // referenced step failed. Classify accordingly or the report lies.
    const errorCodeOf = (r: CompositeSubresponse | undefined): string | null => {
      const body = r?.body;
      if (Array.isArray(body) && body[0] && typeof body[0] === 'object') {
        return String((body[0] as { errorCode?: unknown }).errorCode ?? '');
      }
      return null;
    };

    const steps = input.steps.map((step, i) => {
      const ref = refIds[i]!;
      const res = byRef.get(ref);
      const status = res?.httpStatusCode ?? 0;
      const ok = status >= 200 && status < 300;
      const halted = errorCodeOf(res) === 'PROCESSING_HALTED';
      const outcome = ok
        ? 'succeeded'
        : halted
          ? input.all_or_none
            ? 'rolled_back'
            : 'dependent_failed'
          : 'failed';
      const createdId =
        ok && step.operation === 'insert' && res && typeof res.body === 'object' && res.body
          ? ((res.body as { id?: string }).id ?? null)
          : null;
      return {
        step: i + 1,
        ...(step.ref ? { ref: step.ref } : {}),
        operation: step.operation,
        object: step.object,
        status: outcome,
        ...(createdId ? { id: createdId } : {}),
        ...(!ok && !halted ? { errors: res?.body ?? null } : {}),
      };
    });

    const failedCount = steps.filter((s) => s.status !== 'succeeded').length;
    const createdIds: Record<string, string> = {};
    for (const s of steps) {
      if (s.ref && 'id' in s && typeof s.id === 'string') createdIds[s.ref] = s.id;
    }

    const executed = failedCount === 0;
    // Atomic: any failure means the org rolled everything back — the request
    // failed as a unit. Non-atomic: partial success is a real (approved-as-such)
    // outcome; only a total loss counts as execution_failed.
    const terminalStatus = input.all_or_none
      ? executed
        ? 'executed'
        : 'execution_failed'
      : steps.some((s) => s.status === 'succeeded')
        ? 'executed'
        : 'execution_failed';

    const payload = {
      connection: conn.alias,
      plan: true,
      all_or_none: input.all_or_none,
      executed,
      steps,
      ...(Object.keys(createdIds).length ? { created_ids: createdIds } : {}),
      failures: steps.filter((s) => s.status === 'failed'),
      ...checkField,
      ...(executed
        ? {}
        : {
            note: input.all_or_none
              ? 'all-or-none: every step was rolled back because at least one failed.'
              : 'continue-on-failure: successful steps were KEPT; failed/dependent steps were not applied.',
          }),
    };
    this.db.finishDeployRequest(request.id, terminalStatus, JSON.stringify(payload));
    if (terminalStatus === 'executed') this.notifyExecuted(request, payload);
    this.audit.record(executed ? 'dml.executed' : 'dml.execution_failed', {
      connectionId: conn.id,
      tool: 'dml_execute',
      outcome: executed ? 'success' : 'error',
      detail: {
        requestId: request.id,
        plan: true,
        steps: steps.length,
        failures: failedCount,
        all_or_none: input.all_or_none,
      },
    });
    return payload;
  }

  // ── anonymous apex ─────────────────────────────────────────────────────

  /**
   * Stage an anonymous Apex script behind the same two-step ritual as deploys
   * and DML (kind 'apex'). There is no checkOnly for executeAnonymous — the
   * org compiles AND runs the script in one shot at execute — so the approval
   * page carries the script verbatim plus the sharpest warning in the product,
   * and a compile error at execute spends the code exactly like a failed DML.
   */
  async proposeApex(conn: ConnectionRecord, script: string): Promise<Record<string, unknown>> {
    const superseded = this.db.supersedePendingRequests(conn.id, 'apex');
    if (superseded > 0) {
      this.audit.record('apex.superseded', {
        connectionId: conn.id,
        tool: 'apex_propose',
        detail: { count: superseded },
      });
    }
    const lines = script.split(/\r?\n/).length;
    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    const request = this.db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'apex',
      confirmationCode: code,
      expiresAt,
      payloadJson: JSON.stringify({ apex: true, code: script }),
      summaryJson: JSON.stringify({ lines, chars: script.length }),
    });

    const apexObjects = this.apexScriptObjects(conn, script);
    const view: ApprovalPageOptions = {
      kind: 'apex',
      code,
      expiresAt,
      org: {
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        instanceUrl: conn.instanceUrl,
      },
      changes: [
        {
          label: `Execute anonymous Apex (${lines} line${lines === 1 ? '' : 's'}, ${script.length} chars)`,
          warnings: [],
          // The full script, verbatim — the human is approving these exact
          // bytes, so nothing may be elided (.chg-detail renders pre-wrap).
          detail: script,
        },
      ],
      destructive: [],
      automation: this.automationCard(conn, apexObjects ?? []),
      // No object found in the text: the card still renders, saying so, with
      // the not_covered lines (a failed parse keeps today's no-card page).
      ...(apexObjects !== null && apexObjects.length === 0
        ? { automationNotCovered: [...NOT_COVERED] }
        : {}),
      results: [
        {
          label: 'Validation',
          value: 'none — the org compiles and runs the script only when you approve',
        },
        { label: 'Runs as', value: conn.username ?? 'the connected user' },
      ],
      blast: [],
      warnings: [
        'ANONYMOUS APEX — this script runs with YOUR permissions and can read or write ' +
          'anything your user can. DML it performs COMMITS on success (nothing rolls back ' +
          'unless the script throws). Read every line below before approving.',
      ],
    };
    const approval = await this.approvals.present(
      renderApprovalPage(view),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );
    const phone = await this.notifyApproval(view, request.id, conn.id, 'page');

    this.audit.record('apex.proposed', {
      connectionId: conn.id,
      tool: 'apex_propose',
      detail: { requestId: request.id, lines, chars: script.length },
    });
    return {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      lines,
      chars: script.length,
      expires_at: expiresAt,
      approval_page: { ...approvalForAgent('apex', approval), phone_notification: phone },
    };
  }

  async executeApex(conn: ConnectionRecord, code: string): Promise<Record<string, unknown>> {
    const claim = this.claimCode(conn, 'apex', code, 'apex_execute');
    if (claim.kind === 'terminal') return claim.result;
    if (claim.kind === 'running') {
      return {
        connection: conn.alias,
        executed: false,
        note: 'This script is already being executed by a concurrent call — not re-run.',
      };
    }
    const request = claim.request;
    const payload = JSON.parse(request.payloadJson ?? '{}') as { apex?: boolean; code?: string };
    const script = typeof payload.code === 'string' ? payload.code : '';
    if (payload.apex !== true || script.length === 0) {
      const result = {
        connection: conn.alias,
        executed: false,
        error_message: 'The approved script is missing from the request payload.',
        note: 'Propose again for a fresh code.',
        target_check: { ...TARGET_CHECK_NOT_APPLICABLE },
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(result));
      this.audit.record('apex.execution_failed', {
        connectionId: conn.id,
        tool: 'apex_execute',
        outcome: 'error',
        detail: { requestId: request.id, reason: 'payload_missing' },
      });
      return result;
    }

    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    // executeAnonymous is a GET with the script URL-encoded into the query
    // string (the Tooling API quirk that motivates the propose-time size cap).
    let exec: {
      line: number;
      column: number;
      compiled: boolean;
      success: boolean;
      compileProblem: string | null;
      exceptionMessage: string | null;
      exceptionStackTrace: string | null;
    };
    try {
      const res = await rest.request(
        `/services/data/${this.config.salesforce.apiVersion}/tooling/executeAnonymous/` +
          `?anonymousBody=${encodeURIComponent(script)}`,
      );
      exec = (await res.json()) as typeof exec;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const result = {
        connection: conn.alias,
        executed: false,
        error_message: message,
        note:
          'The request did not complete cleanly — the script may or may not have run. The ' +
          'confirmation code is spent; check the org (debug logs, affected records) before ' +
          'proposing it again.',
        target_check: { ...TARGET_CHECK_NOT_APPLICABLE },
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(result));
      this.audit.record('apex.execution_failed', {
        connectionId: conn.id,
        tool: 'apex_execute',
        outcome: 'error',
        detail: { requestId: request.id, error: message },
      });
      return result;
    }

    const status = !exec.compiled ? 'compile_error' : exec.success ? 'executed' : 'runtime_error';

    // Best-effort: tell the agent when a debug log of this run exists. Never
    // let this probe sink the honest execution result.
    let debugLogNote: string | null = null;
    if (exec.compiled && conn.userId) {
      try {
        const nowLiteral = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const flags = await rest.toolingQuery<{ Id: string }>(
          `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${conn.userId}' ` +
            `AND ExpirationDate > ${nowLiteral} LIMIT 1`,
          1,
        );
        if (flags.length > 0) {
          debugLogNote =
            'A trace flag was active for your user — a debug log of this run exists (get_debug_logs).';
        }
      } catch {
        // The log hint is a courtesy; the execution result stands on its own.
      }
    }

    const result: Record<string, unknown> = {
      connection: conn.alias,
      executed: status === 'executed',
      status,
      // S45 F2: an anonymous script has no fixed org target to re-read.
      target_check: { ...TARGET_CHECK_NOT_APPLICABLE },
      ...(status === 'compile_error'
        ? {
            compile_error: {
              line: exec.line,
              column: exec.column,
              problem: exec.compileProblem,
            },
            note:
              'The script did not compile — nothing ran and nothing changed in the org. The ' +
              'code is spent; fix the script and propose again.',
          }
        : {}),
      ...(status === 'runtime_error'
        ? {
            runtime_error: {
              exception_message: exec.exceptionMessage,
              stack_trace: exec.exceptionStackTrace,
            },
            note:
              'The script threw an uncaught exception — the whole transaction rolled back, so ' +
              'its DML was NOT committed. The code is spent; propose again after fixing.',
          }
        : {}),
      ...(status === 'executed'
        ? {
            note:
              'Executed — any DML the script performed is COMMITTED. executeAnonymous returns ' +
              'no output; System.debug lines are visible only in a debug log (set_trace_flag ' +
              'before the run next time if you need one).',
          }
        : {}),
      ...(debugLogNote ? { debug_log: debugLogNote } : {}),
    };
    this.db.finishDeployRequest(
      request.id,
      status === 'executed' ? 'executed' : 'execution_failed',
      JSON.stringify(result),
    );
    if (status === 'executed') this.notifyExecuted(request, result);
    this.audit.record(status === 'executed' ? 'apex.executed' : 'apex.execution_failed', {
      connectionId: conn.id,
      tool: 'apex_execute',
      outcome: status === 'executed' ? 'success' : 'error',
      detail: { requestId: request.id, status },
    });
    return result;
  }

  // ── agent activation (S34) ─────────────────────────────────────────────

  /**
   * Stage an agent activation change behind the ritual (kind 'activation').
   * The documented Connect REST resource (/connect/bot-versions/{id}/
   * activation, v50+) flips a PUBLISHED BotVersion Active/Inactive — live
   * behavior, immediately, so it rides the same two-step approval as every
   * write. Resolution happens AT PROPOSE TIME: the BotVersion Id and its
   * current status are frozen into the payload, and execute re-GETs after
   * the POST so the result reports what the org confirms, never what was
   * requested. Compiling/publishing Agent Script remains out of scope — this
   * flips existing published versions only, and the org's own messages[]
   * explain refusals (e.g. an unpublished version) verbatim.
   */
  async proposeActivation(
    conn: ConnectionRecord,
    input: { agent: string; version: string; status: 'Active' | 'Inactive' },
  ): Promise<Record<string, unknown>> {
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const rows = await rest.query<{
      Id: string;
      DeveloperName: string;
      Status: string;
    }>(
      `SELECT Id, DeveloperName, Status FROM BotVersion ` +
        `WHERE BotDefinition.DeveloperName = '${esc(input.agent)}' ORDER BY DeveloperName`,
    );
    if (rows.length === 0) {
      throw new ContrailError(
        `No agent named "${input.agent}" in "${conn.alias}" — enumerate agents with ` +
          `soql_query on BotDefinition (SELECT DeveloperName FROM BotDefinition) or ` +
          `list_metadata type Bot.`,
        'not_found',
      );
    }
    const version = rows.find((r) => r.DeveloperName === input.version);
    if (!version) {
      throw new ContrailError(
        `Agent "${input.agent}" has no version "${input.version}". Its versions: ` +
          rows.map((r) => `${r.DeveloperName} (${r.Status})`).join(', ') +
          '.',
        'not_found',
      );
    }
    if (version.Status === input.status) {
      // No ritual burned — there is nothing to approve.
      return {
        connection: conn.alias,
        agent: input.agent,
        version: input.version,
        status: version.Status,
        proposed: false,
        note: `BotVersion ${input.version} of ${input.agent} is already ${version.Status} — nothing to approve.`,
      };
    }

    const superseded = this.db.supersedePendingRequests(conn.id, 'activation');
    if (superseded > 0) {
      this.audit.record('activation.superseded', {
        connectionId: conn.id,
        tool: 'agent_activation_propose',
        detail: { count: superseded },
      });
    }
    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    const verb = input.status === 'Active' ? 'ACTIVATE' : 'DEACTIVATE';
    const label = `${verb} ${input.agent} ${input.version} (currently ${version.Status})`;
    const request = this.db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'activation',
      confirmationCode: code,
      expiresAt,
      payloadJson: JSON.stringify({
        activation: true,
        version: 1,
        bot_developer_name: input.agent,
        bot_version_developer_name: input.version,
        bot_version_id: version.Id,
        from_status: version.Status,
        to_status: input.status,
      }),
      summaryJson: JSON.stringify({ rows: [{ label, warnings: [] }] }),
    });

    const view: ApprovalPageOptions = {
      kind: 'activation',
      code,
      expiresAt,
      org: {
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        instanceUrl: conn.instanceUrl,
      },
      changes: [
        {
          label,
          warnings: [],
          detail:
            `BotVersion ${version.Id}\n` +
            `status ${version.Status} → ${input.status}\n` +
            `POST /connect/bot-versions/${version.Id}/activation`,
        },
      ],
      destructive: [],
      results: [
        {
          label: 'Validation',
          value: 'none — the org accepts or refuses the change only when you approve',
        },
      ],
      blast: [],
      warnings: [
        'LIVE AGENT BEHAVIOR — this changes what users experience IMMEDIATELY. ' +
          'Deactivating takes the agent version offline on every channel it serves; ' +
          'activating puts this version in front of users. This is not a metadata ' +
          'deploy: there is no draft in between.',
      ],
    };
    const approval = await this.approvals.present(
      renderApprovalPage(view),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );
    const phone = await this.notifyApproval(view, request.id, conn.id, 'page');

    this.audit.record('activation.proposed', {
      connectionId: conn.id,
      tool: 'agent_activation_propose',
      detail: {
        requestId: request.id,
        agent: input.agent,
        version: input.version,
        from: version.Status,
        to: input.status,
      },
    });
    return {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      agent: input.agent,
      version: input.version,
      bot_version_id: version.Id,
      current_status: version.Status,
      requested_status: input.status,
      proposed: true,
      expires_at: expiresAt,
      approval_page: { ...approvalForAgent('activation', approval), phone_notification: phone },
    };
  }

  async executeActivation(conn: ConnectionRecord, code: string): Promise<Record<string, unknown>> {
    // S45 F2: SYNC read-only peek → the execute-time guard inline (Status
    // vs the frozen from_status), ahead of the claim.
    let targetCheck: Record<string, unknown> | undefined;
    const peek = this.db.findRequestByCode(conn.id, 'activation', code);
    if (
      peek &&
      peek.status === 'validated' &&
      new Date(peek.expiresAt).getTime() >= Date.now()
    ) {
      const guard = await this.preflightTargetMoved(
        conn,
        'activation',
        peek,
        'agent_activation_execute',
        { deadlineMs: TARGET_CHECK_DEADLINE_MS },
      );
      if (guard.verdict === 'moved') return guard.result;
      if (guard.verdict === 'proceed') targetCheck = guard.targetCheck;
    }
    const checkField = targetCheck ? { target_check: targetCheck } : {};
    const claim = this.claimCode(conn, 'activation', code, 'agent_activation_execute');
    if (claim.kind === 'terminal') return claim.result;
    if (claim.kind === 'running') {
      return {
        connection: conn.alias,
        executed: false,
        note: 'This activation change is already being executed by a concurrent call — not re-run.',
      };
    }
    const request = claim.request;
    const payload = JSON.parse(request.payloadJson ?? '{}') as {
      activation?: boolean;
      bot_developer_name?: string;
      bot_version_developer_name?: string;
      bot_version_id?: string;
      from_status?: string;
      to_status?: string;
    };
    if (payload.activation !== true || !payload.bot_version_id || !payload.to_status) {
      // No target_check here: nothing was submitted, so a note saying the
      // change "ran" unverified would be false.
      const result = {
        connection: conn.alias,
        executed: false,
        error_message: 'The approved activation change is missing from the request payload.',
        note: 'Propose again for a fresh code.',
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(result));
      this.audit.record('activation.execution_failed', {
        connectionId: conn.id,
        tool: 'agent_activation_execute',
        outcome: 'error',
        detail: { requestId: request.id, reason: 'payload_missing' },
      });
      return result;
    }

    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const resource =
      `/services/data/${this.config.salesforce.apiVersion}` +
      `/connect/bot-versions/${payload.bot_version_id}/activation`;
    let posted: { isActivated?: boolean; messages?: unknown[]; success?: boolean };
    let confirmed: { isActivated?: boolean } = {};
    try {
      const res = await rest.request(resource, {
        method: 'POST',
        body: JSON.stringify({ status: payload.to_status }),
      });
      posted = (await res.json()) as typeof posted;
      // The re-GET is the truth: the result reports what the org CONFIRMS,
      // never what was requested.
      const check = await rest.request(resource);
      confirmed = (await check.json()) as typeof confirmed;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const result = {
        connection: conn.alias,
        executed: false,
        agent: payload.bot_developer_name,
        version: payload.bot_version_developer_name,
        error_message: message,
        note:
          'The request did not complete cleanly — the change may or may not have applied. ' +
          'The confirmation code is spent; check BotVersion.Status (soql_query) before ' +
          'proposing again.',
        ...checkField,
      };
      this.db.finishDeployRequest(request.id, 'execution_failed', JSON.stringify(result));
      this.audit.record('activation.execution_failed', {
        connectionId: conn.id,
        tool: 'agent_activation_execute',
        outcome: 'error',
        detail: { requestId: request.id, error: message },
      });
      return result;
    }

    // A confirm body missing isActivated is UNCONFIRMED, never a match —
    // executed:true requires the org positively reporting the requested state.
    const confirmedStatus =
      confirmed.isActivated === true
        ? 'Active'
        : confirmed.isActivated === false
          ? 'Inactive'
          : 'unconfirmed';
    const executed = confirmedStatus === payload.to_status;
    const result = {
      connection: conn.alias,
      executed,
      agent: payload.bot_developer_name,
      version: payload.bot_version_developer_name,
      bot_version_id: payload.bot_version_id,
      requested_status: payload.to_status,
      confirmed_status: confirmedStatus,
      is_activated: confirmed.isActivated === true,
      // The platform explains refusals (e.g. an unpublished version) here.
      messages: posted.messages ?? [],
      ...checkField,
      note: executed
        ? `${payload.bot_developer_name} ${payload.bot_version_developer_name} is now ` +
          `${confirmedStatus}. This changed live behavior — no deploy or refresh follows.`
        : `The org did not confirm the change: requested ${payload.to_status}, org reports ` +
          `${confirmedStatus}. Read messages[] — the code is spent either way.`,
    };
    this.db.finishDeployRequest(
      request.id,
      executed ? 'executed' : 'execution_failed',
      JSON.stringify(result),
    );
    if (executed) this.notifyExecuted(request, result);
    this.audit.record(executed ? 'activation.executed' : 'activation.execution_failed', {
      connectionId: conn.id,
      tool: 'agent_activation_execute',
      outcome: executed ? 'success' : 'error',
      detail: {
        requestId: request.id,
        agent: payload.bot_developer_name,
        version: payload.bot_version_developer_name,
        to: payload.to_status,
        confirmed: confirmedStatus,
      },
    });
    return result;
  }

  // ── bulk data loads ────────────────────────────────────────────────────

  /**
   * S40: delete bulk results directories older than
   * bulkLoad.resultsRetentionDays (0 = keep forever). Best-effort by
   * design — a sweep failure must never block a propose.
   */
  private sweepBulkResultDirs(): void {
    const days = this.config.bulkLoad.resultsRetentionDays;
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(deploysDir())) {
        if (!name.endsWith('-results')) continue;
        const full = path.join(deploysDir(), name);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory() && stat.mtimeMs < cutoff) {
            fs.rmSync(full, { recursive: true, force: true });
            this.audit.record('bulk.results_swept', {
              detail: { dir: name, ageDays: Math.round((Date.now() - stat.mtimeMs) / 86_400_000) },
            });
          }
        } catch {
          // One unreadable entry never stops the sweep.
        }
      }
    } catch {
      // Missing deploys dir on a fresh install — nothing to sweep.
    }
  }

  /**
   * Stage a bulk load plan behind the ritual (kind 'bulk'): scan and FREEZE
   * the CSVs now, show the whole plan on one approval page, and let the
   * human's code arm executeBulkLoad. Rows never transit the model — the
   * agent gets back counts, columns, and hashes, never data. Editing a source
   * file after approval changes nothing: execute reads only the frozen copies
   * and re-verifies their hashes.
   */
  async proposeBulkLoad(
    conn: ConnectionRecord,
    input: BulkLoadInput,
  ): Promise<Record<string, unknown>> {
    const maxSteps = this.config.bulkLoad.maxFilesPerPlan;
    if (input.steps.length === 0) {
      throw new ContrailError('a bulk plan needs at least one step', 'bad_bulk_plan');
    }
    if (input.steps.length > maxSteps) {
      throw new ContrailError(
        `this plan has ${input.steps.length} steps; the limit is ${maxSteps} ` +
          `(bulkLoad.maxFilesPerPlan in config.json)`,
        'bulk_plan_too_large',
      );
    }
    for (let i = 0; i < input.steps.length; i++) {
      const s = input.steps[i]!;
      const where = `step ${i + 1}`;
      if (!/^[A-Za-z0-9_]+$/.test(s.object)) {
        throw new ContrailError(`${where}: invalid object API name`, 'bad_bulk_plan');
      }
      if (s.operation === 'upsert' && !s.externalIdField) {
        throw new ContrailError(
          `${where}: upsert requires external_id_field (pass 'Id' to update by record id)`,
          'bad_bulk_plan',
        );
      }
      if (s.operation !== 'upsert' && s.externalIdField) {
        throw new ContrailError(
          `${where}: external_id_field is only meaningful for upsert — ` +
            (s.operation === 'delete'
              ? 'delete matches on the Id column of the CSV'
              : 'insert never matches existing rows') +
            '; remove it',
          'bad_bulk_plan',
        );
      }
      if (s.externalIdField && !/^[A-Za-z0-9_]+$/.test(s.externalIdField)) {
        throw new ContrailError(`${where}: invalid external_id_field`, 'bad_bulk_plan');
      }
    }

    // S40: retention sweep. Results directories survive execution so the
    // human can open failed/success exports afterward — but not forever.
    // Swept here (the next bulk propose) instead of a background job; a
    // sweep failure never blocks the propose.
    this.sweepBulkResultDirs();

    const superseded = this.db.supersedePendingRequests(conn.id, 'bulk');
    if (superseded > 0) {
      for (const p of this.db.takeSupersededPayloadPaths(conn.id, 'bulk')) safeUnlink(p);
      this.audit.record('bulk.superseded', {
        connectionId: conn.id,
        tool: 'bulk_load_propose',
        detail: { count: superseded },
      });
    }

    // Stage-then-rename: scan/freeze into a temp dir first, so a failed scan
    // never leaves an orphaned request row or a half-frozen payload dir.
    const stageDir = path.join(deploysDir(), `bulk-stage-${crypto.randomUUID()}`);
    fs.mkdirSync(stageDir, { recursive: true });
    const manifest: BulkManifest = {
      bulk: true,
      version: 1,
      stop_on_failure: input.stopOnFailure,
      steps: [],
    };
    const scanWarnings: string[][] = [];
    try {
      for (let i = 0; i < input.steps.length; i++) {
        const s = input.steps[i]!;
        const n = i + 1;
        const label = `step ${n} (${s.displayName})`;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(s.sourcePath);
        } catch {
          throw new ContrailError(`${label}: the file does not exist`, 'source_not_found');
        }
        if (!stat.isFile()) {
          throw new ContrailError(`${label}: not a regular file`, 'bad_source_path');
        }
        if (stat.size > this.config.bulkLoad.maxFileBytes) {
          throw new ContrailError(
            `${label}: ${stat.size} bytes exceeds the ${this.config.bulkLoad.maxFileBytes}-byte ` +
              `bulk file limit (bulkLoad.maxFileBytes in config.json)`,
            'source_too_large',
          );
        }
        const bytes = fs.readFileSync(s.sourcePath);
        // S40: .tsv files are TAB-delimited — the scanner, the frozen copy,
        // and the ingest job's columnDelimiter all follow the extension.
        const isTsv = s.sourcePath.toLowerCase().endsWith('.tsv');
        let scan;
        try {
          scan = scanCsv(bytes, isTsv ? '\t' : ',');
        } catch (err) {
          throw new ContrailError(
            `${label}: ${err instanceof Error ? err.message : String(err)}`,
            'bad_csv',
          );
        }
        if (s.operation === 'delete') {
          if (scan.headers.length !== 1 || scan.headers[0]!.toLowerCase() !== 'id') {
            throw new ContrailError(
              `${label}: a Bulk delete CSV is a single Id column — this file's header is ` +
                `[${scan.headers.slice(0, 8).join(', ')}${scan.headers.length > 8 ? ', …' : ''}]`,
              'bad_csv',
            );
          }
        }
        if (s.operation === 'upsert') {
          const want = s.externalIdField!.toLowerCase();
          if (!scan.headers.some((h) => h.toLowerCase() === want)) {
            throw new ContrailError(
              `${label}: the upsert match column "${s.externalIdField}" is not in this file's header`,
              'bad_csv',
            );
          }
        }
        // Freeze — BOM stripped (Bulk 2.0 reads a BOM into the first column
        // name), everything else byte-verbatim. The hash fingerprints the
        // FROZEN bytes: that is the file the human approves and the org gets.
        const frozen = scan.hadBom ? bytes.subarray(UTF8_BOM.length) : bytes;
        // S40: the frozen copy keeps the delimiter-declaring extension — a
        // TAB-delimited file named .csv would mis-scan if ever re-proposed.
        const file = `step-${n}.${isTsv ? 'tsv' : 'csv'}`;
        fs.writeFileSync(path.join(stageDir, file), frozen);
        manifest.steps.push({
          n,
          object: s.object,
          operation: s.operation,
          external_id_field: s.externalIdField ?? null,
          file,
          display_name: s.displayName,
          sha256: crypto.createHash('sha256').update(frozen).digest('hex'),
          row_count: scan.rowCount,
          headers: scan.headers,
          line_ending: scan.lineEnding,
          column_delimiter: isTsv ? ('TAB' as const) : ('COMMA' as const),
          bytes: frozen.length,
        });
        scanWarnings.push(scan.warnings);
      }
    } catch (err) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      throw err;
    }

    const totalRows = manifest.steps.reduce((sum, s) => sum + s.row_count, 0);
    const deleteRows = manifest.steps
      .filter((s) => s.operation === 'delete')
      .reduce((sum, s) => sum + s.row_count, 0);
    const rows = manifest.steps.map((m, i) => {
      const matchNote =
        m.operation === 'upsert'
          ? ` (match on ${m.external_id_field}${m.external_id_field === 'Id' ? ' — update' : ''})`
          : '';
      const destructive = m.operation === 'delete';
      return {
        label:
          `STEP ${m.n}  ${m.operation.toUpperCase()} ${m.object} — ` +
          `${m.row_count.toLocaleString('en-US')} row${m.row_count === 1 ? '' : 's'}${matchNote}`,
        detail:
          `from ${m.display_name}\n` +
          `frozen sha256 ${m.sha256.slice(0, 16)}… · ${m.bytes.toLocaleString('en-US')} bytes\n` +
          `columns: ${columnsLabel(m.headers)}`,
        warnings: [
          ...(destructive
            ? [
                'Bulk delete is a SOFT delete — rows go to the Recycle Bin (~15 days). ' +
                  'hardDelete is not offered.',
              ]
            : []),
          ...scanWarnings[i]!,
        ],
        destructive,
      };
    });

    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    // The preview rows deliberately share the DML-plan row shape
    // (label/warnings/detail/destructive) so native review surfaces render
    // them with zero new machinery.
    const preview = {
      bulk: true,
      steps: manifest.steps.length,
      total_rows: totalRows,
      operations: summarizeOps(manifest.steps),
      stop_on_failure: input.stopOnFailure,
      rows,
    };
    let request: DeployRequestRecord;
    try {
      request = this.db.insertDeployRequest({
        connectionId: conn.id,
        kind: 'bulk',
        confirmationCode: code,
        expiresAt,
        payloadJson: JSON.stringify(manifest),
        summaryJson: JSON.stringify(preview),
      });
      const payloadDir = path.join(deploysDir(), request.id);
      fs.renameSync(stageDir, payloadDir);
      this.db.setDeployRequestPayloadPath(request.id, payloadDir);
    } catch (err) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      throw err;
    }

    const view: ApprovalPageOptions = {
      kind: 'bulk',
      code,
      expiresAt,
      org: {
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        instanceUrl: conn.instanceUrl,
      },
      changes: rows.filter((r) => !r.destructive),
      destructive: rows.filter((r) => r.destructive),
      automation: this.automationCard(conn, manifest.steps.map((s) => s.object)),
      results: [
        {
          label: 'Plan',
          value:
            `${manifest.steps.length} step${manifest.steps.length === 1 ? '' : 's'} / ` +
            `${totalRows.toLocaleString('en-US')} rows total`,
        },
        { label: 'Operations', value: summarizeOps(manifest.steps) },
        {
          // A PROMISE about failure behaviour — it must match what
          // doExecuteBulk actually does.
          label: 'Mode',
          value: input.stopOnFailure
            ? 'stop-on-failure (a step with failed rows halts later steps; rows already ' +
              'loaded STAY — there is no cross-job rollback)'
            : 'continue-on-failure (every step runs; rows already loaded STAY — no ' +
              'cross-job rollback)',
        },
      ],
      blast: [],
      warnings: [
        ...(deleteRows > 0
          ? [
              `This plan DELETES ${deleteRows.toLocaleString('en-US')} row(s) ` +
                '(soft delete → Recycle Bin).',
            ]
          : []),
        'Bulk loads are NOT atomic. Each step is its own org-side job; rows loaded by ' +
          'completed steps remain in the org even if a later step fails.',
      ],
    };
    const approval = await this.approvals.present(
      renderApprovalPage(view),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );
    const phone = await this.notifyApproval(view, request.id, conn.id, 'page');

    this.audit.record('bulk.proposed', {
      connectionId: conn.id,
      tool: 'bulk_load_propose',
      detail: {
        requestId: request.id,
        steps: manifest.steps.length,
        operations: summarizeOps(manifest.steps),
        totalRows,
        stopOnFailure: input.stopOnFailure,
      },
    });
    return {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      steps: manifest.steps.map((m) => ({
        step: m.n,
        object: m.object,
        operation: m.operation,
        ...(m.external_id_field ? { external_id_field: m.external_id_field } : {}),
        rows: m.row_count,
        columns: m.headers,
        sha256_prefix: m.sha256.slice(0, 16),
        source: m.display_name,
      })),
      total_rows: totalRows,
      stop_on_failure: input.stopOnFailure,
      expires_at: expiresAt,
      approval_page: { ...approvalForAgent('bulk', approval), phone_notification: phone },
    };
  }

  async executeBulkLoad(
    conn: ConnectionRecord,
    code: string,
  ): Promise<JobOutcome<Record<string, unknown>>> {
    // Resolve the code synchronously (better-sqlite3), before any await, so
    // the atomic claim and job creation cannot interleave with a second call.
    const claim = this.claimCode(conn, 'bulk', code, 'bulk_load_execute');
    if (claim.kind === 'terminal') {
      return { status: 'complete', result: claim.result };
    }
    const jobKey = `bulk-exec:${claim.request.id}`;
    if (claim.kind === 'running' && !this.jobs.has(jobKey)) {
      return {
        status: 'in_progress',
        progress: 'a bulk load for this code is already in progress',
        started_at: claim.request.createdAt,
      };
    }
    return this.runJob(
      jobKey,
      (job) => this.doExecuteBulk(conn, claim.request, job),
      this.config.bulkLoad.toolWaitMs,
    );
  }

  private async doExecuteBulk(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    job?: Job<unknown>,
  ): Promise<Record<string, unknown>> {
    // The code is already spent (status='executing') — any failure below
    // leaves it non-reusable.
    const manifest = JSON.parse(request.payloadJson ?? '{}') as Partial<BulkManifest>;
    if (
      manifest.bulk !== true ||
      !Array.isArray(manifest.steps) ||
      manifest.steps.length === 0 ||
      !request.payloadPath ||
      !fs.existsSync(request.payloadPath)
    ) {
      this.audit.record('bulk.execution_failed', {
        connectionId: conn.id,
        tool: 'bulk_load_execute',
        outcome: 'error',
        detail: { requestId: request.id, reason: 'payload_missing' },
      });
      return this.finishExecution(conn, request, 'execution_failed', {
        connection: conn.alias,
        bulk: true,
        executed: false,
        error_message: 'The frozen CSV payload is missing from disk.',
        note: 'Nothing was sent to the org. Re-propose to freeze the files again.',
        target_check: { ...TARGET_CHECK_NOT_APPLICABLE_BULK },
      });
    }

    const version = this.config.salesforce.apiVersion;
    const rest = new RestClient(this.tokenMgr, conn, version);
    // Results live BESIDE the payload dir, not inside it: finishExecution
    // deletes the spent payload, and the failed-row files must survive that
    // so the human can open them afterwards. Nothing auto-deletes results.
    const resultsDir = path.join(deploysDir(), `${request.id}-results`);
    let resultsDirMade = false;
    const writeResultCsv = (name: string, csv: string): string | null => {
      // The org's exports always carry a header line; only a file with actual
      // rows is worth pointing the human at.
      if (csv.trim().split('\n').length < 2) return null;
      if (!resultsDirMade) {
        fs.mkdirSync(resultsDir, { recursive: true });
        resultsDirMade = true;
      }
      const p = path.join(resultsDir, name);
      fs.writeFileSync(p, csv);
      return p;
    };

    const steps = manifest.steps;
    const total = steps.length;
    const stopOnFailure = manifest.stop_on_failure !== false;
    const stepResults: Array<Record<string, unknown>> = [];
    let haltedAfterStep: number | null = null;
    let anyFailure = false;
    let totalProcessed = 0;
    let totalFailed = 0;

    for (const m of steps) {
      const stepLabel = `step ${m.n}/${total}: ${m.operation.toUpperCase()} ${m.object}`;
      if (job) job.progress = `${stepLabel} — verifying frozen file`;
      const frozenPath = path.join(request.payloadPath, m.file);
      let failedHard: string | null = null;
      let info: IngestJobInfo | null = null;
      let jobId: string | null = null;

      let frozen: Buffer | null = null;
      if (!fs.existsSync(frozenPath)) {
        failedHard = 'the frozen CSV for this step is missing from the payload directory';
      } else {
        frozen = fs.readFileSync(frozenPath);
        const sha = crypto.createHash('sha256').update(frozen).digest('hex');
        if (sha !== m.sha256) {
          failedHard =
            'the frozen CSV no longer matches the hash the human approved ' +
            '(frozen_payload_tampered) — refusing to send it';
          frozen = null;
        }
      }

      if (frozen) {
        try {
          if (job) job.progress = `${stepLabel} — creating ingest job`;
          jobId = await createIngestJob(rest, version, {
            object: m.object,
            operation: m.operation,
            ...(m.external_id_field ? { externalIdFieldName: m.external_id_field } : {}),
            lineEnding: m.line_ending,
            columnDelimiter: m.column_delimiter ?? 'COMMA',
          });
          if (job) {
            job.progress = `${stepLabel} — uploading ${m.row_count.toLocaleString('en-US')} rows`;
          }
          await uploadIngestBatch(rest, version, jobId, frozen);
          await closeIngestJob(rest, version, jobId);
          info = await this.pollBulkJob(rest, jobId, stepLabel, job);
        } catch (err) {
          // A thrown step (API refusal, timeout) is that STEP's failure — it
          // must never skip finishExecution or the remaining bookkeeping.
          failedHard = String(err instanceof Error ? err.message : err);
        }
      }

      const processed = info?.numberRecordsProcessed ?? 0;
      const failed = info?.numberRecordsFailed ?? 0;
      totalProcessed += processed;
      totalFailed += failed;
      const stepFailed = failedHard !== null || !info || info.state !== 'JobComplete' || failed > 0;
      if (stepFailed) anyFailure = true;
      // S40: the org returns result exports in the JOB's delimiter — name them
      // so the extension keeps declaring it (a TAB file named .csv would
      // mis-scan if a fixed export were re-proposed).
      const resExt = (m.column_delimiter ?? 'COMMA') === 'TAB' ? 'tsv' : 'csv';

      const entry: Record<string, unknown> = {
        step: m.n,
        object: m.object,
        operation: m.operation,
        ...(jobId ? { job_id: jobId } : {}),
        state: info ? info.state : 'NotSent',
        processed,
        succeeded: Math.max(0, processed - failed),
        failed,
        ...(failedHard
          ? { error_message: failedHard }
          : info?.errorMessage
            ? { error_message: info.errorMessage }
            : {}),
      };

      // S40: created-record IDs. The success export (original columns +
      // sf__Id / sf__Created) lands as a FILE beside the failed-rows
      // exports — IDs never flood the conversation, and cleanup or
      // follow-up loads can read them directly.
      if (info && jobId && processed - failed > 0) {
        try {
          const p = writeResultCsv(
            `step-${m.n}-success.${resExt}`,
            await fetchSuccessfulResults(rest, version, jobId),
          );
          if (p) entry.success_rows_file = p;
        } catch (err) {
          entry.success_rows_note = `could not fetch the success export: ${String(
            err instanceof Error ? err.message : err,
          )}`;
        }
      }
      if (info && jobId && stepFailed) {
        try {
          const p = writeResultCsv(
            `step-${m.n}-failed.${resExt}`,
            await fetchFailedResults(rest, version, jobId),
          );
          if (p) entry.failed_rows_file = p;
        } catch (err) {
          entry.failed_rows_note = `could not fetch the failed-rows export: ${String(
            err instanceof Error ? err.message : err,
          )}`;
        }
        try {
          const p = writeResultCsv(
            `step-${m.n}-unprocessed.${resExt}`,
            await fetchUnprocessedRecords(rest, version, jobId),
          );
          if (p) entry.unprocessed_rows_file = p;
        } catch (err) {
          entry.unprocessed_rows_note = `could not fetch the unprocessed-rows export: ${String(
            err instanceof Error ? err.message : err,
          )}`;
        }
      }
      stepResults.push(entry);

      if (stepFailed && stopOnFailure && m.n < total) {
        haltedAfterStep = m.n;
        for (const rem of steps.filter((s) => s.n > m.n)) {
          stepResults.push({
            step: rem.n,
            object: rem.object,
            operation: rem.operation,
            state: 'Skipped',
            processed: 0,
            succeeded: 0,
            failed: 0,
            reason:
              `step ${m.n} failed and stop_on_failure is true — rows already loaded by ` +
              'earlier steps STAY',
          });
        }
        break;
      }
    }

    const executed = !anyFailure;
    const payload: Record<string, unknown> = {
      connection: conn.alias,
      bulk: true,
      executed,
      stop_on_failure: stopOnFailure,
      steps: stepResults,
      total_processed: totalProcessed,
      total_failed: totalFailed,
      ...(haltedAfterStep !== null ? { halted_after_step: haltedAfterStep } : {}),
      ...(resultsDirMade ? { results_dir: resultsDir } : {}),
      // S45 F2: bulk loads are not re-checked — the page showed no current
      // values for their rows, so there is nothing to compare against.
      target_check: { ...TARGET_CHECK_NOT_APPLICABLE_BULK },
      note: executed
        ? `All ${stepResults.length} step(s) completed: ` +
          `${totalProcessed.toLocaleString('en-US')} rows loaded. Bulk writes bypass no ` +
          'automation — triggers and flows ran normally.'
        : 'At least one step did not fully succeed. Rows loaded by completed steps REMAIN in ' +
          'the org (there is no cross-job rollback). Failed and unprocessed rows were written ' +
          'as CSV files — open them at the paths above (the trailing sf__Error column names ' +
          'each cause), fix, and re-propose ONLY those rows. The confirmation code is spent.',
    };
    this.audit.record(executed ? 'bulk.executed' : 'bulk.execution_failed', {
      connectionId: conn.id,
      tool: 'bulk_load_execute',
      outcome: executed ? 'success' : 'error',
      detail: {
        requestId: request.id,
        steps: stepResults.length,
        totalProcessed,
        totalFailed,
        ...(haltedAfterStep !== null ? { haltedAfterStep } : {}),
        jobIds: stepResults.map((s) => s.job_id).filter(Boolean),
      },
    });
    return this.finishExecution(conn, request, executed ? 'executed' : 'execution_failed', payload);
  }

  /** Poll one ingest job to a terminal state; on deadline, abort (best-effort) and throw. */
  private async pollBulkJob(
    rest: RestClient,
    jobId: string,
    stepLabel: string,
    job?: Job<unknown>,
  ): Promise<IngestJobInfo> {
    const deadline = Date.now() + this.config.bulkLoad.ingestTimeoutMs;
    let info = await getIngestJob(rest, this.config.salesforce.apiVersion, jobId);
    while (!isTerminalIngestState(info.state)) {
      if (Date.now() > deadline) {
        await abortIngestJob(rest, this.config.salesforce.apiVersion, jobId);
        throw new ContrailError(
          `${stepLabel} did not finish within ` +
            `${Math.round(this.config.bulkLoad.ingestTimeoutMs / 60000)} minutes ` +
            `(state: ${info.state}); an abort was requested`,
          'bulk_ingest_timeout',
        );
      }
      if (job) {
        job.progress =
          `${stepLabel} — ${info.state} ` +
          `(${info.numberRecordsProcessed.toLocaleString('en-US')} processed, ` +
          `${info.numberRecordsFailed.toLocaleString('en-US')} failed)`;
      }
      await delay(this.config.bulkLoad.pollIntervalMs);
      info = await getIngestJob(rest, this.config.salesforce.apiVersion, jobId);
    }
    return info;
  }

  // ── shared internals ───────────────────────────────────────────────────

  /**
   * S45 F2: the execute-time "target moved" guard. Runs BEFORE claimCode,
   * after a synchronous peek found a live 'validated' code; read-only — it
   * voids only through the atomic voidRequestWithResult, and never registers
   * an attempt. Bounded by `deadlineMs`.
   *
   * Moved → the request is voided with the result (refusal included) as its
   * result_json, so re-sending the code replays that refusal; the payload
   * and (deploy) the revert package are removed; `<kind>.target_moved` is
   * audited; the SAME result object is returned as the call's terminal
   * result. Losing the void race (another caller claimed first) falls
   * through to claimCode. When the guard's own org read fails or outlives
   * the deadline — Ryley's decision, 2026-11-14 — it FAILS OPEN WITH
   * DISCLOSURE: execution continues, the result's target_check is
   * {status:'unavailable', reason, note}, and deploy.target_check_unavailable
   * is audited here, BEFORE the claim, so the record exists even if the
   * write then fails. A probe that compared nothing (target_check
   * 'not_checked') proceeds the same way, audited with reason 'no_baseline'
   * (no baseline existed) or 'nothing_compared' (every member unchecked for
   * its own reason). The desktop's notice keys on 'unavailable' OR
   * 'not_checked'.
   */
  private async preflightTargetMoved(
    conn: ConnectionRecord,
    kind: 'deploy' | 'dml' | 'activation',
    request: DeployRequestRecord,
    tool: string,
    opts: { deadlineMs: number },
  ): Promise<TargetGuardOutcome> {
    let probe: TargetProbe;
    try {
      probe = await withDeadline(opts.deadlineMs, (signal) =>
        kind === 'deploy'
          ? this.probeDeployTarget(conn, request)
          : kind === 'dml'
            ? this.probeDmlTarget(conn, request, signal)
            : this.probeActivationTarget(conn, request, signal),
      );
    } catch (err) {
      const reason =
        err instanceof TargetCheckDeadline
          ? `the org did not answer within ${Math.round(opts.deadlineMs / 1000)} s`
          : String(err instanceof Error ? err.message : err).slice(0, 300);
      this.audit.record('deploy.target_check_unavailable', {
        connectionId: conn.id,
        tool,
        outcome: 'error',
        detail: { requestId: request.id, kind, reason },
      });
      return {
        verdict: 'proceed',
        // The desktop's "executed without a target check" notice keys on this
        // status and on 'not_checked' (targetCheckOf).
        targetCheck: {
          status: 'unavailable',
          reason,
          note: targetCheckUnavailableNote(kind, reason),
        },
      };
    }
    if (probe.moved === null) {
      // Nothing compared (no baseline, or no member comparable): the write
      // proceeds unverified, so it is recorded exactly like a failed read —
      // before the claim, so the record exists even if the write then fails.
      if (probe.targetCheck.status === 'not_checked') {
        const tc = probe.targetCheck as {
          checked?: unknown[];
          unchecked?: Array<{ reason: string }>;
        };
        const reason =
          nothingComparedReason(tc.checked ?? [], tc.unchecked ?? []) ?? 'nothing_compared';
        this.audit.record('deploy.target_check_unavailable', {
          connectionId: conn.id,
          tool,
          outcome: 'error',
          detail: { requestId: request.id, kind, reason },
        });
      }
      return { verdict: 'proceed', targetCheck: probe.targetCheck };
    }
    if (!this.db.voidRequestWithResult(request.id, JSON.stringify(probe.moved))) {
      return { verdict: 'lost_race' };
    }
    if (request.payloadPath) safeUnlink(request.payloadPath);
    if (kind === 'deploy') this.removeRevertDir(request.id);
    this.audit.record(`${kind}.target_moved`, {
      connectionId: conn.id,
      tool,
      outcome: 'refused',
      detail: { requestId: request.id, ...probe.audit },
    });
    return { verdict: 'moved', result: probe.moved };
  }

  /**
   * S45 F2, deploy: re-list every member with the SAME listMetadataDetailed /
   * listMetadataQueries calls the validate-time live check made (children by
   * their own type, foldered members scoped to their folder), so baseline and
   * probe share one source, and compare stamps as epoch ms. A member whose
   * type cannot be enumerated (at validate or now), or whose frozen stamp is
   * missing, is reported `unchecked` — NEVER a void. With no live baseline
   * (the retrieve was unavailable at validate) the ORG clock anchors the
   * check: a stamp at or after the checkOnly DeployResult's createdDate
   * minus 5 s counts as moved (fail-closed in that margin); no org clock →
   * every member unchecked — never a host-clock comparison.
   */
  private async probeDeployTarget(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
  ): Promise<TargetProbe> {
    const summary = JSON.parse(request.summaryJson) as {
      changes?: ComponentChange[];
      destructive?: ComponentChange[];
      live_check?: LiveCheckSummary | null;
    };
    const live = summary.live_check ?? null;
    const members: ComponentChange[] = [];
    const seen = new Set<string>();
    for (const m of [...(summary.changes ?? []), ...(summary.destructive ?? [])]) {
      const key = preImageKey(m.type, m.api_name);
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(m);
    }
    const checked: RevertPlanMember[] = [];
    const unchecked: RevertPlanReason[] = [];
    const moved: DeployMovedMember[] = [];
    const uncheck = (m: ComponentChange, reason: string) =>
      unchecked.push({ type: m.type, api_name: m.api_name, reason });
    const toProbe: ComponentChange[] = [];
    let threshold: number | null = null;
    let degrade: { org_clock_created_date: string; live_check_reason: string } | undefined;
    let note: string | undefined;

    if (live?.status === 'ok') {
      // Absence is a fact only where the validate-time listing covered the type.
      const datesCovered = (type: string) =>
        live.dates_unavailable === undefined && !live.dates_unavailable_types.includes(type);
      for (const m of members) {
        const pre = m.pre_image;
        if (!pre || pre.present === null) uncheck(m, 'type_not_enumerable');
        else if (pre.present === true && Number.isNaN(Date.parse(pre.last_modified_date ?? ''))) {
          uncheck(m, 'dates_unavailable_at_validate');
        } else if (pre.present === false && !datesCovered(m.type)) {
          uncheck(m, 'dates_unavailable_at_validate');
        } else if (preImageListQueryFor(m) === null) uncheck(m, 'type_not_enumerable');
        else toProbe.push(m);
      }
    } else {
      const created = live?.org_clock?.created_date;
      const createdMs = created ? Date.parse(created) : NaN;
      const liveReason = live?.reason ?? 'no live check was recorded';
      if (!created || Number.isNaN(createdMs)) {
        for (const m of members) uncheck(m, 'live_check_unavailable_no_org_clock');
        note =
          `No live baseline was captured when this package was validated (${liveReason}) and ` +
          `no org-side validation time was recorded, so Contrail had nothing to compare ` +
          `last-modified stamps against: every member is unchecked, and this deploy ran without ` +
          `a target check.`;
      } else {
        threshold = createdMs - ORG_CLOCK_MARGIN_MS;
        degrade = { org_clock_created_date: created, live_check_reason: liveReason };
        for (const m of members) {
          if (preImageListQueryFor(m) === null) uncheck(m, 'type_not_enumerable');
          else toProbe.push(m);
        }
      }
    }

    let checkedAt = new Date().toISOString();
    if (toProbe.length > 0) {
      const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
      const { types, folderQueries } = buildPreImageListQueries(toProbe);
      const none = { props: [] as FileProperties[], unsupportedTypes: [] as string[] };
      const [flat, foldered] = await Promise.all([
        types.length > 0 ? soap.listMetadataDetailed(types) : Promise.resolve(none),
        folderQueries.length > 0 ? soap.listMetadataQueries(folderQueries) : Promise.resolve(none),
      ]);
      checkedAt = new Date().toISOString();
      const props = [...flat.props, ...foldered.props];
      const unsupported = new Set([...flat.unsupportedTypes, ...foldered.unsupportedTypes]);
      for (const m of toProbe) {
        if (unsupported.has(m.type)) {
          uncheck(m, 'type_not_enumerable');
          continue;
        }
        const row = listedPropFor(props, m.type, m.api_name);
        const stamps = {
          last_modified_by: row?.lastModifiedByName ? row.lastModifiedByName : null,
          last_modified_date: row?.lastModifiedDate ? row.lastModifiedDate : null,
        };
        const name = { type: m.type, api_name: m.api_name };
        const undated = row !== undefined && Number.isNaN(Date.parse(row.lastModifiedDate));
        if (threshold !== null) {
          if (!row) {
            // No live baseline says whether the member existed at validate:
            // absence is exactly what an ADD's approval assumed; for anything
            // else Contrail cannot tell whether it vanished before or after
            // validation — unchecked, never "checked".
            if (m.change === 'add') checked.push(name);
            else uncheck(m, 'absent_no_baseline');
          } else if (undated) {
            uncheck(m, 'dates_unavailable_at_execute');
          } else if (Date.parse(row.lastModifiedDate) >= threshold) {
            moved.push({ ...name, ...stamps, frozen_date: null, state: 'changed' });
          } else {
            checked.push(name);
          }
          continue;
        }
        const pre = m.pre_image!;
        if (pre.present === true && !row) {
          moved.push({
            ...name,
            last_modified_by: null,
            last_modified_date: null,
            frozen_date: pre.last_modified_date,
            state: 'gone',
          });
        } else if (pre.present === false && row) {
          moved.push({ ...name, ...stamps, frozen_date: null, state: 'created' });
        } else if (undated) {
          // A listed row with no parseable stamp is no evidence of a change:
          // unchecked, never a void.
          uncheck(m, 'dates_unavailable_at_execute');
        } else if (
          row &&
          Date.parse(row.lastModifiedDate) !== Date.parse(pre.last_modified_date ?? '')
        ) {
          moved.push({ ...name, ...stamps, frozen_date: pre.last_modified_date, state: 'changed' });
        } else {
          checked.push(name);
        }
      }
    }

    // 'ok', or 'not_checked' (with the note above) when no baseline existed.
    const targetCheck = targetCheckOf(checkedAt, checked, unchecked, note ?? '');
    if (moved.length === 0) return { moved: null, targetCheck, audit: {} };
    const refusal = targetMovedRefusalText('deploy', {
      at: hhmm(checkedAt),
      alias: conn.alias,
      moved,
      ...(degrade ? { degrade } : {}),
    });
    return {
      moved: {
        connection: conn.alias,
        executed: false,
        deployed: false,
        target_moved: true,
        checked_at: checkedAt,
        moved,
        ...(unchecked.length > 0 ? { unchecked } : {}),
        refusal,
        note:
          'Nothing was deployed and this confirmation code is void. Re-run validate_deploy to ' +
          'see the current state of the org and get a fresh code.',
      },
      targetCheck,
      audit: {
        checked_at: checkedAt,
        moved: moved.map((m) => ({ type: m.type, api_name: m.api_name, state: m.state })),
        ...(degrade ? { org_clock_fallback: true } : {}),
      },
    };
  }

  /**
   * S45 F2, DML: re-run the SAME SOQL the preview ran and compare the old
   * values the approval page showed (persisted untruncated in summaryJson)
   * with today's — a field-value comparison, not SystemModstamp: the human
   * approved specific old→new transitions, and an unrelated edit or an
   * automation touch would false-refuse. A value changed and changed back
   * is invisible. A record the preview returned but this query does not is
   * moved (deleted, or no longer visible — indistinguishable from here); a
   * failed pre-check at propose leaves its records unchecked; inserts have
   * nothing to check.
   */
  private async probeDmlTarget(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    signal: AbortSignal,
  ): Promise<TargetProbe> {
    const input = JSON.parse(request.payloadJson ?? '{}') as DmlInput;
    const summary = JSON.parse(request.summaryJson) as {
      before?: unknown;
      found?: unknown;
      precheck?: unknown;
    };
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const query = async (soql: string, maxRows: number) =>
      (await rest.queryWithCount<Record<string, unknown>>(soql, maxRows, { signal })).records;
    const checked: Array<{ object: string; id: string }> = [];
    const unchecked: Array<{ object: string; id: string; reason: string }> = [];
    const changed: Array<{
      object: string;
      id: string;
      field: string;
      now: string;
      before: string;
    }> = [];
    const missing: Array<{ object: string; id: string }> = [];
    const notApplicable: TargetProbe = {
      moved: null,
      targetCheck: {
        status: 'not_applicable',
        note: 'an insert has no existing record to re-check',
      },
      audit: {},
    };
    const compare = (
      object: string,
      id: string,
      shown: Record<string, unknown>,
      row: Record<string, unknown>,
    ) => {
      // The record was returned, but the approval showed no before-value for
      // it (no field the preview row carried): its existence was re-checked,
      // nothing else — never listed as checked.
      if (Object.keys(shown).length === 0) {
        unchecked.push({ object, id, reason: 'no_before_value_shown' });
        return;
      }
      let same = true;
      for (const [field, was] of Object.entries(shown)) {
        // Salesforce answers in the field's canonical casing; match the
        // persisted key case-insensitively (older summaries kept the agent's).
        const key =
          Object.keys(row).find((p) => p.toLowerCase() === field.toLowerCase()) ?? field;
        const now = stripAttributes(row[key]);
        if (JSON.stringify(now ?? null) !== JSON.stringify(was ?? null)) {
          changed.push({ object, id, field, now: dmlValueText(now), before: dmlValueText(was) });
          same = false;
        }
      }
      if (same) checked.push({ object, id });
    };
    const precheckReason =
      summary.precheck === 'failed' ? 'precheck_failed_at_propose' : 'no_precheck_recorded';

    if (isDmlPlan(input)) {
      const before = (
        summary.before && typeof summary.before === 'object' ? summary.before : {}
      ) as Record<string, DmlPlanStepBefore>;
      let targets = 0;
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i]!;
        // Token targets are created by this same plan — nothing pre-existing to re-read.
        if (step.operation === 'insert' || !step.id || REF_TOKEN_RE.test(step.id)) continue;
        targets += 1;
        const object = step.object;
        const id = step.id;
        const b = before[String(i + 1)];
        if (!b) {
          unchecked.push({ object, id, reason: 'no_precheck_recorded' });
          continue;
        }
        if (b.exists === null) {
          unchecked.push({ object, id, reason: 'precheck_failed_at_propose' });
          continue;
        }
        if (!b.exists) {
          unchecked.push({ object, id, reason: 'not_found_at_propose' });
          continue;
        }
        const fields = step.operation === 'update' ? Object.keys(step.record ?? {}) : null;
        const row = (await query(dmlPlanStepSoql(object, id, fields), 1))[0];
        if (!row) missing.push({ object, id });
        // A delete approved the record's existence — which this re-query just confirmed.
        else if (step.operation === 'delete') checked.push({ object, id });
        else compare(object, id, b.fields ?? {}, row);
      }
      if (targets === 0) return notApplicable;
    } else if (input.operation === 'insert') {
      return notApplicable;
    } else if (input.operation === 'update') {
      const records = input.records ?? [];
      const ids = records.map((r) => String(r.Id ?? r.id));
      const object = input.object;
      if (summary.precheck !== 'ok') {
        for (const id of new Set(ids)) unchecked.push({ object, id, reason: precheckReason });
      } else {
        const before = (
          summary.before && typeof summary.before === 'object' ? summary.before : {}
        ) as Record<string, Record<string, unknown>>;
        const baseline = [...new Set(ids)].filter((id) => before[id] !== undefined);
        for (const id of new Set(ids)) {
          if (before[id] === undefined) {
            unchecked.push({ object, id, reason: 'not_found_at_propose' });
          }
        }
        if (baseline.length > 0) {
          const fields = [
            ...new Set(
              records.flatMap((r) => Object.keys(r)).filter((k) => k.toLowerCase() !== 'id'),
            ),
          ];
          // Keyed by the 15-character prefix: the org answers with 18-character
          // ids, while the agent may have written either form.
          const now = new Map<string, Record<string, unknown>>();
          for (const row of await query(dmlUpdatePreviewSoql(object, fields, ids), 200)) {
            now.set(String(row.Id).slice(0, 15), row);
          }
          for (const id of baseline) {
            const row = now.get(id.slice(0, 15));
            if (!row) missing.push({ object, id });
            else compare(object, id, before[id]!, row);
          }
        }
      }
    } else {
      const ids = input.ids ?? [];
      const object = input.object;
      if (summary.precheck !== 'ok') {
        for (const id of new Set(ids)) unchecked.push({ object, id, reason: precheckReason });
      } else {
        const found = new Set(
          Array.isArray(summary.found) ? (summary.found as unknown[]).map(String) : [],
        );
        for (const id of new Set(ids)) {
          if (!found.has(id)) unchecked.push({ object, id, reason: 'not_found_at_propose' });
        }
        if (found.size > 0) {
          // 15-character prefix keys — see the update path above.
          const now = new Set<string>();
          for (const row of await query(dmlDeletePreviewSoql(object, ids), 200)) {
            now.add(String(row.Id).slice(0, 15));
          }
          for (const id of found) {
            if (now.has(id.slice(0, 15))) checked.push({ object, id });
            else missing.push({ object, id });
          }
        }
      }
    }

    const checkedAt = new Date().toISOString();
    const targetCheck = targetCheckOf(
      checkedAt,
      checked,
      unchecked,
      "dml_propose recorded no before-values Contrail could compare against (each record's " +
        'reason is under unchecked), so nothing was re-checked: this write ran without a ' +
        'target check.',
    );
    if (changed.length === 0 && missing.length === 0) {
      return { moved: null, targetCheck, audit: {} };
    }
    const refusal = targetMovedRefusalText('dml', { at: hhmm(checkedAt), changed, missing });
    return {
      moved: {
        connection: conn.alias,
        executed: false,
        target_moved: true,
        checked_at: checkedAt,
        moved: [
          ...changed.map((c) => ({ object: c.object, id: c.id, field: c.field, state: 'changed' })),
          ...missing.map((m) => ({ object: m.object, id: m.id, state: 'missing' })),
        ],
        ...(unchecked.length > 0 ? { unchecked } : {}),
        refusal,
        note:
          'Nothing was written and this confirmation code is void. Re-run dml_propose to see ' +
          'the current values and get a fresh code.',
      },
      targetCheck,
      audit: { checked_at: checkedAt, changed: changed.length, missing: missing.length },
    };
  }

  /**
   * S45 F2, activation: SELECT the BotVersion's Status now and compare it
   * with the from_status frozen at propose. A row the query no longer
   * returns is moved too (deleted, or not visible to this user).
   */
  private async probeActivationTarget(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    signal: AbortSignal,
  ): Promise<TargetProbe> {
    const payload = JSON.parse(request.payloadJson ?? '{}') as {
      bot_developer_name?: string;
      bot_version_developer_name?: string;
      bot_version_id?: string;
      from_status?: string;
    };
    const agent = payload.bot_developer_name ?? '(unknown agent)';
    const version = payload.bot_version_developer_name ?? payload.bot_version_id ?? '(unknown)';
    const member = { type: 'BotVersion', api_name: `${agent}.${version}` };
    if (!payload.bot_version_id || !payload.from_status) {
      return {
        moved: null,
        targetCheck: targetCheckOf(
          new Date().toISOString(),
          [],
          [{ ...member, reason: 'no_baseline_recorded' }],
          'No starting status was recorded when this change was proposed, so Contrail had ' +
            "nothing to compare the version's Status against: this change ran without a " +
            'target check.',
        ),
        audit: {},
      };
    }
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const id = payload.bot_version_id;
    const rows = (
      await rest.queryWithCount<{ Id?: string; Status?: string }>(
        `SELECT Id, Status FROM BotVersion WHERE Id = '${soqlQuote(id)}'`,
        200,
        { signal },
      )
    ).records;
    const checkedAt = new Date().toISOString();
    const row = rows.find((r) => r.Id === id);
    if (row && row.Status === payload.from_status) {
      return {
        moved: null,
        targetCheck: targetCheckOf(checkedAt, [member], [], ''),
        audit: {},
      };
    }
    const now = row
      ? String(row.Status ?? 'an unreported status')
      : "not returned — deleted, or not visible to this connection's user";
    const refusal = targetMovedRefusalText('activation', {
      at: hhmm(checkedAt),
      version,
      agent,
      now,
      from: payload.from_status,
    });
    return {
      moved: {
        connection: conn.alias,
        executed: false,
        target_moved: true,
        checked_at: checkedAt,
        agent: payload.bot_developer_name,
        version: payload.bot_version_developer_name,
        bot_version_id: id,
        approved_from_status: payload.from_status,
        current_status: row ? (row.Status ?? null) : null,
        refusal,
        note:
          'Nothing was changed and this confirmation code is void. Re-run ' +
          'agent_activation_propose to see the current status and get a fresh code.',
      },
      targetCheck: { checked_at: checkedAt, checked: [], unchecked: [] },
      audit: {
        checked_at: checkedAt,
        bot_version_id: id,
        from: payload.from_status,
        now: row ? (row.Status ?? null) : null,
      },
    };
  }

  /**
   * Resolve a human-supplied code to an execution claim. Atomically flips
   * 'validated'→'executing' so exactly one caller may proceed; polls and
   * concurrent callers re-attach ('running') or receive the stored terminal
   * result ('terminal'); bad/expired codes are refused and audited.
   */
  private claimCode(
    conn: ConnectionRecord,
    kind: DeployRequestKind,
    code: string,
    tool: string,
  ):
    | { kind: 'claimed' | 'running'; request: DeployRequestRecord }
    | { kind: 'terminal'; result: Record<string, unknown> } {
    const request = this.db.findRequestByCode(conn.id, kind, code);
    if (!request) {
      // Wrong code — count it against the pending request as a brute-force
      // guard. After the threshold the pending code is locked, so guessing
      // can never outlast a single issued code.
      const attempt = this.db.registerFailedAttempt(
        conn.id,
        kind,
        this.config.deploy.maxFailedAttempts,
      );
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: {
          reason: attempt.locked ? 'too_many_attempts' : 'no_matching_code',
          attempts_remaining: attempt.pendingExisted ? attempt.attemptsRemaining : null,
          locked: attempt.locked,
        },
      });
      if (attempt.locked) {
        if (attempt.payloadPath) safeUnlink(attempt.payloadPath);
        // S45 F4: a locked deploy can never execute — its pre-images go too.
        if (kind === 'deploy' && attempt.requestId) this.removeRevertDir(attempt.requestId);
        throw new ContrailError(
          `Too many incorrect codes — the pending ${kindNoun(kind)} on "${conn.alias}" has ` +
            `been locked and its code invalidated. Re-validate to get a ` +
            `fresh code. (This is the brute-force guard.)`,
          'code_locked',
        );
      }
      throw new ContrailError(
        `No ${kindNoun(kind)} on "${conn.alias}" matches that code.` +
          (attempt.pendingExisted
            ? ` ${attempt.attemptsRemaining} attempt(s) remain before the pending code is locked.`
            : '') +
          ` Codes are single-use, expire after ~1 hour, and are replaced by re-validation — ask ` +
          `the human to re-read the code from the approval page, or validate again.`,
        'bad_confirmation_code',
      );
    }
    if (request.status === 'executed' || request.status === 'execution_failed') {
      // Already ran — return the stored outcome so a late poll is not an error.
      const stored = request.resultJson
        ? (JSON.parse(request.resultJson) as Record<string, unknown>)
        : { executed: request.status === 'executed' };
      return { kind: 'terminal', result: { ...stored, already_completed: true } };
    }
    if (request.status === 'expired') {
      // S45: the validate-time sweep (expireStaleValidatedRequests) now
      // expires stale codes EAGERLY, so most expired codes arrive here rather
      // than at the lazy check below — the same refusal and error code, so a
      // caller cannot tell (or need to know) which path expired it. The sweep
      // already removed the payload and the revert files.
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: { reason: 'code_expired', requestId: request.id },
      });
      throw new ContrailError(
        `That confirmation code expired at ${request.expiresAt}. Validate again for a fresh one.`,
        'code_expired',
      );
    }
    if (request.status === 'superseded' || request.status === 'locked') {
      // S45 F2: a code the execute-time guard voided (TARGET MOVED) is stored
      // 'superseded' with the verdict in result_json — re-sending it replays
      // THAT refusal, never "a newer validation replaced it". Parsed
      // synchronously, so the claim contract above holds.
      let voided: string | null = null;
      if (request.status === 'superseded' && request.resultJson) {
        try {
          const stored = JSON.parse(request.resultJson) as {
            target_moved?: unknown;
            refusal?: unknown;
          };
          if (stored.target_moved === true && typeof stored.refusal === 'string') {
            voided = stored.refusal;
          }
        } catch {
          // Not a guard verdict — the plain supersede message below applies.
        }
      }
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: {
          reason: request.status,
          requestId: request.id,
          ...(voided !== null ? { cause: 'target_moved' } : {}),
        },
      });
      if (voided !== null) {
        throw new ContrailError(
          `This code was already voided and was not executed — ${voided}`,
          'code_unusable',
        );
      }
      const why =
        request.status === 'locked'
          ? 'it was locked after too many incorrect attempts'
          : 'a newer validation replaced it';
      throw new ContrailError(
        `That confirmation code is ${request.status} — ${why}. Validate again for a fresh one.`,
        'code_unusable',
      );
    }
    if (request.status === 'executing') {
      // A concurrent call already claimed it: re-attach rather than re-run.
      return { kind: 'running', request };
    }
    // status === 'validated' — check expiry, then atomically claim.
    if (new Date(request.expiresAt).getTime() < Date.now()) {
      // S45: an expired request can never execute — its frozen payload goes
      // (the pre-existing zip leak), and a deploy's pre-images with it. Only
      // when THIS call expired it (status-predicated): a row another process
      // claimed meanwhile keeps its payload and pre-images; the refusal is
      // the same either way.
      if (this.db.expireValidatedRequest(request.id)) {
        if (request.payloadPath) safeUnlink(request.payloadPath);
        if (kind === 'deploy') this.removeRevertDir(request.id);
      }
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: { reason: 'code_expired', requestId: request.id },
      });
      throw new ContrailError(
        `That confirmation code expired at ${request.expiresAt}. Validate again for a fresh one.`,
        'code_expired',
      );
    }
    if (!this.db.claimRequestForExecution(request.id)) {
      // Lost the race — another call claimed it microseconds ago.
      return { kind: 'running', request };
    }
    return { kind: 'claimed', request };
  }

  /**
   * Preview for a multi-step plan: one honest row per step, prefixed with its
   * ordinal. Reference tokens render SYMBOLICALLY ("<new Account from step 1>")
   * because the real id does not exist yet; the raw token is shown on the
   * row's detail line so the reviewer sees exactly what the org will resolve.
   * Pre-checks (old→new values, existence) run only for literal-id steps —
   * a token target cannot be queried before it exists.
   */
  private async buildDmlPlanPreview(
    rest: RestClient,
    input: DmlPlanInput,
  ): Promise<Record<string, unknown> & { rows: unknown[]; row_count: number }> {
    // Map declared refs to their (1-based) step + object, for symbolic labels.
    const refToStep = new Map<string, { step: number; object: string }>();
    input.steps.forEach((s, i) => {
      if (s.ref) refToStep.set(s.ref, { step: i + 1, object: s.object });
    });
    const symbolic = (token: string): string => {
      const ref = REF_TOKEN_RE.exec(token)?.[1];
      const target = ref ? refToStep.get(ref) : undefined;
      return target ? `<new ${target.object} from step ${target.step}>` : token;
    };

    const rows: Array<{
      label: string;
      warnings: string[];
      detail?: string;
      destructive?: boolean;
    }> = [];
    // S45 F2: per literal-id step, what the pre-check saw — kept at the
    // preview's TOP level (summaryJson), never on the row objects, and
    // stripped from the tool result by proposeDml.
    const stepBefore: Record<string, DmlPlanStepBefore> = {};
    let precheckOk = true;
    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i]!;
      const ordinal = `Step ${i + 1}`;
      const refNote = step.ref ? ` (ref "${step.ref}")` : '';
      const tokenFields = Object.entries(step.record ?? {}).filter(
        ([, v]) => typeof v === 'string' && REF_TOKEN_RE.test(v),
      );
      const detail =
        tokenFields.length || (step.id && REF_TOKEN_RE.test(step.id))
          ? 'references: ' +
            [
              ...(step.id && REF_TOKEN_RE.test(step.id) ? [`target ← ${step.id}`] : []),
              ...tokenFields.map(([k, v]) => `${k} ← ${String(v)}`),
            ].join(', ')
          : undefined;

      if (step.operation === 'insert') {
        const shown = Object.fromEntries(
          Object.entries(step.record ?? {}).map(([k, v]) => [
            k,
            typeof v === 'string' && REF_TOKEN_RE.test(v) ? symbolic(v) : v,
          ]),
        );
        rows.push({
          label: `${ordinal} · INSERT ${step.object}${refNote}: ${previewFields(shown)}`,
          warnings: [],
          ...(detail ? { detail } : {}),
        });
        continue;
      }

      const idIsToken = REF_TOKEN_RE.test(step.id ?? '');
      const target = idIsToken ? symbolic(step.id!) : (step.id ?? '');

      if (step.operation === 'delete') {
        let warnings: string[] = [];
        if (!idIsToken && step.id) {
          try {
            const found = await rest.query<{ Id: string }>(
              dmlPlanStepSoql(step.object, step.id, null),
              1,
            );
            if (found.length === 0) {
              warnings = ['record not found in pre-check — it may already be gone or the id is wrong'];
            }
            stepBefore[String(i + 1)] = {
              object: step.object,
              id: step.id,
              operation: 'delete',
              exists: found.length > 0,
            };
          } catch (err) {
            log('warn', 'could not pre-check id for DML plan delete preview', { err: String(err) });
            warnings = ['could not verify this id exists (pre-check failed)'];
            precheckOk = false;
            stepBefore[String(i + 1)] = {
              object: step.object,
              id: step.id,
              operation: 'delete',
              exists: null,
            };
          }
        }
        rows.push({
          label: `${ordinal} · DELETE ${step.object} ${target}`,
          warnings,
          destructive: true,
          ...(detail ? { detail } : {}),
        });
        continue;
      }

      // update — old→new labels only when the target id is literal.
      let prior: Record<string, unknown> | undefined;
      let priorFailed = false;
      if (!idIsToken && step.id) {
        const fields = Object.keys(step.record ?? {});
        try {
          prior = (
            await rest.query<Record<string, unknown>>(
              dmlPlanStepSoql(step.object, step.id, fields),
              1,
            )
          )[0];
        } catch (err) {
          priorFailed = true;
          precheckOk = false;
          log('warn', 'could not fetch before-values for DML plan preview', { err: String(err) });
        }
      }
      const shownBefore: Record<string, unknown> = {};
      const changes = Object.entries(step.record ?? {})
        .map(([k, v]) => {
          const shown = typeof v === 'string' && REF_TOKEN_RE.test(v) ? symbolic(v) : JSON.stringify(v);
          // The org returns the field's canonical casing (Phone for "phone"):
          // resolve it case-insensitively and keep the before-value under the
          // row's own key, so the execute-time guard compares like with like.
          const key = prior
            ? Object.keys(prior).find((p) => p !== 'attributes' && p.toLowerCase() === k.toLowerCase())
            : undefined;
          const old = key !== undefined ? prior![key] : undefined;
          if (key !== undefined && old !== undefined) shownBefore[key] = old;
          return old !== undefined ? `${k}: ${JSON.stringify(old)} → ${shown}` : `${k} = ${shown}`;
        })
        .join(', ');
      if (!idIsToken && step.id) {
        stepBefore[String(i + 1)] = {
          object: step.object,
          id: step.id,
          operation: 'update',
          exists: priorFailed ? null : prior !== undefined,
          ...(prior ? { fields: stripAttributes(shownBefore) as Record<string, unknown> } : {}),
        };
      }
      rows.push({
        label: `${ordinal} · UPDATE ${step.object} ${target}: ${truncateLabel(changes)}`,
        warnings:
          !idIsToken && step.id && !prior
            ? ['record not found in pre-check — verify the id']
            : [],
        ...(detail ? { detail } : {}),
      });
    }

    return {
      plan: true,
      all_or_none: input.all_or_none,
      steps: input.steps.length,
      operations: summarizeOps(input.steps),
      row_count: rows.length,
      rows,
      before: stepBefore,
      precheck: precheckOk ? 'ok' : 'failed',
    };
  }

  private async buildDmlPreview(
    rest: RestClient,
    input: {
      operation: 'insert' | 'update' | 'delete';
      object: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
    },
  ): Promise<Record<string, unknown> & { rows: unknown[]; row_count: number }> {
    if (input.operation === 'insert') {
      const rows = (input.records ?? []).map((r) => ({
        label: `INSERT ${input.object}: ${previewFields(r)}`,
        warnings: [],
      }));
      return { operation: 'insert', object: input.object, row_count: rows.length, rows };
    }
    if (input.operation === 'update') {
      const records = input.records ?? [];
      const fields = [
        ...new Set(records.flatMap((r) => Object.keys(r)).filter((k) => k.toLowerCase() !== 'id')),
      ];
      const ids = records.map((r) => String(r.Id ?? r.id));
      // Keyed by the 15-character prefix: the org answers with 18-character
      // ids, while the agent may have written either form. The persisted
      // before map keeps the agent's own ids.
      const before = new Map<string, Record<string, unknown>>();
      let precheckOk = true;
      try {
        for (const row of await rest.query<Record<string, unknown>>(
          dmlUpdatePreviewSoql(input.object, fields, ids),
          200,
        )) {
          before.set(String(row.Id).slice(0, 15), row);
        }
      } catch (err) {
        precheckOk = false;
        log('warn', 'could not fetch before-values for DML preview', { err: String(err) });
      }
      // S45 F2: the exact old values the page shows, kept UNTRUNCATED for the
      // execute-time guard (found records only — a found record with no shown
      // field still records that it existed).
      const shownBefore: Record<string, Record<string, unknown>> = {};
      const rows = records.map((r) => {
        const id = String(r.Id ?? r.id);
        const prior = before.get(id.slice(0, 15));
        if (prior) shownBefore[id] = { ...shownBefore[id] };
        const changes = Object.entries(r)
          .filter(([k]) => k.toLowerCase() !== 'id')
          .map(([k, v]) => {
            // Canonical field casing, resolved case-insensitively (see the
            // plan preview) — the before-value is kept under the row's key.
            const key = prior
              ? Object.keys(prior).find(
                  (p) => p !== 'attributes' && p.toLowerCase() === k.toLowerCase(),
                )
              : undefined;
            const old = key !== undefined ? prior![key] : undefined;
            if (key !== undefined && old !== undefined) shownBefore[id]![key] = old;
            return old !== undefined
              ? `${k}: ${JSON.stringify(old)} → ${JSON.stringify(v)}`
              : `${k} = ${JSON.stringify(v)}`;
          })
          .join(', ');
        return {
          label: `UPDATE ${input.object} ${id}: ${truncateLabel(changes)}`,
          warnings: prior ? [] : ['record not found in pre-check — verify the id'],
        };
      });
      // S45 F2: before/precheck ride summaryJson only — proposeDml strips
      // them from the tool result (guard data, not agent-facing).
      return {
        operation: 'update',
        object: input.object,
        row_count: rows.length,
        rows,
        before: stripAttributes(shownBefore) as Record<string, Record<string, unknown>>,
        precheck: precheckOk ? 'ok' : 'failed',
      };
    }
    const ids = input.ids ?? [];
    // 15-character prefix keys — see the update path above; the persisted
    // found list keeps the agent's own ids.
    const found = new Set<string>();
    let precheckOk = true;
    try {
      for (const row of await rest.query<{ Id: string }>(
        dmlDeletePreviewSoql(input.object, ids),
        200,
      )) {
        found.add(String(row.Id).slice(0, 15));
      }
    } catch (err) {
      precheckOk = false;
      log('warn', 'could not pre-check ids for DML delete preview', { err: String(err) });
    }
    const rows = ids.map((id) => ({
      label: `DELETE ${input.object} ${id}`,
      warnings: !precheckOk
        ? ['could not verify this id exists (pre-check failed)']
        : !found.has(id.slice(0, 15))
          ? ['record not found in pre-check — it may already be gone or the id is wrong']
          : [],
    }));
    // S45 F2: found/precheck ride summaryJson only (stripped from the tool
    // result); a failed pre-check leaves every id unchecked at execute.
    return {
      operation: 'delete',
      object: input.object,
      row_count: rows.length,
      rows,
      found: ids.filter((id) => found.has(id.slice(0, 15))),
      precheck: precheckOk ? 'ok' : 'failed',
    };
  }

  private gateTestDetail(conn: ConnectionRecord, result: DeployResult): unknown {
    if (result.numberTestErrors === 0) return null;
    // Spec §3: test-failure assertion detail is diagnostic-classified.
    if (!conn.grants.diagnostics_read) {
      return {
        withheld: true,
        note:
          `${result.numberTestErrors} test failure(s). Assertion messages and stack traces ` +
          `are diagnostics-classified and require the diagnostics_read grant on this connection.`,
      };
    }
    return result.testFailures.slice(0, 25);
  }

  private async pollDeploy(
    soap: MetadataSoapClient,
    id: string,
    job?: Job<unknown>,
    onTimeout?: (id: string) => Promise<void>,
  ): Promise<DeployResult> {
    const deadline = Date.now() + this.config.deploy.deployTimeoutMs;
    let result = await soap.checkDeployStatus(id);
    let poll = 0;
    while (!result.done) {
      if (Date.now() > deadline) {
        if (onTimeout) await onTimeout(id);
        throw new ContrailError(
          `deploy operation did not complete within ${Math.round(
            this.config.deploy.deployTimeoutMs / 60000,
          )} minutes (status: ${result.status}); a cancel was requested`,
          'deploy_timeout',
        );
      }
      poll += 1;
      if (job) {
        job.progress = `${result.status} (poll ${poll}${
          result.numberComponentsTotal
            ? `, ${result.numberComponentsDeployed}/${result.numberComponentsTotal} components`
            : ''
        })`;
      }
      await delay(this.config.deploy.pollIntervalMs);
      result = await soap.checkDeployStatus(id);
    }
    return result;
  }

  /** Soft-wait job wrapper mirroring SnapshotEngine: never trips MCP client timeouts. */
  private async runJob<T>(
    key: string,
    work: (job: Job<T>) => Promise<T>,
    waitMs = this.config.deploy.toolWaitMs,
  ): Promise<JobOutcome<T>> {
    // S41 (§3.1): input-keyed jobs mean an abandoned caller's finished
    // result can linger — sweep anything done and uncollected for 30 min.
    const cutoff = Date.now() - STALE_JOB_MS;
    for (const [k, j] of this.jobs) {
      if (k !== key && j.done && j.finishedAt !== undefined && j.finishedAt < cutoff) {
        this.jobs.delete(k);
      }
    }
    let job = this.jobs.get(key) as Job<T> | undefined;
    if (job?.done) {
      this.jobs.delete(key);
      if (job.error !== undefined) return { status: 'failed', error: job.error };
      if (job.result !== undefined) return { status: 'complete', result: job.result };
      job = undefined;
    }
    if (!job) {
      const j: Job<T> = {
        progress: 'starting',
        startedAt: new Date().toISOString(),
        done: false,
        promise: undefined as unknown as Promise<T>,
      };
      j.promise = work(j)
        .then((result) => {
          j.done = true;
          j.finishedAt = Date.now();
          j.result = result;
          return result;
        })
        .catch((err) => {
          j.done = true;
          j.finishedAt = Date.now();
          j.error = String(err instanceof Error ? err.message : err);
          throw err;
        });
      j.promise.catch(() => {});
      this.jobs.set(key, j as Job<unknown>);
      job = j;
    }
    const winner = await Promise.race([
      job.promise.then(
        (result) => ({ status: 'complete' as const, result }),
        (err) => ({
          status: 'failed' as const,
          error: String(err instanceof Error ? err.message : err),
        }),
      ),
      delay(waitMs).then(() => null),
    ]);
    if (winner) {
      this.jobs.delete(key);
      return winner;
    }
    return { status: 'in_progress', progress: job.progress, started_at: job.startedAt };
  }

  private metaXmlFromSnapshot(conn: ConnectionRecord, type: string, apiName: string): string | null {
    const dirs: Record<string, { dir: string; ext: string }> = {
      ApexClass: { dir: 'classes', ext: '.cls' },
      ApexTrigger: { dir: 'triggers', ext: '.trigger' },
    };
    const spec = dirs[type];
    if (!spec) return null;
    return this.store.readCurrentFile(conn.id, `${spec.dir}/${apiName}${spec.ext}-meta.xml`);
  }

  /**
   * S45 F3: the automation card of a data-write page — what the LOCAL
   * SNAPSHOT says fires on each object the write touches (never the org; the
   * card's heading says so). One entry per distinct object, at most
   * AUTOMATION_CARD_MAX_OBJECTS; the last entry names any left out.
   * collectObjectAutomation never throws — the try keeps that promise for the
   * page: a card must never cost the human their approval page.
   */
  private automationCard(conn: ConnectionRecord, objects: string[]): ObjectAutomation[] {
    const distinct: string[] = [];
    const seen = new Set<string>();
    for (const object of objects) {
      if (seen.has(object.toLowerCase())) continue;
      seen.add(object.toLowerCase());
      distinct.push(object);
    }
    try {
      const card = distinct
        .slice(0, AUTOMATION_CARD_MAX_OBJECTS)
        .map((object) =>
          collectObjectAutomation({ db: this.db, store: this.store, connectionId: conn.id, object }),
        );
      const left = distinct.slice(AUTOMATION_CARD_MAX_OBJECTS);
      const last = card.at(-1);
      if (last && left.length > 0) {
        last.notes.push(
          `This card covers the first ${AUTOMATION_CARD_MAX_OBJECTS} objects; not shown: ` +
            `${left.join(', ')}.`,
        );
      }
      return card;
    } catch (err) {
      log('warn', 'automation card failed', { error: String(err) });
      return [];
    }
  }

  /**
   * S45 F3: the objects an anonymous Apex script MAY touch, parsed from its
   * text — null when the parse itself failed (the page then shows no card
   * rather than claiming none were found).
   */
  private apexScriptObjects(conn: ConnectionRecord, script: string): string[] | null {
    try {
      const known = this.db.listArtifacts(conn.id, 'ApexClass').map((a) => a.apiName);
      return parseApexObjectTargets(script, known);
    } catch (err) {
      log('warn', 'apex object parse failed', { error: String(err) });
      return null;
    }
  }
}

/** S45 F3: objects one approval page's automation card covers. */
const AUTOMATION_CARD_MAX_OBJECTS = 10;

/**
 * S45: the file provenance of a validated package for the deploy.validated
 * audit row — every content_file path and its sha256, index-aligned (inline
 * components carry neither and are skipped). Before this no audit record in
 * this file named a source path.
 */
function sourceProvenance(components: ProposedComponent[]): {
  source_paths: string[];
  source_sha256s: string[];
} {
  const sourced = components.filter((c) => c.source_path);
  return {
    source_paths: sourced.map((c) => c.source_path!),
    source_sha256s: sourced.map((c) => c.source_sha256 ?? ''),
  };
}

// ── S45: live pre-image texts and diff helpers ───────────────────────────
//
// The page texts below are hand-mirrored to the desktop engine (verbatim —
// describe-identity anchors). HH:MM is the live check's `at` in the host's
// local time (preimage.ts hhmm). Consequence first in every warning, so a
// phone-truncated line keeps its actionable clause; who/when never appear
// in a warning (they live in the row detail — composePushover reads labels
// and warnings only).

/**
 * The approval page's per-row diff caps — tighter than the agent-facing
 * defaults, because the page renders every row at once — plus a page-wide
 * budget (serialized diff bodies) after which rows carry counts only.
 */
const PAGE_DIFF_LIMITS: DiffLimits = {
  maxChanges: 60,
  maxHunks: 12,
  maxHunkLines: 30,
  maxLineChars: 240,
  maxHunkBudgetChars: 20_000,
};
const PAGE_DIFF_BUDGET_CHARS = 150_000;
const PAGE_DIFF_BUDGET_NOTE =
  "diff body omitted — this page's 150 KB diff budget was spent on the rows above; the " +
  'summary line still counts this row';

function existsInTargetText(type: string, name: string, at: string, comparable: boolean): string {
  return (
    `EXISTS IN TARGET — this deploy OVERWRITES a live ${type} ${name} that your snapshot does ` +
    `not have (retrieved ${at})` +
    // A member whose retrieved bytes cannot be compared (Profile) gets no
    // live diff, so the sentence that promises one is dropped.
    (comparable ? '; the diff below is against the live version.' : '.')
  );
}

function notInTargetText(type: string, name: string, at: string): string {
  return (
    `NOT IN TARGET — your snapshot has ${type} ${name}, but the org does not (retrieved ` +
    `${at}). This deploy CREATES it rather than modifying it.`
  );
}

function changedInTargetText(at: string, snapshotFrom: string, comparable: boolean): string {
  return comparable
    ? `CHANGED IN TARGET SINCE YOUR SNAPSHOT — the diff below is against the LIVE version ` +
        `(retrieved ${at}); your snapshot is from ${snapshotFrom}.`
    : `CHANGED IN TARGET SINCE YOUR SNAPSHOT — the org's copy (retrieved ${at}) was modified ` +
        `after your snapshot from ${snapshotFrom}; this type's retrieved bytes cannot be ` +
        `compared, so any diff below is against your snapshot.`;
}

function liveBytesDifferText(at: string, cause: 'no_dates' | 'within_margin'): string {
  return (
    `live bytes differ from your snapshot (retrieved ${at}) — ` +
    (cause === 'no_dates'
      ? `last-modified stamps were unavailable for this type, so Contrail cannot say who or when.`
      : `this member's last-modified stamp is within a minute of when your snapshot was taken, ` +
        `too close to tell apart from clock differences between this computer and the org, so ` +
        `Contrail cannot say who or when.`)
  );
}

function destructiveAbsentText(at: string): string {
  return (
    `not present in the target (retrieved ${at}) — listMetadata reports no such member; the ` +
    `org decides whether this delete fails or no-ops`
  );
}

function changedSummaryText(n: number, alias: string, at: string): string {
  return (
    `${n} component(s) changed in "${alias}" since your snapshot — rows marked CHANGED IN ` +
    `TARGET show when (and, in their detail, who); every diff on this page is against the ` +
    `live version retrieved at ${at}, except rows labelled "diff vs your snapshot".`
  );
}

function liveUnavailableText(reason: string, snapshotFrom: string | null): string {
  return (
    `LIVE COMPARISON UNAVAILABLE (${reason}) — compared against your snapshot ` +
    (snapshotFrom !== null ? `from ${snapshotFrom}` : '(which holds none of these members)') +
    `; the org was not re-read. Classifications (ADD/MODIFY) and diffs below come from the ` +
    `local snapshot only.`
  );
}

function datesUnavailableText(at: string, types: string[], reason: string): string {
  return (
    `Live diff is against the org (retrieved ${at}); last-modified stamps were unavailable ` +
    `for ${types.join(', ')} (${reason}), so CHANGED-IN-TARGET detection for those members ` +
    `relies on content only and the execute-time check will report them as unchecked.`
  );
}

/** The row-detail attribution — null when the org gave no stamp. */
function lastModifiedDetail(image: PreImage): string | null {
  if (!image.last_modified_date) return null;
  return (
    `last modified in the org by ${image.last_modified_by ?? 'an unknown user'} at ` +
    `${shortStamp(image.last_modified_date)}`
  );
}

/** "2026-11-14 15:02" in the host's local time — the page's date face. */
function shortStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(iso)}`;
}

/** analyzeChanges emits one entry per member, in order; fall back to a lookup. */
function entryFor(
  entries: ComponentChange[],
  index: number,
  member: { type: string; api_name: string },
): ComponentChange | undefined {
  const e = entries[index];
  if (e && e.type === member.type && e.api_name === member.api_name) return e;
  return entries.find((x) => x.type === member.type && x.api_name === member.api_name);
}

/** The analyzeChanges deactivation shape — never reclassified by the live check. */
function isFlowDeactivation(c: ProposedComponent): boolean {
  return (
    c.type === 'FlowDefinition' &&
    /<activeVersionNumber>\s*0\s*<\/activeVersionNumber>/.test(c.content)
  );
}

/** Did the validate-time listing enumerate this member's type (so absence is a fact)? */
function listingCovers(
  live: Extract<PreImageResult, { status: 'ok' }>,
  member: { type: string; api_name: string },
): boolean {
  return (
    live.dates_unavailable === undefined &&
    !live.dates_unavailable_types.includes(member.type) &&
    preImageListQueryFor(member) !== null
  );
}

/** A bundle type's snapshot directory (readBundleFiles' `dir`), or null for non-bundles. */
function bundleRootOf(type: string, apiName: string): string | null {
  const entry = deployZipEntryPath(type, apiName);
  if (!entry || entry.child || !entry.bundleDir) return null;
  const trimmed = entry.bundleDir.replace(/\/$/, '');
  return trimmed.slice(0, trimmed.lastIndexOf('/'));
}

function proposedBundleFiles(c: ProposedComponent): Record<string, string> {
  return parseEnvelopeFor(c.type, c.api_name, c.content).files;
}

/**
 * The live CONTENT verdict: documents and children trim-equal; bundles
 * every proposed file trim-equal to its live body AND no live file the
 * proposal omits (a whole-bundle replace would delete it).
 */
function liveMatchesProposal(c: ProposedComponent, image: PreImage): boolean {
  if (bundleRootOf(c.type, c.api_name) !== null) {
    const proposed = proposedBundleFiles(c);
    const liveFiles = image.files ?? new Map<string, string>();
    for (const [rel, body] of Object.entries(proposed)) {
      const liveBody = liveFiles.get(rel);
      if (liveBody === undefined || liveBody.trim() !== body.trim()) return false;
    }
    for (const rel of liveFiles.keys()) if (!(rel in proposed)) return false;
    return true;
  }
  return image.content !== undefined && image.content.trim() === c.content.trim();
}

/** One document's (or child block's) row diff, direction baseline → proposal. */
function documentRowDiff(
  before: string,
  after: string,
  label: string,
  live: boolean,
): ApprovalRowDiff {
  const format = before.trimStart().startsWith('<') ? 'xml' : 'text';
  if (before.trim() === after.trim()) {
    return {
      format,
      identical: true,
      baseline_label: label,
      summary: live ? 'identical to the live version' : `${label} · identical`,
      truncated: false,
    };
  }
  const d = semanticDiff(before, after, PAGE_DIFF_LIMITS);
  if (d.format === 'xml' && d.xml) {
    const n = d.xml.change_count;
    return {
      format: 'xml',
      identical: false,
      baseline_label: label,
      // n === 0 with differing bytes: the structural diff ignores XML
      // attributes, comments and the declaration as well as whitespace and
      // keyed-element order (salesforce/xml.ts parser options) — the line
      // must not claim the difference is whitespace alone.
      summary:
        n === 0
          ? `${label} · no structural differences (formatting, element order, attributes or ` +
            `comments only)`
          : `${label} · ${n} change${n === 1 ? '' : 's'}`,
      xml_changes: d.xml.changes as Change[],
      counts: { changes: n },
      truncated: d.xml.truncated,
    };
  }
  const t = d.text ?? diffText(before, after, PAGE_DIFF_LIMITS);
  return {
    format: 'text',
    identical: false,
    baseline_label: label,
    summary: `${label} · +${t.lines_added} / −${t.lines_removed} lines`,
    text_hunks: t.hunks,
    counts: { lines_added: t.lines_added, lines_removed: t.lines_removed },
    truncated: t.hunks_truncated || t.counts_only,
    ...(t.counts_only ? { note: 'too large for a line-by-line diff — counts only' } : {}),
  };
}

/**
 * A bundle's row diff — PER FILE text hunks labelled with the file's path
 * inside the bundle, never a diff of two JSON envelopes. Files on one side
 * only are listed as added (the proposal brings them) or removed (the
 * whole-bundle replace deletes them).
 */
function bundleRowDiff(
  baseline: Map<string, string>,
  proposed: Record<string, string>,
  label: string,
  live: boolean,
): ApprovalRowDiff {
  const rels = [...new Set([...baseline.keys(), ...Object.keys(proposed)])].sort();
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const hunks: NonNullable<ApprovalRowDiff['text_hunks']> = [];
  const maxHunks = PAGE_DIFF_LIMITS.maxHunks ?? 12;
  let truncated = false;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const rel of rels) {
    const a = baseline.get(rel);
    const b = proposed[rel];
    if (a === undefined) {
      added.push(rel);
      continue;
    }
    if (b === undefined) {
      removed.push(rel);
      continue;
    }
    if (a.trim() === b.trim()) continue;
    changed.push(rel);
    const t = diffText(a, b, PAGE_DIFF_LIMITS);
    linesAdded += t.lines_added;
    linesRemoved += t.lines_removed;
    if (t.hunks_truncated || t.counts_only) truncated = true;
    for (const h of t.hunks) {
      if (hunks.length >= maxHunks) {
        truncated = true;
        break;
      }
      hunks.push({ file: rel, ...h });
    }
  }
  const files = [...changed, ...added, ...removed];
  if (files.length === 0) {
    return {
      format: 'bundle',
      identical: true,
      baseline_label: label,
      summary: live ? 'identical to the live version' : `${label} · identical`,
      truncated: false,
    };
  }
  const names = files.slice(0, 8).join(', ') + (files.length > 8 ? ', …' : '');
  return {
    format: 'bundle',
    identical: false,
    baseline_label: label,
    summary: `${label} · ${files.length} file${files.length === 1 ? '' : 's'} changed (${names})`,
    text_hunks: hunks,
    counts: {
      files_changed: changed,
      files_added: added,
      files_removed: removed,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
    },
    truncated,
  };
}

/** S45 F4: a request id as the database mints it (randomUUID) — the only revert-package names. */
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path equality — case-insensitive on win32, where the filesystem is. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * S45 F4: the REAL staging/_reverts. It must be a real directory — never a
 * link (Node reports a Windows junction as a symbolic link) — whose realpath
 * is exactly <realpath(staging)>/_reverts. "Somewhere inside staging" is not
 * enough: a `_reverts` linked to staging itself or to a project folder in it
 * would hand the sweep the user's deliverables. Throws unsafe_path otherwise.
 */
function revertsRootReal(): string {
  const reverts = path.join(stagingDir(), '_reverts');
  const stat = fs.lstatSync(reverts);
  const real = fs.realpathSync(reverts);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath(real, path.join(fs.realpathSync(stagingDir()), '_reverts'))
  ) {
    throw new ContrailError(
      `${reverts} is not a real directory directly under Contrail's staging directory — ` +
        `revert files are never written or removed through it`,
      'unsafe_path',
    );
  }
  return real;
}

/**
 * S45 F4: staging/_reverts/<name> must be a real directory (not a link)
 * whose realpath is exactly <root>/<name>. Throws unsafe_path otherwise.
 */
function assertRealRevertDir(root: string, name: string): void {
  const dir = path.join(stagingDir(), '_reverts', name);
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath(fs.realpathSync(dir), path.join(root, name))
  ) {
    throw new ContrailError(
      `revert directory ${dir} is not a real directory directly under ${root}`,
      'unsafe_path',
    );
  }
}

/**
 * What the agent is told about the approval page — NEVER the URL. When the
 * browser cannot be opened, the URL goes to stderr (a channel the human
 * running the server can read and the model cannot); handing the URL to the
 * agent would let a prompt-injected agent fetch the page and read the code,
 * defeating the whole invariant.
 */
function approvalForAgent(
  kind: DeployRequestKind,
  approval: { opened: boolean; url: string },
): Record<string, unknown> {
  if (approval.opened) return { opened: true };
  log(
    'warn',
    `approval page could not auto-open — open it yourself to read the ${kind} confirmation code`,
    { url: approval.url },
  );
  return {
    opened: false,
    note:
      'The approval page could not be opened automatically. Its URL was written to the ' +
      'Contrail server log (stderr) for the human to open — it is deliberately NOT provided ' +
      'to you. Ask the human to open the Contrail log, visit the page, and read the code back.',
  };
}

/** The propose-side tool a request kind is minted by — for audit attribution. */
function proposeToolFor(kind: DeployRequestKind): string {
  return kind === 'deploy'
    ? 'validate_deploy'
    : kind === 'dml'
      ? 'dml_propose'
      : kind === 'apex'
        ? 'apex_propose'
        : kind === 'activation'
          ? 'agent_activation_propose'
          : 'bulk_load_propose';
}

/** S45 F2: the guard's deadline fired before its org read answered. */
class TargetCheckDeadline extends Error {}

/**
 * S45 F2: run `work` under a deadline. The timer is armed BEFORE the work
 * starts; past it the signal aborts (a REST fetch stops; a SOAP listing,
 * which takes no signal, is merely abandoned — its late answer is ignored)
 * and the race rejects with TargetCheckDeadline.
 */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new TargetCheckDeadline(`no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(ctl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** S45 F2: the fail-open disclosure on a result whose target could not be re-read (verbatim). */
function targetCheckUnavailableNote(kind: DeployRequestKind, reason: string): string {
  return (
    `Contrail could not re-read the org to confirm nothing had moved before executing ` +
    `(${reason}); this ${kindNoun(kind)} ran against whatever the org held at that moment, and ` +
    `the approval page's diff may not describe what was overwritten.`
  );
}

/**
 * S45 F2: what a DML plan's pre-check saw for one literal-id step, kept at
 * the preview's top level (summaryJson) keyed by the 1-based step number.
 */
interface DmlPlanStepBefore {
  object: string;
  id: string;
  operation: 'update' | 'delete';
  /** null = the pre-check query failed (the step is unchecked at execute). */
  exists: boolean | null;
  /** update steps: the old values the page showed, untruncated. */
  fields?: Record<string, unknown>;
}

/**
 * S45 F2: the DML preview queries, built in ONE place so the execute-time
 * guard re-runs exactly the SOQL the approval page was built from.
 */
function dmlUpdatePreviewSoql(object: string, fields: string[], ids: string[]): string {
  return `SELECT Id${fields.length ? ', ' + fields.join(', ') : ''} FROM ${object} WHERE Id IN (${ids
    .map((i) => `'${i}'`)
    .join(',')})`;
}

function dmlDeletePreviewSoql(object: string, ids: string[]): string {
  return `SELECT Id FROM ${object} WHERE Id IN (${ids.map((i) => `'${i}'`).join(',')})`;
}

/** A plan step's pre-check: its update fields, or (null) the delete existence probe. */
function dmlPlanStepSoql(object: string, id: string, fields: string[] | null): string {
  return fields === null
    ? `SELECT Id FROM ${object} WHERE Id = '${id}'`
    : `SELECT Id${fields.length ? ', ' + fields.join(', ') : ''} FROM ${object} WHERE Id = '${id}'`;
}

/** A field value as a DML refusal quotes it: JSON, capped so long text never floods a result. */
function dmlValueText(value: unknown): string {
  const text = value === undefined ? 'null' : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Escape a value for a single-quoted SOQL string literal. */
function soqlQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The human-facing noun for a pending request of each kind. */
function kindNoun(kind: DeployRequestKind): string {
  return kind === 'deploy'
    ? 'deploy'
    : kind === 'apex'
      ? 'Apex script'
      : kind === 'bulk'
        ? 'bulk data load'
        : kind === 'activation'
          ? 'agent activation change'
          : 'change';
}

function safeUnlink(filePath: string): void {
  try {
    // recursive: bulk payloads are DIRECTORIES of frozen CSVs; without it,
    // rmSync throws EISDIR (swallowed below) and every bulk payload leaks.
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'could not delete deploy payload', { filePath, err: String(err) });
  }
}

function previewFields(record: Record<string, unknown>): string {
  return truncateLabel(
    Object.entries(record)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', '),
  );
}

function truncateLabel(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Column list for the approval page — wide files show the first 25 and a count. */
function columnsLabel(headers: string[]): string {
  const shown = headers.slice(0, 25);
  return (
    shown.join(', ') +
    (headers.length > shown.length ? ` … +${headers.length - shown.length} more` : '')
  );
}

/** "3 insert / 1 update" — the operations line for plan previews and audits. */
function summarizeOps(steps: ReadonlyArray<{ operation: string }>): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.operation, (counts.get(s.operation) ?? 0) + 1);
  return [...counts.entries()].map(([op, n]) => `${n} ${op}`).join(' / ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

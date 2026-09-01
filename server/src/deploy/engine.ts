import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContrailDb } from '../core/db.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord, DeployRequestKind, DeployRequestRecord } from '../core/types.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { SnapshotStore } from '../snapshot/store.js';
import { MetadataSoapClient, type DeployResult, type TestLevel } from '../salesforce/metadataSoap.js';
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
import { deploysDir } from '../core/paths.js';
import { ContrailError } from '../core/errors.js';
import { generateConfirmationCode } from './codes.js';
import { ApprovalPageServer } from './approval.js';
import { renderApprovalPage } from '../connect/pages.js';
import {
  analyzeChanges,
  analyzePermissionCoverage,
  buildDeployZip,
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
  request_id: string;
  validation_id: string;
  test_level: TestLevel;
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
  expires_at: string;
}

type JobOutcome<T> =
  | { status: 'complete'; result: T }
  | { status: 'failed'; error: string }
  | { status: 'in_progress'; progress: string; started_at: string };

interface Job<T> {
  promise: Promise<T>;
  progress: string;
  startedAt: string;
  done: boolean;
  result?: T;
  error?: string;
}

export class DeployEngine {
  private readonly jobs = new Map<string, Job<unknown>>();

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
    input: {
      components: ProposedComponent[];
      destructive: ProposedDeletion[];
      testLevel: TestLevel;
      runTests: string[];
    },
  ): Promise<
    JobOutcome<{
      summary: DeployValidationSummary | null;
      validation_passed: boolean;
      failure?: Record<string, unknown>;
      approval: Record<string, unknown> | null;
    }>
  > {
    return this.runJob(`${conn.id}:deploy-validate`, () => this.doValidate(conn, input));
  }

  private async doValidate(
    conn: ConnectionRecord,
    input: {
      components: ProposedComponent[];
      destructive: ProposedDeletion[];
      testLevel: TestLevel;
      runTests: string[];
    },
    job?: Job<unknown>,
  ) {
    const superseded = this.db.supersedePendingRequests(conn.id, 'deploy');
    if (superseded > 0) {
      for (const p of this.db.takeSupersededPayloadPaths(conn.id, 'deploy')) safeUnlink(p);
      this.audit.record('deploy.superseded', {
        connectionId: conn.id,
        tool: 'validate_deploy',
        detail: { count: superseded },
      });
    }

    const versionNumber = this.config.salesforce.apiVersion.replace(/^v/, '');

    // NOTE: we deliberately do NOT auto-inject a FlowDefinition deactivation
    // when deleting a Flow. Deactivation only takes effect on execute, but the
    // checkOnly validation gate evaluates the destructive delete against the
    // org's current (still-active) state, so a combined package never
    // validates. Flow deactivation is its own step (deactivate_flow); flow
    // deletion via the Metadata API is unreliable regardless (see the failure
    // guidance below).
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

    if (job) job.progress = 'validating with Salesforce (checkOnly)';
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const validationId = await soap.deploy(built.zip, {
      checkOnly: true,
      testLevel: input.testLevel,
      runTests: input.runTests,
    });
    const result = await this.pollDeploy(soap, validationId, job);

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
      const note = deletingFlow
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

    const code = generateConfirmationCode();
    const expiresAt = new Date(Date.now() + this.config.deploy.codeTtlMs).toISOString();
    const request = this.db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'deploy',
      confirmationCode: code,
      expiresAt,
      payloadJson: JSON.stringify({ testLevel: input.testLevel, runTests: input.runTests }),
      summaryJson: JSON.stringify({ changes, destructive, blast }),
      validationId,
    });
    const zipPath = path.join(deploysDir(), `${request.id}.zip`);
    fs.writeFileSync(zipPath, built.zip);
    this.db.setDeployRequestPayloadPath(request.id, zipPath);

    const summary: DeployValidationSummary = {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      validation_id: validationId,
      test_level: input.testLevel,
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
    };

    const approval = await this.approvals.present(
      renderApprovalPage({
        kind: 'deploy',
        code,
        expiresAt,
        org: {
          alias: conn.alias,
          orgName: conn.orgName,
          orgType: conn.orgType,
          instanceUrl: conn.instanceUrl,
        },
        changes: changes.map((c) => ({
          label: `${c.change.toUpperCase()}  ${c.type}:${c.api_name}`,
          warnings: c.warnings,
          ...(c.source_path
            ? { detail: `from ${c.source_path}  ·  sha256 ${(c.source_sha256 ?? '').slice(0, 16)}…` }
            : {}),
        })),
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
                : `none run (${input.testLevel})`,
            bad: result.numberTestErrors > 0,
          },
        ],
        blast,
        warnings: permCoverage.warning ? [permCoverage.warning] : [],
      }),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );

    this.audit.record('deploy.validated', {
      connectionId: conn.id,
      tool: 'validate_deploy',
      detail: {
        requestId: request.id,
        validationId,
        components: input.components.length,
        deletions: input.destructive.length,
        testLevel: input.testLevel,
      },
    });
    return {
      summary,
      validation_passed: true,
      approval: approvalForAgent('deploy', approval),
    };
  }

  async executeDeploy(
    conn: ConnectionRecord,
    code: string,
  ): Promise<JobOutcome<Record<string, unknown>>> {
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
    return this.runJob(jobKey, (job) => this.doExecute(conn, claim.request, job));
  }

  private async doExecute(
    conn: ConnectionRecord,
    request: DeployRequestRecord,
    job?: Job<unknown>,
  ): Promise<Record<string, unknown>> {
    // The code is already spent (status='executing') — any failure below
    // leaves it non-reusable, so a retry cannot re-drive the deploy.
    const summary = JSON.parse(request.summaryJson) as Record<string, unknown>;
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);

    if (!request.payloadPath || !fs.existsSync(request.payloadPath)) {
      this.audit.record('deploy.execution_failed', {
        connectionId: conn.id,
        tool: 'execute_deploy',
        outcome: 'error',
        detail: { requestId: request.id, reason: 'payload_missing' },
      });
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
    const quickEligible =
      typeof request.validationId === 'string' &&
      request.validationId.length > 0 &&
      (options.testLevel ?? 'NoTestRun') !== 'NoTestRun';
    let quickDeploy = false;
    let quickFallbackReason: string | null = null;

    let deployId: string;
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
            testLevel: options.testLevel ?? 'NoTestRun',
            runTests: options.runTests ?? [],
          });
        }
      } else {
        deployId = await soap.deploy(zip, {
          checkOnly: false,
          testLevel: options.testLevel ?? 'NoTestRun',
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
      return this.finishExecution(conn, request, 'execution_failed', {
        connection: conn.alias,
        deployed: false,
        error_message: message,
        note:
          'The deploy did not complete cleanly. The confirmation code is spent — check the ' +
          'org (Setup → Deployment Status) before retrying, and re-validate for a new code.',
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

    const approval = await this.approvals.present(
      renderApprovalPage({
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
        results,
        blast: [],
        ...(isDmlPlan(input) && !input.all_or_none
          ? {
              warnings: [
                'This plan is NOT atomic — approve only if partial completion is acceptable.',
              ],
            }
          : {}),
      }),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );

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
    return {
      connection: conn.alias,
      org_type: conn.orgType,
      request_id: request.id,
      ...preview,
      expires_at: expiresAt,
      approval_page: approvalForAgent('dml', approval),
    };
  }

  async executeDml(conn: ConnectionRecord, code: string): Promise<Record<string, unknown>> {
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
      return this.executeDmlPlan(conn, rest, request, input);
    }
    const version = this.config.salesforce.apiVersion;

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
      ...(succeeded
        ? {}
        : { note: 'all-or-none: every row was rolled back because at least one failed.' }),
    };
    this.db.finishDeployRequest(request.id, succeeded ? 'executed' : 'execution_failed', JSON.stringify(payload));
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
  ): Promise<Record<string, unknown>> {
    const version = this.config.salesforce.apiVersion;
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
      ...(executed
        ? {}
        : {
            note: input.all_or_none
              ? 'all-or-none: every step was rolled back because at least one failed.'
              : 'continue-on-failure: successful steps were KEPT; failed/dependent steps were not applied.',
          }),
    };
    this.db.finishDeployRequest(request.id, terminalStatus, JSON.stringify(payload));
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

    const approval = await this.approvals.present(
      renderApprovalPage({
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
      }),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );

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
      approval_page: approvalForAgent('apex', approval),
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
    this.audit.record(status === 'executed' ? 'apex.executed' : 'apex.execution_failed', {
      connectionId: conn.id,
      tool: 'apex_execute',
      outcome: status === 'executed' ? 'success' : 'error',
      detail: { requestId: request.id, status },
    });
    return result;
  }

  // ── bulk data loads ────────────────────────────────────────────────────

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
        let scan;
        try {
          scan = scanCsv(bytes);
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
        const file = `step-${n}.csv`;
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

    const approval = await this.approvals.present(
      renderApprovalPage({
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
      }),
      this.requestStatusCheck(request.id),
      this.config.deploy.codeTtlMs + 60_000,
    );

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
      approval_page: approvalForAgent('bulk', approval),
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

      if (info && jobId && stepFailed) {
        try {
          const p = writeResultCsv(
            `step-${m.n}-failed.csv`,
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
            `step-${m.n}-unprocessed.csv`,
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
    if (
      request.status === 'superseded' ||
      request.status === 'expired' ||
      request.status === 'locked'
    ) {
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: { reason: request.status, requestId: request.id },
      });
      const why =
        request.status === 'expired'
          ? 'it timed out'
          : request.status === 'locked'
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
      this.db.updateDeployRequestStatus(request.id, 'expired');
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
              `SELECT Id FROM ${step.object} WHERE Id = '${step.id}'`,
              1,
            );
            if (found.length === 0) {
              warnings = ['record not found in pre-check — it may already be gone or the id is wrong'];
            }
          } catch (err) {
            log('warn', 'could not pre-check id for DML plan delete preview', { err: String(err) });
            warnings = ['could not verify this id exists (pre-check failed)'];
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
      if (!idIsToken && step.id) {
        const fields = Object.keys(step.record ?? {});
        try {
          const soql = `SELECT Id${fields.length ? ', ' + fields.join(', ') : ''} FROM ${
            step.object
          } WHERE Id = '${step.id}'`;
          prior = (await rest.query<Record<string, unknown>>(soql, 1))[0];
        } catch (err) {
          log('warn', 'could not fetch before-values for DML plan preview', { err: String(err) });
        }
      }
      const changes = Object.entries(step.record ?? {})
        .map(([k, v]) => {
          const shown = typeof v === 'string' && REF_TOKEN_RE.test(v) ? symbolic(v) : JSON.stringify(v);
          const old = prior?.[k];
          return prior && old !== undefined ? `${k}: ${JSON.stringify(old)} → ${shown}` : `${k} = ${shown}`;
        })
        .join(', ');
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
      const before = new Map<string, Record<string, unknown>>();
      try {
        const soql = `SELECT Id${fields.length ? ', ' + fields.join(', ') : ''} FROM ${
          input.object
        } WHERE Id IN (${ids.map((i) => `'${i}'`).join(',')})`;
        for (const row of await rest.query<Record<string, unknown>>(soql, 200)) {
          before.set(String(row.Id), row);
        }
      } catch (err) {
        log('warn', 'could not fetch before-values for DML preview', { err: String(err) });
      }
      const rows = records.map((r) => {
        const id = String(r.Id ?? r.id);
        const prior = before.get(id);
        const changes = Object.entries(r)
          .filter(([k]) => k.toLowerCase() !== 'id')
          .map(([k, v]) => {
            const old = prior?.[k];
            return prior && old !== undefined
              ? `${k}: ${JSON.stringify(old)} → ${JSON.stringify(v)}`
              : `${k} = ${JSON.stringify(v)}`;
          })
          .join(', ');
        return {
          label: `UPDATE ${input.object} ${id}: ${truncateLabel(changes)}`,
          warnings: prior ? [] : ['record not found in pre-check — verify the id'],
        };
      });
      return { operation: 'update', object: input.object, row_count: rows.length, rows };
    }
    const ids = input.ids ?? [];
    const found = new Set<string>();
    let precheckOk = true;
    try {
      const soql = `SELECT Id FROM ${input.object} WHERE Id IN (${ids
        .map((i) => `'${i}'`)
        .join(',')})`;
      for (const row of await rest.query<{ Id: string }>(soql, 200)) found.add(row.Id);
    } catch (err) {
      precheckOk = false;
      log('warn', 'could not pre-check ids for DML delete preview', { err: String(err) });
    }
    const rows = ids.map((id) => ({
      label: `DELETE ${input.object} ${id}`,
      warnings: !precheckOk
        ? ['could not verify this id exists (pre-check failed)']
        : !found.has(id)
          ? ['record not found in pre-check — it may already be gone or the id is wrong']
          : [],
    }));
    return {
      operation: 'delete',
      object: input.object,
      row_count: rows.length,
      rows,
      ...(precheckOk ? {} : { precheck: 'failed — existence of these records is unconfirmed' }),
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
          j.result = result;
          return result;
        })
        .catch((err) => {
          j.done = true;
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

/** The human-facing noun for a pending request of each kind. */
function kindNoun(kind: DeployRequestKind): string {
  return kind === 'deploy'
    ? 'deploy'
    : kind === 'apex'
      ? 'Apex script'
      : kind === 'bulk'
        ? 'bulk data load'
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

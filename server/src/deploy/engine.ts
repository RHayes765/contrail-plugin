import fs from 'node:fs';
import path from 'node:path';
import type { ContrailDb } from '../core/db.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord, DeployRequestRecord } from '../core/types.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { SnapshotStore } from '../snapshot/store.js';
import { MetadataSoapClient, type DeployResult, type TestLevel } from '../salesforce/metadataSoap.js';
import { RestClient, stripAttributes } from '../salesforce/rest.js';
import { queryDependencies } from '../deps/graph.js';
import { deploysDir } from '../core/paths.js';
import { ContrailError } from '../core/errors.js';
import { generateConfirmationCode } from './codes.js';
import { ApprovalPageServer } from './approval.js';
import { renderApprovalPage } from '../connect/pages.js';
import {
  analyzeChanges,
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

    // Blast radius per touched component; deletions with dependents get an
    // explicit warning on the destructive entry itself.
    const blast: string[] = [];
    for (const item of [...changes, ...destructive]) {
      const graph = queryDependencies(this.db, conn.id, item.type, item.api_name, 'used_by', 1);
      if (graph.nodes.length > 0) {
        const names = graph.nodes.slice(0, 5).map((n) => `${n.type}:${n.name}`);
        const parts =
          names.join(', ') +
          (graph.nodes.length > names.length ? ` +${graph.nodes.length - names.length} more` : '');
        blast.push(`${item.type}:${item.api_name} ← used by ${parts}`);
        if (item.change === 'delete') {
          item.warnings.push(`deleting this breaks dependents: ${parts}`);
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
          note: 'Validation failed — no confirmation code was issued. Fix the failures and validate again.',
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
      }),
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

    let deployId: string;
    let result;
    try {
      deployId = await soap.deploy(zip, {
        checkOnly: false,
        testLevel: options.testLevel ?? 'NoTestRun',
        runTests: options.runTests ?? [],
      });
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

  async proposeDml(
    conn: ConnectionRecord,
    input: {
      operation: 'insert' | 'update' | 'delete';
      object: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const superseded = this.db.supersedePendingRequests(conn.id, 'dml');
    if (superseded > 0) {
      this.audit.record('dml.superseded', {
        connectionId: conn.id,
        tool: 'dml_propose',
        detail: { count: superseded },
      });
    }
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const preview = await this.buildDmlPreview(rest, input);

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

    const rowLabels = (preview.rows as Array<{ label: string; warnings: string[] }>).slice(0, 50);
    const extra = (preview.rows as unknown[]).length - rowLabels.length;
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
        changes:
          input.operation === 'delete'
            ? []
            : [...rowLabels, ...(extra > 0 ? [{ label: `… and ${extra} more rows`, warnings: [] }] : [])],
        destructive:
          input.operation === 'delete'
            ? [...rowLabels, ...(extra > 0 ? [{ label: `… and ${extra} more rows`, warnings: [] }] : [])]
            : [],
        results: [
          { label: 'Operation', value: `${input.operation.toUpperCase()} ${input.object}` },
          { label: 'Rows', value: String(preview.row_count) },
          { label: 'Mode', value: 'all-or-none (any failure rolls back every row)' },
        ],
        blast: [],
      }),
    );

    this.audit.record('dml.proposed', {
      connectionId: conn.id,
      tool: 'dml_propose',
      detail: {
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
    const input = JSON.parse(request.payloadJson ?? '{}') as {
      operation: 'insert' | 'update' | 'delete';
      object: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
    };
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
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
    const payload = {
      connection: conn.alias,
      operation: input.operation,
      object: input.object,
      executed: succeeded,
      rows: results.length,
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

  // ── shared internals ───────────────────────────────────────────────────

  /**
   * Resolve a human-supplied code to an execution claim. Atomically flips
   * 'validated'→'executing' so exactly one caller may proceed; polls and
   * concurrent callers re-attach ('running') or receive the stored terminal
   * result ('terminal'); bad/expired codes are refused and audited.
   */
  private claimCode(
    conn: ConnectionRecord,
    kind: 'deploy' | 'dml',
    code: string,
    tool: string,
  ):
    | { kind: 'claimed' | 'running'; request: DeployRequestRecord }
    | { kind: 'terminal'; result: Record<string, unknown> } {
    const request = this.db.findRequestByCode(conn.id, kind, code);
    if (!request) {
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: { reason: 'no_matching_code' },
      });
      throw new ContrailError(
        `No ${kind === 'deploy' ? 'deploy' : 'change'} on "${conn.alias}" matches that code. ` +
          `Codes are single-use, expire after ~1 hour, and are replaced by re-validation — ask ` +
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
    if (request.status === 'superseded' || request.status === 'expired') {
      this.audit.record(`${kind}.refused`, {
        connectionId: conn.id,
        tool,
        outcome: 'refused',
        detail: { reason: request.status, requestId: request.id },
      });
      throw new ContrailError(
        `That confirmation code is ${request.status} — ${
          request.status === 'expired' ? 'it timed out' : 'a newer validation replaced it'
        }. Validate again for a fresh one.`,
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
  private async runJob<T>(key: string, work: (job: Job<T>) => Promise<T>): Promise<JobOutcome<T>> {
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
      delay(this.config.deploy.toolWaitMs).then(() => null),
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
  kind: 'deploy' | 'dml',
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

function safeUnlink(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

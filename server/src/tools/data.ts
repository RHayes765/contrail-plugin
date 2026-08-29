import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import type { Grant } from '../core/grants.js';
import { RestClient, stripAttributes } from '../salesforce/rest.js';

/**
 * Setup sObjects that expose metadata or diagnostics content through the
 * plain data API. A query touching one requires the corresponding grant on
 * top of data_read — otherwise `SELECT Body FROM ApexClass` would read what
 * the grant model reserves for metadata_read.
 */
const GRANT_GATED_SOBJECTS: Readonly<Record<string, Grant>> = {
  apexclass: 'metadata_read',
  apextrigger: 'metadata_read',
  apexpage: 'metadata_read',
  apexcomponent: 'metadata_read',
  emailtemplate: 'metadata_read',
  staticresource: 'metadata_read',
  flowdefinitionview: 'metadata_read',
  apexlog: 'diagnostics_read',
  flowinterview: 'diagnostics_read',
};

/**
 * data_read and diagnostics_read tools (spec §4). Row-capped, count included;
 * diagnostics accepts incidental record data knowingly — the skill tells the
 * agent to treat it as client-confidential.
 */

const DEFAULT_ROWS = 500;
const MAX_ROWS = 2000;
const MAX_RESPONSE_CHARS = 150_000;
const LOG_SLICE = 30_000;

export function registerDataTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, config, tokenMgr } = deps;

  function requireConnection(ref: string, tool: string): ConnectionRecord {
    const rec = db.resolveConnection(ref);
    if (!rec) throw new ConnectionNotFoundError(ref);
    assertGrant(rec, tool, audit);
    return rec;
  }

  function rest(conn: ConnectionRecord): RestClient {
    return new RestClient(tokenMgr, conn, config.salesforce.apiVersion);
  }

  server.registerTool(
    'soql_query',
    {
      title: 'Run a SOQL query',
      description:
        'Run a read-only SOQL SELECT against a connection. Row-capped (default 500, max ' +
        '2000) with the org-side total count included so truncation is never silent.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        query: z.string().min(8).describe('The SOQL SELECT statement.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROWS)
          .optional()
          .describe(`Row cap (default ${DEFAULT_ROWS}).`),
      },
    },
    async (args: { connection: string; query: string; limit?: number }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'soql_query');
        const soql = args.query.trim();
        if (!/^select\s/i.test(soql)) return fail('Only SELECT queries are accepted.');
        // Structural checks run on the literal-stripped text so quoted values
        // can neither trip them nor hide from them.
        const structural = stripSoqlLiterals(soql);
        if (/\bfor\s+update\b/i.test(structural)) {
          return fail('FOR UPDATE locks rows — not available through soql_query.');
        }
        for (const m of structural.matchAll(/\bFROM\s+([A-Za-z0-9_]+)/gi)) {
          const required = GRANT_GATED_SOBJECTS[m[1]!.toLowerCase()];
          if (required && !conn.grants[required]) {
            audit.record('grant.refused', {
              connectionId: conn.id,
              tool: 'soql_query',
              outcome: 'refused',
              detail: { required, sobject: m[1] },
            });
            return fail(
              `${m[1]} carries ${required === 'metadata_read' ? 'metadata' : 'diagnostics'} ` +
                `content, so querying it requires the "${required}" grant on "${conn.alias}" ` +
                `in addition to data_read. Grants are set on the connection management page ` +
                `(manage_connection).`,
            );
          }
        }
        const cap = args.limit ?? DEFAULT_ROWS;
        const { records, totalSize } = await rest(conn).queryWithCount(soql, cap);
        const cleaned = records.map((r) => truncateDeep(stripAttributes(r)));
        const { kept, dropped } = fitToBudget(cleaned, MAX_RESPONSE_CHARS);
        const truncated =
          dropped > 0 || (totalSize !== null && kept.length > 0 && totalSize > kept.length);
        return ok({
          connection: conn.alias,
          total_size: totalSize,
          returned: kept.length,
          row_cap: cap,
          truncated,
          ...(kept.length === 0 && (totalSize ?? 0) > 0
            ? { note: 'Aggregate/COUNT query — total_size carries the result; there is no row payload.' }
            : dropped > 0
              ? { note: `${dropped} rows omitted to keep the response under the size budget.` }
              : {}),
          records: kept,
        });
      }),
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get one record by id',
      description: 'Fetch a single record by object API name and record id.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
        id: z.string().describe('15- or 18-character record id.'),
        fields: z
          .array(z.string())
          .optional()
          .describe('Specific fields to fetch (default: all accessible).'),
      },
    },
    async (args: { connection: string; object: string; id: string; fields?: string[] }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'get_record');
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(args.id)) return fail('invalid record id');
        if (args.fields?.some((f) => !/^[A-Za-z0-9_.]+$/.test(f))) {
          return fail('invalid field name');
        }
        const path =
          `/services/data/${config.salesforce.apiVersion}/sobjects/` +
          `${encodeURIComponent(args.object)}/${encodeURIComponent(args.id)}` +
          (args.fields?.length ? `?fields=${encodeURIComponent(args.fields.join(','))}` : '');
        const res = await rest(conn).request(path);
        const record = truncateDeep(stripAttributes((await res.json()) as Record<string, unknown>));
        return ok({ connection: conn.alias, object: args.object, record });
      }),
  );

  server.registerTool(
    'get_debug_logs',
    {
      title: 'List or read Apex debug logs',
      description:
        'Without log_id: list recent debug logs (user, operation, status, size, time). With ' +
        'log_id: fetch that log\'s body — head and tail slices for large logs. Log bodies ' +
        'can contain record data; treat as client-confidential.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        log_id: z.string().optional().describe('ApexLog id to fetch the body of.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max logs to list (default 10).'),
      },
    },
    async (args: { connection: string; log_id?: string; limit?: number }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'get_debug_logs');
        const client = rest(conn);
        if (args.log_id) {
          if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(args.log_id)) {
            return fail('invalid log id');
          }
          const res = await client.request(
            `/services/data/${config.salesforce.apiVersion}/tooling/sobjects/ApexLog/` +
              `${encodeURIComponent(args.log_id)}/Body`,
          );
          const body = await res.text();
          if (body.length <= LOG_SLICE * 2) {
            return ok({ connection: conn.alias, log_id: args.log_id, length: body.length, body });
          }
          return ok({
            connection: conn.alias,
            log_id: args.log_id,
            length: body.length,
            note: `Log is ${body.length} chars; returning head and tail slices.`,
            head: body.slice(0, LOG_SLICE),
            tail: body.slice(-LOG_SLICE),
          });
        }
        const rows = await client.toolingQuery<Record<string, unknown>>(
          `SELECT Id, LogUser.Name, Operation, Request, Status, LogLength, StartTime, ` +
            `DurationMilliseconds FROM ApexLog ORDER BY StartTime DESC LIMIT ${args.limit ?? 10}`,
        );
        return ok({
          connection: conn.alias,
          count: rows.length,
          logs: rows.map((r) => stripAttributes(r)),
        });
      }),
  );

  server.registerTool(
    'run_apex_tests',
    {
      title: 'Run Apex tests standalone (no deploy)',
      description:
        'Run already-deployed Apex tests via the Tooling API. No DML from the test ' +
        'transactions is committed — no records are created, updated, or deleted — so this ' +
        'needs no approval; the run DOES write test-history and coverage rows, spend the ' +
        'org\'s daily async-test allowance, and generate debug logs under an active trace ' +
        'flag. Two-step: submit with class_names (or tests for method-level targeting) and ' +
        'get a test_run_id; call again with test_run_id to poll, then read per-method ' +
        'outcomes and per-class aggregate coverage. NEW or edited test classes must reach ' +
        'the org first via validate_deploy / execute_deploy.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        class_names: z
          .array(z.string())
          .min(1)
          .max(50)
          .optional()
          .describe('Test classes to run whole. Exactly one of class_names, tests, test_run_id.'),
        tests: z
          .array(
            z.object({
              class_name: z.string(),
              methods: z.array(z.string()).min(1).max(50).optional(),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe('Method-level targeting: per class, optionally specific test methods.'),
        test_run_id: z
          .string()
          .regex(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/)
          .optional()
          .describe('AsyncApexJob id from a previous submit — polls status and results.'),
      },
    },
    async (args: {
      connection: string;
      class_names?: string[];
      tests?: Array<{ class_name: string; methods?: string[] }>;
      test_run_id?: string;
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'run_apex_tests');
        const client = rest(conn);
        const modes = [args.class_names, args.tests, args.test_run_id].filter(
          (v) => v !== undefined,
        );
        if (modes.length !== 1) {
          return fail('Pass exactly one of class_names, tests, or test_run_id.');
        }

        if (args.test_run_id !== undefined) {
          return pollApexTestRun(client, conn.alias, args.test_run_id);
        }

        const APEX_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;
        const METHOD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
        for (const name of args.class_names ?? args.tests!.map((t) => t.class_name)) {
          if (!APEX_NAME.test(name)) return fail(`invalid Apex class name "${name}"`);
        }
        for (const t of args.tests ?? []) {
          for (const m of t.methods ?? []) {
            if (!METHOD_NAME.test(m)) return fail(`invalid test method name "${m}"`);
          }
        }

        const body = args.class_names
          ? { classNames: args.class_names.join(',') }
          : {
              tests: args.tests!.map((t) => ({
                className: t.class_name,
                ...(t.methods ? { testMethods: t.methods } : {}),
              })),
            };
        const res = await client.request(
          `/services/data/${config.salesforce.apiVersion}/tooling/runTestsAsynchronous`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        const runId = (await res.json()) as unknown;
        if (typeof runId !== 'string' || !SF_ID_RE.test(runId)) {
          return fail(
            `unexpected response from the test runner: ${JSON.stringify(runId).slice(0, 200)}`,
          );
        }
        return ok({
          connection: conn.alias,
          test_run_id: runId,
          status: 'Queued',
          note:
            'Submitted — no DML from the tests is committed (the run does write test-history ' +
            'rows and spend the async-test allowance). Call run_apex_tests again with this ' +
            'test_run_id to poll for results.',
        });
      }),
  );

  server.registerTool(
    'set_trace_flag',
    {
      title: 'Turn on debug logging (trace flag)',
      description:
        'Turn on debug logging for the connected user for a bounded window (default 30 ' +
        'minutes, max 60), so anonymous Apex, test runs, and flows executed by that user ' +
        'produce logs readable via get_debug_logs. Side effects, honestly: writes a ' +
        'self-expiring TraceFlag row and (first use) a reusable "Contrail_Debug" DebugLevel ' +
        "to the org, and generated logs consume the org's shared debug-log allocation until " +
        'the flag expires. If the user already has a trace flag, its expiry is extended ' +
        'rather than stacking a second one.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('How long logging stays on (default 30).'),
      },
    },
    async (args: { connection: string; minutes?: number }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'set_trace_flag');
        const client = rest(conn);
        const version = config.salesforce.apiVersion;
        const minutes = args.minutes ?? 30;
        const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

        // Whose activity gets traced: the stored user id, else a lookup by the
        // stored username. A connection with neither has lost its identity.
        let userId = conn.userId && SF_ID_RE.test(conn.userId) ? conn.userId : null;
        if (!userId && conn.username) {
          const users = await client.query<{ Id: string }>(
            `SELECT Id FROM User WHERE Username = '${conn.username.replace(/'/g, "\\'")}' LIMIT 1`,
            1,
          );
          userId = users[0]?.Id ?? null;
        }
        if (!userId) {
          return fail(
            `Cannot determine which user to trace on "${conn.alias}" — the stored connection ` +
              'has no user id or username. Re-connect the org (connect_org) to refresh it.',
          );
        }

        const existing = await client.toolingQuery<{ Id: string; ExpirationDate: string | null }>(
          `SELECT Id, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' ` +
            `AND LogType = 'USER_DEBUG' ORDER BY ExpirationDate DESC LIMIT 1`,
          1,
        );

        let action: 'created' | 'extended';
        let debugLevel: string;
        if (existing.length > 0) {
          // Extending beats stacking: orgs cap concurrent trace flags per
          // entity, and the human may have configured their own debug level —
          // which stays in force (only the expiry moves).
          await client.request(
            `/services/data/${version}/tooling/sobjects/TraceFlag/${existing[0]!.Id}`,
            { method: 'PATCH', body: JSON.stringify({ ExpirationDate: expiresAt }) },
          );
          action = 'extended';
          debugLevel = "the existing flag's own debug level";
        } else {
          const levels = await client.toolingQuery<{ Id: string }>(
            `SELECT Id FROM DebugLevel WHERE DeveloperName = 'Contrail_Debug' LIMIT 1`,
            1,
          );
          let levelId = levels[0]?.Id ?? null;
          if (!levelId) {
            const res = await client.request(
              `/services/data/${version}/tooling/sobjects/DebugLevel`,
              {
                method: 'POST',
                body: JSON.stringify({
                  DeveloperName: 'Contrail_Debug',
                  MasterLabel: 'Contrail_Debug',
                  ApexCode: 'DEBUG',
                  ApexProfiling: 'INFO',
                  Callout: 'INFO',
                  Database: 'INFO',
                  System: 'DEBUG',
                  Validation: 'INFO',
                  Visualforce: 'INFO',
                  Workflow: 'INFO',
                }),
              },
            );
            levelId = ((await res.json()) as { id: string }).id;
          }
          await client.request(`/services/data/${version}/tooling/sobjects/TraceFlag`, {
            method: 'POST',
            body: JSON.stringify({
              TracedEntityId: userId,
              LogType: 'USER_DEBUG',
              DebugLevelId: levelId,
              ExpirationDate: expiresAt,
            }),
          });
          action = 'created';
          debugLevel = 'Contrail_Debug';
        }

        return ok({
          connection: conn.alias,
          traced_user: conn.username ?? userId,
          action,
          minutes,
          expires_at: expiresAt,
          debug_level: debugLevel,
          note:
            `Debug logging is on until ${expiresAt} — activity by this user now writes debug ` +
            "logs (consuming the org's shared log allocation until the flag expires). Read " +
            'them with get_debug_logs.',
        });
      }),
  );

  server.registerTool(
    'get_flow_errors',
    {
      title: 'List flow interview problems',
      description:
        'List recent persisted flow interviews (paused/errored) with their stuck element. ' +
        'Honest limitation: Salesforce does not persist most failed interviews queryably — ' +
        'full failure detail lives in flow error emails and debug logs (get_debug_logs).',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max interviews to list (default 20).'),
      },
    },
    async (args: { connection: string; limit?: number }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'get_flow_errors');
        const client = rest(conn);
        const n = args.limit ?? 20;
        let rows: Array<Record<string, unknown>>;
        let statusFieldAvailable = true;
        try {
          rows = await client.query(
            `SELECT Id, InterviewLabel, InterviewStatus, CurrentElement, PauseLabel, ` +
              `CreatedDate, CreatedBy.Name FROM FlowInterview ORDER BY CreatedDate DESC LIMIT ${n}`,
          );
        } catch {
          // InterviewStatus is not queryable in every org/API version.
          statusFieldAvailable = false;
          rows = await client.query(
            `SELECT Id, InterviewLabel, CurrentElement, PauseLabel, CreatedDate, ` +
              `CreatedBy.Name FROM FlowInterview ORDER BY CreatedDate DESC LIMIT ${n}`,
          );
        }
        return ok({
          connection: conn.alias,
          count: rows.length,
          interviews: rows.map((r) => stripAttributes(r)),
          status_field_available: statusFieldAvailable,
          note:
            'Persisted interviews are the paused/errored ones Salesforce keeps. Most runtime ' +
            'flow failures are only delivered via error emails and debug logs — use ' +
            'get_debug_logs around the failure time for the full story.',
        });
      }),
  );
}

function fitToBudget(records: unknown[], budget: number): { kept: unknown[]; dropped: number } {
  let total = 0;
  const kept: unknown[] = [];
  for (const r of records) {
    total += JSON.stringify(r).length + 2;
    if (total > budget) break;
    kept.push(r);
  }
  return { kept, dropped: records.length - kept.length };
}

/** Blank out quoted literals (keeping length illusions out of structural regexes). */
function stripSoqlLiterals(soql: string): string {
  return soql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const MAX_STRING_FIELD = 10_000;

/** Cap individual string fields — one giant rich-text field must not eat the response. */
function truncateDeep(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_STRING_FIELD) {
    return `${value.slice(0, MAX_STRING_FIELD)}… [truncated ${value.length - MAX_STRING_FIELD} chars]`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v);
    return out;
  }
  return value;
}

const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/**
 * Poll a runTestsAsynchronous job: queue status while running; on completion,
 * per-method outcomes plus per-class aggregate coverage for the classes these
 * tests exercised. Coverage is best-effort — its failure never sinks results.
 */
async function pollApexTestRun(client: RestClient, alias: string, runId: string) {
  if (!SF_ID_RE.test(runId)) return fail('invalid test_run_id');
  const queue = await client.toolingQuery<{
    Status: string;
    ApexClassId: string;
  }>(`SELECT Status, ApexClassId FROM ApexTestQueueItem WHERE ParentJobId = '${runId}'`);
  if (queue.length === 0) {
    return fail(
      `No test run found for id ${runId} — it may predate what the org retains, or belong to another org.`,
    );
  }
  const queueCounts: Record<string, number> = {};
  for (const item of queue) queueCounts[item.Status] = (queueCounts[item.Status] ?? 0) + 1;
  const done = queue.every((item) => ['Completed', 'Failed', 'Aborted'].includes(item.Status));
  if (!done) {
    return ok({
      connection: alias,
      test_run_id: runId,
      status: 'InProgress',
      queue: queueCounts,
      note: 'Still running — call run_apex_tests again with test_run_id to check.',
    });
  }
  // Terminal is NOT the same as passed: an aborted run or a class-level failure
  // leaves queue items in Aborted/Failed with few or no ApexTestResult rows —
  // reporting that as "Completed, 0 failures" would be a false green.
  const allCompleted = queue.every((item) => item.Status === 'Completed');
  const terminalStatus = allCompleted
    ? 'Completed'
    : queue.some((item) => item.Status === 'Aborted')
      ? 'Aborted'
      : 'Failed';

  const RESULT_CAP = 2000;
  const rows = await client.toolingQuery<{
    Outcome: string;
    MethodName: string;
    Message: string | null;
    StackTrace: string | null;
    RunTime: number | null;
    ApexClass: { Name: string } | null;
  }>(
    `SELECT Outcome, MethodName, Message, StackTrace, RunTime, ApexClass.Name ` +
      `FROM ApexTestResult WHERE AsyncApexJobId = '${runId}' ORDER BY MethodName`,
    RESULT_CAP + 1,
  );
  const resultsTruncated = rows.length > RESULT_CAP;
  if (resultsTruncated) rows.length = RESULT_CAP;
  const totals = { run: rows.length, passed: 0, failed: 0, skipped: 0 };
  const byClass: Record<string, { passed: number; failed: number; skipped: number }> = {};
  for (const r of rows) {
    const cls = r.ApexClass?.Name ?? '(unknown)';
    const bucket = (byClass[cls] ??= { passed: 0, failed: 0, skipped: 0 });
    if (r.Outcome === 'Pass') {
      totals.passed += 1;
      bucket.passed += 1;
    } else if (r.Outcome === 'Skip') {
      totals.skipped += 1;
      bucket.skipped += 1;
    } else {
      totals.failed += 1; // Fail and CompileFail alike
      bucket.failed += 1;
    }
  }
  const failures = rows
    .filter((r) => r.Outcome !== 'Pass' && r.Outcome !== 'Skip')
    .slice(0, 100)
    .map((r) => ({
      class: r.ApexClass?.Name ?? null,
      method: r.MethodName,
      outcome: r.Outcome,
      message: r.Message,
      stack_trace: r.StackTrace,
      runtime_ms: r.RunTime,
    }));

  let coverage:
    | Array<{
        class: string;
        percent: number | null;
        lines_covered: number;
        lines_uncovered: number;
      }>
    | undefined;
  let coverageNote: string | undefined;
  try {
    const testClassIds = [...new Set(queue.map((q) => q.ApexClassId))].filter((id) =>
      SF_ID_RE.test(id),
    );
    if (testClassIds.length > 0) {
      const covered = await client.toolingQuery<{ ApexClassOrTriggerId: string }>(
        `SELECT ApexClassOrTriggerId FROM ApexCodeCoverage WHERE ApexTestClassId IN (` +
          testClassIds.map((id) => `'${id}'`).join(',') +
          `)`,
        2000,
      );
      const coveredIds = [...new Set(covered.map((c) => c.ApexClassOrTriggerId))].filter((id) =>
        SF_ID_RE.test(id),
      );
      if (coveredIds.length > 0) {
        const agg = await client.toolingQuery<{
          NumLinesCovered: number | null;
          NumLinesUncovered: number | null;
          ApexClassOrTrigger: { Name: string } | null;
        }>(
          `SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered ` +
            `FROM ApexCodeCoverageAggregate WHERE ApexClassOrTriggerId IN (` +
            coveredIds.map((id) => `'${id}'`).join(',') +
            `)`,
          2000,
        );
        coverage = agg.map((a) => {
          const coveredLines = a.NumLinesCovered ?? 0;
          const total = coveredLines + (a.NumLinesUncovered ?? 0);
          return {
            class: a.ApexClassOrTrigger?.Name ?? '(unknown)',
            percent: total > 0 ? Math.round((coveredLines / total) * 1000) / 10 : null,
            lines_covered: coveredLines,
            lines_uncovered: a.NumLinesUncovered ?? 0,
          };
        });
        coverageNote =
          'Org-wide aggregate coverage for the classes these tests exercise — the union of ' +
          'ALL tests that touch them, not attributable to this run alone.';
      }
    }
    if (!coverage) {
      coverageNote = 'No coverage rows were available for this run.';
    }
  } catch (err) {
    coverageNote = `Coverage unavailable: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
  }

  return ok({
    connection: alias,
    test_run_id: runId,
    status: terminalStatus,
    queue: queueCounts,
    totals,
    by_class: byClass,
    failures,
    ...(terminalStatus !== 'Completed'
      ? {
          note:
            `Run ended ${terminalStatus} — some test classes never produced results ` +
            `(aborted from Setup, or the class failed before its tests ran). ` +
            `Do NOT read the totals as a pass.`,
        }
      : {}),
    ...(resultsTruncated
      ? {
          results_truncated: true,
          results_note: `Showing the first ${RESULT_CAP} results — totals are PARTIAL, not the whole run.`,
        }
      : {}),
    ...(totals.failed > 100
      ? { failures_note: `Showing first 100 of ${totals.failed} failures.` }
      : {}),
    ...(coverage ? { coverage } : {}),
    ...(coverageNote ? { coverage_note: coverageNote } : {}),
  });
}

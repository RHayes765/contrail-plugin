import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { resolveSourceFile } from '../deploy/sources.js';
import { stagingDir } from '../core/paths.js';
import { flowDeactivationXml } from '../deploy/package.js';
import type { TestLevel } from '../salesforce/metadataSoap.js';

/**
 * The write tools (spec §4/§5). Both pairs are two-step: the validate/propose
 * step computes consequences and puts a confirmation code on the human-only
 * approval page; the execute step demands that code. The code NEVER appears
 * in a tool result — if you have not been told it by the human, you cannot
 * execute, and that is the design.
 */

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const APPROVAL_INSTRUCTIONS =
  'The confirmation code is displayed ONLY on the approval page in the human\'s browser — ' +
  'it is not available to you anywhere. Present this summary (destructive changes first), ' +
  'then ask the human to review the page and read the code back if they approve.';

const REF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const REF_TOKEN_RE = /^@\{([A-Za-z][A-Za-z0-9_]*)\.id\}$/;

/**
 * Grammar/shape validation for a multi-step plan. Semantics (FLS, required
 * fields, validation rules) are the ORG's to judge at execute — with
 * all_or_none defaulting true, an org refusal rolls back cleanly and spends
 * the code, same as a flat failure. What must be exact here is the reference
 * grammar: a token that survives to the org malformed gets "substituted" into
 * garbage, and the preview would have lied about what gets written.
 * Returns an error message, or null when the plan is well-formed.
 */
function validateDmlPlan(args: {
  operation?: string;
  object?: string;
  records?: unknown[];
  ids?: unknown[];
  steps?: Array<{
    ref?: string;
    operation: 'insert' | 'update' | 'delete';
    object: string;
    record?: Record<string, unknown>;
    id?: string;
  }>;
}): string | null {
  if (args.operation || args.object || args.records || args.ids) {
    return 'Send either steps (a plan) or the flat operation/object fields — not both.';
  }
  const steps = args.steps ?? [];
  // Tokens may only cite EXPLICIT refs of EARLIER INSERT steps: inserts are
  // the only steps whose composite response carries an id (update/delete
  // return 204 with no body), and forward/self references can never resolve.
  const insertRefsSoFar = new Set<string>();
  const allRefs = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const where = `step ${i + 1}`;
    if (!/^[A-Za-z0-9_]+$/.test(step.object)) return `${where}: invalid object API name`;
    if (/__mdt$/i.test(step.object)) {
      return (
        `${where}: ${step.object} is a custom metadata type — its records are METADATA, ` +
        `not data, and the REST API cannot write them. Deploy the record instead: ` +
        `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
        `(type name without __mdt).`
      );
    }
    if (step.ref !== undefined) {
      if (!REF_RE.test(step.ref)) return `${where}: invalid ref "${step.ref}" (letters/digits/_, start with a letter)`;
      if (allRefs.has(step.ref)) return `${where}: duplicate ref "${step.ref}"`;
      allRefs.add(step.ref);
    }
    const checkToken = (value: string, slot: string): string | null => {
      const m = REF_TOKEN_RE.exec(value);
      if (!m) return `${where}: ${slot} contains "@{" but is not a whole-value "@{ref.id}" token`;
      if (!insertRefsSoFar.has(m[1]!)) {
        return `${where}: ${slot} references "@{${m[1]}.id}" which is not an EARLIER insert step's ref`;
      }
      return null;
    };

    if (step.operation === 'insert') {
      if (!step.record || Object.keys(step.record).length === 0) return `${where}: insert requires record`;
      if (step.id !== undefined) return `${where}: insert must not carry id`;
    } else {
      if (step.id === undefined) return `${where}: ${step.operation} requires id (a record id or "@{ref.id}")`;
      if (!ID_RE.test(step.id)) {
        const bad = checkToken(step.id, 'id');
        if (bad) return bad;
      }
      if (step.operation === 'update' && (!step.record || Object.keys(step.record).length === 0)) {
        return `${where}: update requires record`;
      }
      if (step.operation === 'delete' && step.record !== undefined) {
        return `${where}: delete must not carry record`;
      }
    }

    for (const [key, value] of Object.entries(step.record ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) return `${where}: invalid field name "${key}"`;
      // Salesforce rejects Id inside a PATCH body — the target lives in `id`.
      if (key.toLowerCase() === 'id') return `${where}: never put Id inside record — the target goes in the id slot`;
      if (typeof value === 'string' && /@\{/.test(value)) {
        const bad = checkToken(value, `field "${key}"`);
        if (bad) return bad;
      }
    }

    if (step.operation === 'insert' && step.ref) insertRefsSoFar.add(step.ref);
  }
  return null;
}

export function registerDeployTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, deploys, config } = deps;

  function requireConnection(ref: string, tool: string): ConnectionRecord {
    const rec = db.resolveConnection(ref);
    if (!rec) throw new ConnectionNotFoundError(ref);
    assertGrant(rec, tool, audit);
    return rec;
  }

  server.registerTool(
    'validate_deploy',
    {
      title: 'Validate a metadata deploy (checkOnly)',
      description:
        'Build a deploy package and validate it against the org with checkOnly=true — ' +
        'nothing is committed. Returns the change summary (destructive changes flagged), ' +
        'validation/test results, and blast radius; puts a confirmation code on the ' +
        'human-only approval page. For production targets prefer test_level RunLocalTests. ' +
        'An in-progress result means call validate_deploy again to check on it. ' +
        'For anything large — flows especially — write the source to a file and pass ' +
        'content_file instead of content: retyping tens of KB of XML risks a silent ' +
        'one-character corruption, and a file is read byte-exactly.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id) — name it unmissably to the human.'),
        components: z
          .array(
            z.object({
              type: z
                .string()
                .describe(
                  'ApexClass, ApexTrigger, ApexPage, Flow, CustomObject, PermissionSet, ' +
                    'CustomTab, FlexiPage, CustomApplication, ReportType, GlobalValueSet, ' +
                    'ConnectedApp, NamedCredential, ExternalCredential, PlatformEventChannel(Member), ' +
                    'ManagedEventSubscription, Layout, CustomMetadata (records, dotted ' +
                    'Type.Record names), or child types CustomField / ValidationRule / ' +
                    'CustomLabel / ListView / RecordType.',
                ),
              api_name: z.string().describe('Full API name; children dotted (Account.MyField__c).'),
              content: z
                .string()
                .optional()
                .describe(
                  'Full source for file types; for child types, the XML block exactly as ' +
                    'retrieve_metadata returns it (e.g. <fields>…</fields>). Exactly one of ' +
                    'content or content_file is required.',
                ),
              content_file: z
                .string()
                .optional()
                .describe(
                  'Absolute path to a file holding the source, read byte-exactly instead of ' +
                    'content. PREFER THIS for large components. The file must sit under ' +
                    "Contrail's staging directory (see the error message for the exact path), " +
                    'under its snapshots directory, or under a directory the human listed in ' +
                    'deploy.allowedSourceRoots — Contrail will not deploy a file from anywhere ' +
                    'else. Read at validation time and frozen into the approved package, so ' +
                    'editing the file afterwards cannot change what gets deployed.',
                ),
            }),
          )
          .max(50)
          .optional()
          .describe('Components to create or update.'),
        destructive: z
          .array(z.object({ type: z.string(), api_name: z.string() }))
          .max(50)
          .optional()
          .describe('Components to DELETE. Deletions are destructive and flagged prominently.'),
        test_level: z
          .enum(['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests', 'RunAllTestsInOrg'])
          .optional()
          .describe('Default NoTestRun. Production deploys of Apex require tests.'),
        run_tests: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Test classes for RunSpecifiedTests.'),
      },
    },
    async (args: {
      connection: string;
      components?: Array<{
        type: string;
        api_name: string;
        content?: string;
        content_file?: string;
      }>;
      destructive?: Array<{ type: string; api_name: string }>;
      test_level?: TestLevel;
      run_tests?: string[];
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'validate_deploy');
        // Resolve file-backed components to bytes BEFORE anything else: the
        // package is built and frozen from what we read here, so this is the
        // single point where "what will be deployed" is decided.
        const components = (args.components ?? []).map((c) => {
          const hasInline = typeof c.content === 'string';
          if (hasInline && c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: pass content OR content_file, not both — ` +
                'Contrail will not guess which one you meant to deploy.',
            );
          }
          if (!hasInline && !c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: needs content or content_file. For large ` +
                `components write the source under ${stagingDir()} and pass content_file.`,
            );
          }
          if (c.content_file) {
            const src = resolveSourceFile(c.content_file, config.deploy.allowedSourceRoots);
            return {
              type: c.type,
              api_name: c.api_name,
              content: src.content,
              source_path: src.sourcePath,
              source_sha256: src.sourceSha256,
            };
          }
          return { type: c.type, api_name: c.api_name, content: c.content as string };
        });
        const destructive = args.destructive ?? [];
        if (components.length + destructive.length === 0) {
          return fail('Provide at least one component or destructive entry.');
        }
        if (args.test_level === 'RunSpecifiedTests' && !(args.run_tests?.length)) {
          return fail('RunSpecifiedTests requires run_tests.');
        }
        const outcome = await deploys.validateDeploy(conn, {
          components,
          destructive,
          testLevel: args.test_level ?? 'NoTestRun',
          runTests: args.run_tests ?? [],
        });
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Validation is still running — call validate_deploy again with the same connection to check on it.',
            );
          case 'failed':
            return fail(`Validation errored: ${outcome.error}`);
          case 'complete': {
            const r = outcome.result;
            if (!r.validation_passed) {
              return ok(r.failure ?? {}, 'Validation FAILED — no confirmation code was issued.');
            }
            return ok(
              { ...r.summary, approval_page: r.approval },
              `Validation passed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
            );
          }
        }
      }),
  );

  server.registerTool(
    'deactivate_flow',
    {
      title: 'Deactivate a flow',
      description:
        'Deactivate a flow (turn off its active version) — to switch off automation, or as the ' +
        'first step before trying to delete a flow. Routes through the same two-step approval as ' +
        'any write: this validates the change and opens the approval page; the human reads the ' +
        'code back to execute_deploy. Note: deleting a flow via the Metadata API is unreliable ' +
        'even after deactivation ("insufficient access rights on cross-reference id"); if a ' +
        'destructive delete fails, delete the flow in Setup → Flows.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        flow: z.string().describe('Flow API name (DeveloperName).'),
      },
    },
    async (args: { connection: string; flow: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'deactivate_flow');
        if (!/^[A-Za-z0-9_]+$/.test(args.flow)) return fail('invalid flow API name');
        const outcome = await deploys.validateDeploy(conn, {
          components: [
            { type: 'FlowDefinition', api_name: args.flow, content: flowDeactivationXml() },
          ],
          destructive: [],
          testLevel: 'NoTestRun',
          runTests: [],
        });
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Still validating — call deactivate_flow again with the same flow to check on it.',
            );
          case 'failed':
            return fail(`Deactivation validation errored: ${outcome.error}`);
          case 'complete': {
            const r = outcome.result;
            if (!r.validation_passed) {
              return ok(r.failure ?? {}, 'Validation FAILED — no confirmation code was issued.');
            }
            return ok(
              { ...r.summary, approval_page: r.approval },
              `Deactivation of flow "${args.flow}" validated. TARGET: ${conn.alias} ` +
                `(${conn.orgType}). ${APPROVAL_INSTRUCTIONS} Execute it with execute_deploy.`,
            );
          }
        }
      }),
  );

  server.registerTool(
    'execute_deploy',
    {
      title: 'Execute a validated deploy',
      description:
        'Execute the deploy that the given confirmation code approves. The code exists only ' +
        'on the human\'s approval page: never guess, never fabricate, never reuse one — only ' +
        'pass a code the human just gave you. Codes are single-use, expire in ~1h, and are ' +
        'invalidated by any new validation on the same connection.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'execute_deploy');
        const outcome = await deploys.executeDeploy(conn, args.confirmation_code);
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Deploy is still running — call execute_deploy again with the same connection ' +
                'and code to check on it.',
            );
          case 'failed':
            return fail(`Deploy errored: ${outcome.error}`);
          case 'complete':
            return ok(outcome.result);
        }
      }),
  );

  server.registerTool(
    'dml_propose',
    {
      title: 'Propose a data change (two-step)',
      description:
        'Stage a data change with a before/after preview. Nothing touches the org until the ' +
        'human reads the confirmation code from the approval page and you pass it to ' +
        'dml_execute. TWO SHAPES: (a) flat — one operation on one object, max 200 rows, ' +
        'all-or-none; (b) a PLAN — 2–25 ordered steps, one record each, where a later step ' +
        'references an earlier INSERT step\'s created id with the whole-value token ' +
        '"@{ref.id}" (in field values, or as the id of an update/delete). Use a plan to seed ' +
        'linked test data in ONE approval: e.g. insert Account (ref "acct") → insert Contact ' +
        '{AccountId: "@{acct.id}"} → … → update "@{opp.id}". The org resolves the tokens ' +
        'server-side. all_or_none (default true) rolls the whole plan back on any failure; ' +
        'false keeps successful steps and fails only dependents — the approval page states ' +
        'which mode the human is approving.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        operation: z
          .enum(['insert', 'update', 'delete'])
          .optional()
          .describe('Flat shape only. Omit when sending steps.'),
        object: z
          .string()
          .optional()
          .describe('Flat shape only: SObject API name, e.g. Account or Invoice__c.'),
        records: z
          .array(z.record(z.unknown()))
          .max(200)
          .optional()
          .describe('Flat insert/update: field maps (update rows must include Id).'),
        ids: z
          .array(z.string())
          .max(200)
          .optional()
          .describe('Flat delete: record ids.'),
        steps: z
          .array(
            z.object({
              ref: z
                .string()
                .max(40)
                .optional()
                .describe('Handle for this step\'s created id; letters/digits/_, must start with a letter.'),
              operation: z.enum(['insert', 'update', 'delete']),
              object: z.string(),
              record: z
                .record(z.unknown())
                .optional()
                .describe('insert/update: the field map. Never include Id — the target goes in `id`.'),
              id: z
                .string()
                .optional()
                .describe('update/delete: a literal record id or "@{ref.id}".'),
            }),
          )
          .min(2)
          .max(25)
          .optional()
          .describe('Plan shape: ordered steps, one record each. Mutually exclusive with operation/object.'),
        all_or_none: z
          .boolean()
          .optional()
          .describe('Plan shape: default true (atomic). false = keep successes, fail dependents.'),
      },
    },
    async (args: {
      connection: string;
      operation?: 'insert' | 'update' | 'delete';
      object?: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
      steps?: Array<{
        ref?: string;
        operation: 'insert' | 'update' | 'delete';
        object: string;
        record?: Record<string, unknown>;
        id?: string;
      }>;
      all_or_none?: boolean;
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'dml_propose');

        if (args.steps) {
          const bad = validateDmlPlan(args);
          if (bad) return fail(bad);
          const preview = await deploys.proposeDml(conn, {
            plan: true,
            version: 2,
            all_or_none: args.all_or_none ?? true,
            steps: args.steps,
          });
          return ok(
            preview,
            `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
          );
        }

        if (args.all_or_none !== undefined) {
          return fail('all_or_none applies only to plans (steps) — the flat shape is always all-or-none.');
        }
        if (!args.operation || !args.object) {
          return fail('Provide either steps (a plan) or operation + object (flat).');
        }
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (/__mdt$/i.test(args.object)) {
          return fail(
            `${args.object} is a custom metadata type — its records are METADATA, not ` +
              `data, and the REST API cannot write them. Deploy the record instead: ` +
              `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
              `(type name without __mdt).`,
          );
        }
        if (args.operation === 'delete') {
          if (!args.ids?.length) return fail('delete requires ids.');
          if (args.ids.some((i) => !ID_RE.test(i))) return fail('invalid record id in ids.');
        } else {
          if (!args.records?.length) return fail(`${args.operation} requires records.`);
          for (const r of args.records) {
            for (const key of Object.keys(r)) {
              if (!/^[A-Za-z0-9_]+$/.test(key)) return fail(`invalid field name "${key}"`);
            }
            for (const v of Object.values(r)) {
              if (typeof v === 'string' && /@\{/.test(v)) {
                return fail('reference tokens ("@{ref.id}") are only valid inside a plan (steps).');
              }
            }
            if (args.operation === 'update' && !ID_RE.test(String(r.Id ?? r.id ?? ''))) {
              return fail('every update record needs a valid Id.');
            }
          }
        }
        const preview = await deploys.proposeDml(conn, {
          operation: args.operation,
          object: args.object,
          records: args.records,
          ids: args.ids,
        });
        return ok(
          preview,
          `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
        );
      }),
  );

  server.registerTool(
    'dml_execute',
    {
      title: 'Execute a proposed data change',
      description:
        'Execute the DML that the given confirmation code approves. The code exists only on ' +
        'the human\'s approval page — only pass a code the human just gave you. Single-use, ' +
        '~1h expiry, invalidated by a new proposal on the same connection.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        confirmation_code: z
          .string()
          .describe('The code the human read from the approval page (format XXXX-XXXX).'),
      },
    },
    async (args: { connection: string; confirmation_code: string }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'dml_execute');
        const result = await deploys.executeDml(conn, args.confirmation_code);
        return ok(result);
      }),
  );
}

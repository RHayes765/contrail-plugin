import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, fail, guarded } from './register.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
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

export function registerDeployTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, deploys } = deps;

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
        'An in-progress result means call validate_deploy again to check on it.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id) — name it unmissably to the human.'),
        components: z
          .array(
            z.object({
              type: z
                .string()
                .describe(
                  'ApexClass, ApexTrigger, Flow, CustomObject, PermissionSet, or child types ' +
                    'CustomField / ValidationRule / CustomLabel.',
                ),
              api_name: z.string().describe('Full API name; children dotted (Account.MyField__c).'),
              content: z
                .string()
                .describe(
                  'Full source for file types; for child types, the XML block exactly as ' +
                    'retrieve_metadata returns it (e.g. <fields>…</fields>).',
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
      components?: Array<{ type: string; api_name: string; content: string }>;
      destructive?: Array<{ type: string; api_name: string }>;
      test_level?: TestLevel;
      run_tests?: string[];
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'validate_deploy');
        const components = args.components ?? [];
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
        'Stage an insert, update, or delete with a before/after preview. Nothing touches the ' +
        'org until the human reads the confirmation code from the approval page and you pass ' +
        'it to dml_execute. All-or-none semantics; max 200 rows.',
      inputSchema: {
        connection: z.string().describe('Target connection alias (or id).'),
        operation: z.enum(['insert', 'update', 'delete']),
        object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
        records: z
          .array(z.record(z.unknown()))
          .max(200)
          .optional()
          .describe('For insert/update: field maps (update rows must include Id).'),
        ids: z
          .array(z.string())
          .max(200)
          .optional()
          .describe('For delete: record ids.'),
      },
    },
    async (args: {
      connection: string;
      operation: 'insert' | 'update' | 'delete';
      object: string;
      records?: Array<Record<string, unknown>>;
      ids?: string[];
    }) =>
      guarded(async () => {
        const conn = requireConnection(args.connection, 'dml_propose');
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (args.operation === 'delete') {
          if (!args.ids?.length) return fail('delete requires ids.');
          if (args.ids.some((i) => !ID_RE.test(i))) return fail('invalid record id in ids.');
        } else {
          if (!args.records?.length) return fail(`${args.operation} requires records.`);
          for (const r of args.records) {
            for (const key of Object.keys(r)) {
              if (!/^[A-Za-z0-9_]+$/.test(key)) return fail(`invalid field name "${key}"`);
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

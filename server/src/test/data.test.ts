import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';

let tmp: string;
let db: ContrailDb;
let client: Client;
let flowInterviewStatusSupported = true;
let apexTestsDone = true;
let apexTestsAborted = false;
let apexHugeRun = false;

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://data.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    const q = decodeURIComponent(url);
    if (url.includes('/tooling/runTestsAsynchronous')) {
      return new Response(JSON.stringify('707000000000001AAA'));
    }
    if (url.includes('/tooling/query')) {
      if (q.includes('FROM ApexLog')) {
        return new Response(
          JSON.stringify({
            totalSize: 2,
            done: true,
            records: [
              {
                attributes: { type: 'ApexLog', url: 'x' },
                Id: '07L000000000001AAA',
                LogUser: { attributes: { type: 'Name', url: 'y' }, Name: 'Ryley' },
                Operation: 'ApexTestHandler',
                Status: 'Success',
                LogLength: 1234,
                StartTime: '2026-08-06T10:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (q.includes('FROM ApexTestQueueItem')) {
        const status = apexTestsAborted ? 'Aborted' : apexTestsDone ? 'Completed' : 'Processing';
        return new Response(
          JSON.stringify({
            totalSize: 2,
            done: true,
            records: [
              { Status: status, ApexClassId: '01p000000000001AAA' },
              { Status: 'Completed', ApexClassId: '01p000000000003AAA' },
            ],
          }),
        );
      }
      if (q.includes('FROM ApexTestResult')) {
        if (apexTestsAborted) {
          return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
        }
        if (apexHugeRun) {
          const records = Array.from({ length: 2001 }, (_, i) => ({
            Outcome: 'Pass',
            MethodName: `method_${String(i).padStart(4, '0')}`,
            Message: null,
            StackTrace: null,
            RunTime: 5,
            ApexClass: { Name: 'HugeSuiteTest' },
          }));
          return new Response(JSON.stringify({ totalSize: records.length, done: true, records }));
        }
        return new Response(
          JSON.stringify({
            totalSize: 3,
            done: true,
            records: [
              {
                Outcome: 'Pass',
                MethodName: 'creates_invoice',
                Message: null,
                StackTrace: null,
                RunTime: 120,
                ApexClass: { Name: 'InvoiceServiceTest' },
              },
              {
                Outcome: 'Pass',
                MethodName: 'rejects_negative_amount',
                Message: null,
                StackTrace: null,
                RunTime: 80,
                ApexClass: { Name: 'InvoiceServiceTest' },
              },
              {
                Outcome: 'Fail',
                MethodName: 'sends_reminder',
                Message: 'System.AssertException: Assertion Failed',
                StackTrace: 'Class.InvoiceServiceTest.sends_reminder: line 42',
                RunTime: 95,
                ApexClass: { Name: 'InvoiceServiceTest' },
              },
            ],
          }),
        );
      }
      if (q.includes('FROM ApexCodeCoverageAggregate')) {
        return new Response(
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [
              {
                NumLinesCovered: 90,
                NumLinesUncovered: 10,
                ApexClassOrTrigger: { Name: 'InvoiceService' },
              },
            ],
          }),
        );
      }
      if (q.includes('FROM ApexCodeCoverage')) {
        return new Response(
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [{ ApexClassOrTriggerId: '01p000000000002AAA' }],
          }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (url.includes('/tooling/sobjects/ApexLog/') && url.endsWith('/Body')) {
      return new Response('LOG LINE 1\nLOG LINE 2\nEXCEPTION: something broke');
    }
    if (url.includes('/query?q=')) {
      if (q.includes('FROM FlowInterview')) {
        if (q.includes('InterviewStatus') && !flowInterviewStatusSupported) {
          return new Response(
            JSON.stringify([{ message: "No such column 'InterviewStatus'", errorCode: 'INVALID_FIELD' }]),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [
              {
                attributes: { type: 'FlowInterview', url: 'x' },
                Id: '0Fo000000000001AAA',
                InterviewLabel: 'Send Invoice 2026-08-06',
                CurrentElement: 'Get_Invoice',
                CreatedDate: '2026-08-06T09:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (q.includes('FROM FlowDefinitionView')) {
        if (q.includes("ApiName = 'platform_flow'")) {
          return new Response(
            JSON.stringify({
              totalSize: 1,
              done: true,
              records: [
                {
                  attributes: { type: 'FlowDefinitionView', url: 'x' },
                  ApiName: 'platform_flow',
                  Label: 'Platform Flow',
                  ProcessType: 'Flow',
                  TriggerType: null,
                  IsActive: true,
                  NamespacePrefix: 'std_feature',
                  Description: null,
                  ActiveVersionId: 'std_feature__platform_flow-1',
                },
              ],
            }),
          );
        }
        return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
      }
      if (q.includes('COUNT()')) {
        return new Response(JSON.stringify({ totalSize: 42, done: true, records: [] }));
      }
      if (q.includes('FROM Account')) {
        return new Response(
          JSON.stringify({
            totalSize: 5000,
            done: true,
            records: [
              {
                attributes: { type: 'Account', url: 'x' },
                Id: '001000000000001AAA',
                Name: 'Acme',
              },
              {
                attributes: { type: 'Account', url: 'x' },
                Id: '001000000000002AAA',
                Name: 'Globex',
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (/\/sobjects\/Account\/001[a-zA-Z0-9]+/.test(url)) {
      return new Response(
        JSON.stringify({
          attributes: { type: 'Account', url: 'x' },
          Id: '001000000000001AAA',
          Name: 'Acme',
          AnnualRevenue: 1000000,
        }),
      );
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-data-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.data_read = true;
  grants.diagnostics_read = true;
  grants.metadata_read = true;
  const conn = db.insertConnection({
    alias: 'data-org',
    instanceUrl: 'https://data.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Data Org',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  // data_read only — for the dual-grant boundary tests
  const dataOnly = emptyGrantSet();
  dataOnly.data_read = true;
  db.insertConnection({
    alias: 'data-only',
    instanceUrl: 'https://dataonly.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D3',
    orgName: 'Data Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: dataOnly,
  });
  // a second connection with NO grants for refusal tests
  db.insertConnection({
    alias: 'locked',
    instanceUrl: 'https://locked.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Locked',
    orgType: 'production',
    isSandbox: false,
    username: null,
    userId: null,
    grants: emptyGrantSet(),
  });
  stubSalesforce();

  const deps = createDeps({
    db,
    tokens,
    config: { ...DEFAULT_CONFIG },
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not used');
      },
      fetchOrgInfo: async () => {
        throw new Error('not used');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => {},
    },
  });
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  flowInterviewStatusSupported = true;
  apexTestsDone = true;
  apexTestsAborted = false;
  apexHugeRun = false;
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('soql_query', () => {
  it('returns rows with the org-side total, attributes stripped', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'data-org', query: 'SELECT Id, Name FROM Account' },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.total_size).toBe(5000);
    expect(parsed.returned).toBe(2);
    expect(parsed.truncated).toBe(true);
    expect(JSON.stringify(parsed.records)).not.toContain('attributes');
  });

  it('rejects non-SELECT statements', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'data-org', query: 'DELETE FROM Account WHERE Id != null' },
    });
    expect(result.isError).toBe(true);
  });

  it('refuses metadata-bearing sObjects without metadata_read (dual-grant boundary)', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'data-only', query: 'SELECT Id, Body FROM ApexClass' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_read');
    const refusal = db
      .queryAuditEvents({})
      .find((e) => e.eventType === 'grant.refused' && e.tool === 'soql_query');
    expect(refusal?.detail).toMatchObject({ required: 'metadata_read', sobject: 'ApexClass' });
  });

  it('does not let a string literal hide a gated FROM target', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: {
        connection: 'data-only',
        query: "SELECT Id FROM ApexLog WHERE Operation != 'FROM Account'",
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('diagnostics_read');
  });

  it('reports COUNT() results via total_size without a bogus truncated flag', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'data-org', query: 'SELECT COUNT() FROM Contact' },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.total_size).toBe(42);
    expect(parsed.truncated).toBe(false);
    expect(String(parsed.note)).toContain('Aggregate');
  });

  it('refuses without data_read and audits the refusal', async () => {
    const result = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'locked', query: 'SELECT Id FROM Account' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('data_read');
    expect(
      db.queryAuditEvents({}).some((e) => e.eventType === 'grant.refused' && e.tool === 'soql_query'),
    ).toBe(true);
  });
});

describe('get_record', () => {
  it('fetches one record and strips attributes', async () => {
    const result = await client.callTool({
      name: 'get_record',
      arguments: { connection: 'data-org', object: 'Account', id: '001000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(result)) as { record: Record<string, unknown> };
    expect(parsed.record.Name).toBe('Acme');
    expect(parsed.record.attributes).toBeUndefined();
  });

  it('rejects malformed ids', async () => {
    const result = await client.callTool({
      name: 'get_record',
      arguments: { connection: 'data-org', object: 'Account', id: 'not-an-id' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('get_debug_logs', () => {
  it('lists recent logs', async () => {
    const result = await client.callTool({
      name: 'get_debug_logs',
      arguments: { connection: 'data-org' },
    });
    const parsed = JSON.parse(textOf(result)) as { logs: Array<Record<string, unknown>> };
    expect(parsed.logs[0]).toMatchObject({ Operation: 'ApexTestHandler' });
  });

  it('fetches a log body by id', async () => {
    const result = await client.callTool({
      name: 'get_debug_logs',
      arguments: { connection: 'data-org', log_id: '07L000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(result)) as { body: string };
    expect(parsed.body).toContain('EXCEPTION: something broke');
  });
});

describe('run_apex_tests', () => {
  it('submits and returns a pollable run id with the rollback note', async () => {
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', class_names: ['InvoiceServiceTest'] },
    });
    const parsed = JSON.parse(textOf(result)) as { test_run_id: string; status: string; note: string };
    expect(parsed.test_run_id).toBe('707000000000001AAA');
    expect(parsed.status).toBe('Queued');
    expect(parsed.note).toContain('no DML');
  });

  it('demands exactly one of class_names, tests, test_run_id', async () => {
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: {
        connection: 'data-org',
        class_names: ['A'],
        test_run_id: '707000000000001AAA',
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exactly one');
  });

  it('reports in-progress while the queue is still running', async () => {
    apexTestsDone = false;
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', test_run_id: '707000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(result)) as { status: string; queue: Record<string, number> };
    expect(parsed.status).toBe('InProgress');
    expect(parsed.queue.Processing).toBe(1);
  });

  it('returns outcomes, failure detail, and per-class coverage when complete', async () => {
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', test_run_id: '707000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      status: string;
      totals: { run: number; passed: number; failed: number; skipped: number };
      failures: Array<{ method: string; message: string; stack_trace: string }>;
      by_class: Record<string, { passed: number; failed: number }>;
      coverage: Array<{ class: string; percent: number }>;
    };
    expect(parsed.status).toBe('Completed');
    expect(parsed.totals).toMatchObject({ run: 3, passed: 2, failed: 1, skipped: 0 });
    expect(parsed.failures[0]).toMatchObject({
      method: 'sends_reminder',
      message: 'System.AssertException: Assertion Failed',
    });
    expect(parsed.failures[0]!.stack_trace).toContain('line 42');
    expect(parsed.by_class.InvoiceServiceTest).toMatchObject({ passed: 2, failed: 1 });
    expect(parsed.coverage[0]).toMatchObject({ class: 'InvoiceService', percent: 90 });
  });

  it('rejects malformed class and method names before any org call', async () => {
    const bad = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', class_names: ["Bad'Name"] },
    });
    expect(bad.isError).toBe(true);
    const badMethod = await client.callTool({
      name: 'run_apex_tests',
      arguments: {
        connection: 'data-org',
        tests: [{ class_name: 'Fine', methods: ["als'o bad"] }],
      },
    });
    expect(badMethod.isError).toBe(true);
  });

  it('an aborted run is NEVER reported as a pass', async () => {
    apexTestsAborted = true;
    const result = client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', test_run_id: '707000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(await result)) as {
      status: string;
      totals: { run: number };
      queue: Record<string, number>;
      note: string;
    };
    expect(parsed.status).toBe('Aborted');
    expect(parsed.totals.run).toBe(0);
    expect(parsed.queue.Aborted).toBe(1);
    expect(parsed.note).toContain('Do NOT read the totals as a pass');
  });

  it('a run larger than the result cap is flagged PARTIAL, never quoted as complete', async () => {
    apexHugeRun = true;
    const result = client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', test_run_id: '707000000000001AAA' },
    });
    const parsed = JSON.parse(textOf(await result)) as {
      totals: { run: number };
      results_truncated?: boolean;
      results_note?: string;
    };
    expect(parsed.results_truncated).toBe(true);
    expect(parsed.totals.run).toBe(2000);
    expect(parsed.results_note).toContain('PARTIAL');
  });

  it('an empty test_run_id is rejected at the schema, not crashed on', async () => {
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-org', test_run_id: '' },
    });
    expect(result.isError).toBe(true);
  });

  it('is gated on diagnostics_read', async () => {
    const result = await client.callTool({
      name: 'run_apex_tests',
      arguments: { connection: 'data-only', class_names: ['InvoiceServiceTest'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('diagnostics_read');
  });
});

describe('retrieve_metadata flow fallback chain', () => {
  it('falls back to the FlowDefinitionView descriptor for platform-delivered flows', async () => {
    const result = await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        connection: 'data-org',
        type: 'Flow',
        names: ['platform_flow'],
        include_dependencies: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      artifacts: Array<{ source?: string; note?: string; content?: string; error?: string }>;
    };
    expect(parsed.artifacts[0]!.source).toBe('flow_definition_view');
    expect(parsed.artifacts[0]!.note).toContain('platform/feature-delivered');
    expect(parsed.artifacts[0]!.content).toContain('Platform Flow');
  });

  it('reports a clean not-found when no source knows the flow', async () => {
    const result = await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        connection: 'data-org',
        type: 'Flow',
        names: ['does_not_exist'],
        include_dependencies: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { artifacts: Array<{ error?: string }> };
    expect(parsed.artifacts[0]!.error).toContain('FlowDefinitionView');
  });
});

describe('get_flow_errors', () => {
  it('lists persisted interviews with the status field when available', async () => {
    const result = await client.callTool({
      name: 'get_flow_errors',
      arguments: { connection: 'data-org' },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status_field_available).toBe(true);
    expect((parsed.interviews as unknown[]).length).toBe(1);
  });

  it('falls back gracefully when InterviewStatus is not queryable', async () => {
    flowInterviewStatusSupported = false;
    const result = await client.callTool({
      name: 'get_flow_errors',
      arguments: { connection: 'data-org' },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status_field_available).toBe(false);
    expect((parsed.interviews as unknown[]).length).toBe(1);
  });
});

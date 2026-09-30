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

/**
 * S35: run_agent_eval — Testing Center evaluation runs on the documented
 * org-host Connect API, run_apex_tests-shaped (stateless handle polling).
 * The pins that matter: the dual-grant MODE SPLIT (submit needs data_write
 * on top of diagnostics_read; polling needs only diagnostics_read), honest
 * ERROR/TERMINATED handling, and pass-field tolerance for BOTH observed
 * schemas (docs metricScore vs library result+score) with null — never a
 * fabricated verdict — for anything else.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;

let submitPosts: Array<Record<string, unknown>>;
let submitResponse: Record<string, unknown>;
let runStatus: Record<string, unknown>;
let runResults: Record<string, unknown>;
let resultsGets: number;

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://eval.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.endsWith('/einstein/ai-evaluations/runs') && method === 'POST') {
      submitPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify(submitResponse));
    }
    if (/\/einstein\/ai-evaluations\/runs\/[a-zA-Z0-9]+\/results$/.test(url)) {
      resultsGets += 1;
      return new Response(JSON.stringify(runResults));
    }
    if (/\/einstein\/ai-evaluations\/runs\/[a-zA-Z0-9]+$/.test(url)) {
      return new Response(JSON.stringify(runStatus));
    }
    return new Response('not found', { status: 404 });
  });
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

const RUN_ID = '4KB000000000001AAA';

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-eval-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  submitPosts = [];
  submitResponse = { runId: RUN_ID, status: 'NEW' };
  runStatus = { status: 'IN_PROGRESS', startTime: '2026-10-01T00:00:00Z' };
  runResults = {};
  resultsGets = 0;

  const tokens = new MemoryTokenStore();
  const full = emptyGrantSet();
  full.diagnostics_read = true;
  full.data_read = true;
  full.data_write = true;
  const conn = db.insertConnection({
    alias: 'eval-org',
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Eval Org',
    orgType: 'developer',
    isSandbox: false,
    username: 'dev@eval.example',
    userId: null,
    grants: full,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  // diagnostics_read WITHOUT data_write — the mode-split connection.
  const diagOnly = emptyGrantSet();
  diagOnly.diagnostics_read = true;
  const ro = db.insertConnection({
    alias: 'diag-only',
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Diag Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: diagOnly,
  });
  tokens.setRefreshToken(ro.id, 'RT');

  // No diagnostics_read at all.
  const none = emptyGrantSet();
  none.data_read = true;
  none.data_write = true;
  const noDiag = db.insertConnection({
    alias: 'no-diag',
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D3',
    orgName: 'No Diag',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: none,
  });
  tokens.setRefreshToken(noDiag.id, 'RT');

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
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>, connection = 'eval-org') {
  return client.callTool({ name: 'run_agent_eval', arguments: { connection, ...args } });
}

describe('run_agent_eval', () => {
  it('submits by definition name with the honest real-actions note', async () => {
    const res = await call({ eval: 'Order_Agent_Smoke' });
    expect(res.isError ?? false).toBe(false);
    expect(submitPosts).toEqual([{ aiEvaluationDefinitionName: 'Order_Agent_Smoke' }]);
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.run_id).toBe(RUN_ID);
    expect(String(parsed.note)).toContain('REAL actions');
    expect(String(parsed.note)).toContain('no rollback');
  });

  it('requires exactly one of eval or run_id', async () => {
    expect((await call({})).isError).toBe(true);
    expect((await call({ eval: 'X', run_id: RUN_ID })).isError).toBe(true);
  });

  it('polls in-progress without touching results; unrecognized statuses fail open', async () => {
    const res = await call({ run_id: RUN_ID });
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.status).toBe('IN_PROGRESS');
    expect(resultsGets).toBe(0);

    runStatus = { status: 'SOMETHING_NOVEL' };
    const odd = await call({ run_id: RUN_ID });
    expect(JSON.parse(textOf(odd)).status).toBe('SOMETHING_NOVEL');
    expect(resultsGets).toBe(0);
  });

  it('maps BOTH pass-field schemas identically, and labels — never invents — verdicts', async () => {
    runStatus = { status: 'COMPLETED', startTime: 't0', endTime: 't1' };
    const caseWith = (row: Record<string, unknown>) => ({
      status: 'PASSED',
      testNumber: 1,
      inputs: { utterance: 'Where is my order?' },
      generatedData: { topic: 'Order_Management', actionsSequence: ['Get_Order'], outcome: 'ok' },
      testResults: [row],
    });

    // Docs schema: metricScore PASS|FAILED.
    runResults = {
      subjectName: 'Order_Agent',
      testCases: [caseWith({ name: 'topic_sequence_match', metricScore: 'FAILED' })],
    };
    let parsed = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as {
      cases: Array<{ topic: string; expectations: Array<{ passed: boolean | null }> }>;
      totals: Record<string, number>;
    };
    expect(parsed.cases[0]!.expectations[0]!.passed).toBe(false);
    expect(parsed.cases[0]!.topic).toBe('Order_Management');

    // Library schema: result PASS|FAILURE + numeric score.
    runResults = {
      subjectName: 'Order_Agent',
      testCases: [caseWith({ name: 'topic_sequence_match', result: 'PASS', score: 1 })],
    };
    parsed = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as typeof parsed;
    expect(parsed.cases[0]!.expectations[0]!.passed).toBe(true);

    // instruction_adherence emits labels, not verdicts: passed stays null.
    runResults = {
      testCases: [caseWith({ name: 'instruction_adherence', metricScore: 'HIGH' })],
    };
    const labeled = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as {
      cases: Array<{ expectations: Array<{ passed: boolean | null; metric_label: unknown }> }>;
    };
    expect(labeled.cases[0]!.expectations[0]!.passed).toBeNull();
    expect(labeled.cases[0]!.expectations[0]!.metric_label).toBe('HIGH');
  });

  it('an ERROR run is the run failing, never a test verdict; TERMINATED is not a pass', async () => {
    runStatus = { status: 'ERROR', errorMessage: 'No active agent version.' };
    const err = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as Record<string, unknown>;
    expect(err.status).toBe('ERROR');
    expect(err.error_message).toBe('No active agent version.');
    expect(String(err.note)).toContain('not a test failure');
    expect(resultsGets).toBe(0);

    runStatus = { status: 'TERMINATED' };
    runResults = { testCases: [] };
    const term = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as Record<string, unknown>;
    expect(term.status).toBe('TERMINATED');
    expect(String(term.note)).toContain('NOT a pass');
  });

  it('THE MODE SPLIT: diagnostics-only can poll but not start; starting is audited when refused', async () => {
    const poll = await call({ run_id: RUN_ID }, 'diag-only');
    expect(poll.isError ?? false).toBe(false);

    const start = await call({ eval: 'Order_Agent_Smoke' }, 'diag-only');
    expect(start.isError).toBe(true);
    expect(textOf(start)).toContain('data_write');
    expect(textOf(start)).toContain('REAL actions');
    expect(submitPosts).toHaveLength(0);
    const audits = db.queryAuditEvents({ limit: 20 });
    expect(
      audits.some(
        (a) =>
          a.eventType === 'grant.refused' &&
          JSON.stringify(a.detail ?? {}).includes('agent_eval_start'),
      ),
    ).toBe(true);
  });

  it('no diagnostics_read refuses everything up front, audited', async () => {
    const res = await call({ run_id: RUN_ID }, 'no-diag');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('diagnostics_read');
    const audits = db.queryAuditEvents({ limit: 10 });
    expect(
      audits.some(
        (a) => a.eventType === 'grant.refused' && a.tool === 'run_agent_eval',
      ),
    ).toBe(true);
  });

  it('org refusals relay verbatim: unknown definition and the concurrent-run cap', async () => {
    submitResponse = {}; // unused — the stub below overrides per-status
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            instance_url: 'https://eval.stub.salesforce.com',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.endsWith('/einstein/ai-evaluations/runs') && (init?.method ?? 'GET') === 'POST') {
        const body = String(init?.body ?? '');
        if (body.includes('No_Such_Def')) {
          return new Response(
            JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'AiEvaluationDefinition No_Such_Def not found' }]),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify([{ errorCode: 'LIMIT_EXCEEDED', message: 'Too many evaluation runs in progress' }]),
          { status: 409 },
        );
      }
      return new Response('not found', { status: 404 });
    });
    const missing = await call({ eval: 'No_Such_Def' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No_Such_Def not found');
    const capped = await call({ eval: 'Order_Agent_Smoke' });
    expect(capped.isError).toBe(true);
    expect(textOf(capped)).toContain('Too many evaluation runs in progress');
  });

  it('oversized result sets truncate with an honest dropped-count note', async () => {
    runStatus = { status: 'COMPLETED' };
    runResults = {
      testCases: Array.from({ length: 200 }, (_, i) => ({
        status: 'PASSED',
        testNumber: i + 1,
        inputs: { utterance: 'x'.repeat(1500) },
        generatedData: { topic: 'T', actionsSequence: [] },
        testResults: [],
      })),
    };
    const parsed = JSON.parse(textOf(await call({ run_id: RUN_ID }))) as {
      totals: { cases: number };
      cases: unknown[];
      cases_truncated?: boolean;
      cases_note?: string;
    };
    expect(parsed.totals.cases).toBe(200);
    expect(parsed.cases_truncated).toBe(true);
    expect(parsed.cases.length).toBeLessThan(200);
    expect(parsed.cases_note).toMatch(/Dropped \d+ case/);
  });

  it('a successful submit is audited with definition and run id', async () => {
    await call({ eval: 'Order_Agent_Smoke' });
    const audits = db.queryAuditEvents({ limit: 20 });
    expect(
      audits.some(
        (a) =>
          a.eventType === 'agent_eval.started' &&
          JSON.stringify(a.detail ?? {}).includes('Order_Agent_Smoke') &&
          JSON.stringify(a.detail ?? {}).includes(RUN_ID),
      ),
    ).toBe(true);
  });

  it('include_details passes the raw testCases through', async () => {
    runStatus = { status: 'COMPLETED' };
    runResults = { testCases: [{ testNumber: 7, testResults: [] }] };
    const parsed = JSON.parse(
      textOf(await call({ run_id: RUN_ID, include_details: true })),
    ) as Record<string, unknown>;
    expect(JSON.stringify(parsed.raw_test_cases)).toContain('"testNumber":7');
  });
});

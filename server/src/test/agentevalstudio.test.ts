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
 * S44: run_agent_eval learns the Agentforce Studio runner (AiTestingDefinition,
 * einstein/ai-testing/runs — a Salesforce BETA absent from the Connect REST
 * reference). The pins that matter: run-id prefix routing (4KB / 3A2); a
 * bare eval is routed by ONE live listMetadata probe that needs metadata_read
 * and REFUSES on ambiguity, on "neither", and on a failed lookup — a
 * REAL-actions submit is never sent to a guessed runner; the org's exact-case
 * name is what gets submitted; the MODE SPLIT (data_write) still runs before
 * any lookup; and Studio pass/fail derives ONLY from explicit verdict fields
 * (never a `status` execution marker) — null, never a fabricated verdict, for
 * everything else. The scorerResponse JSON shape is unverified until a live
 * run, so the fixture exercises the derivation rules, not an org's real rows.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;

// SOAP listMetadata (the runner probe).
let soapCalls: number;
let soapMode: 'ok' | 'http500' | 'invalidStudioType';
let orgInventory: Array<{ type: string; fullName: string }>;

// Testing Center (legacy) routes.
let submitPosts: Array<Record<string, unknown>>;
let submitResponse: Record<string, unknown>;
let legacySubmitHttp: number;
let legacySubmitBody: unknown;
let runStatus: Record<string, unknown>;
let runResults: Record<string, unknown>;
let resultsGets: number;

// Agentforce Studio routes.
let studioSubmitPosts: Array<Record<string, unknown>>;
let studioSubmitResponse: Record<string, unknown>;
let studioStatus: Record<string, unknown>;
let studioResults: Record<string, unknown>;
let studioResultsHttp: number;
let studioResultsGets: number;

const RUN_ID_STUDIO = '3A2000000000001AAA';
const RUN_ID_LEGACY = '4KB000000000001AAA';

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function listResult(i: { type: string; fullName: string }): string {
  return (
    `<result><fullName>${i.fullName}</fullName><type>${i.type}</type>` +
    `<fileName>x</fileName><id>1</id></result>`
  );
}

function soapListMetadata(init?: RequestInit): Response {
  soapCalls += 1;
  const body = String(init?.body ?? '');
  if (soapMode === 'http500') return new Response('boom', { status: 500 });
  if (!body.includes('<met:listMetadata>')) {
    return new Response('unexpected SOAP body', { status: 500 });
  }
  // Honour the per-call type queries — listMetadata chunks by 3, and the
  // INVALID_TYPE degrade retries each query alone.
  const requested = new Set(
    [...body.matchAll(/<met:type>([^<]+)<\/met:type>/g)].map((m) => m[1]!),
  );
  if (soapMode === 'invalidStudioType' && requested.has('AiTestingDefinition')) {
    return new Response(
      soapEnvelope(
        `<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode>
         <faultstring>INVALID_TYPE: Cannot use: AiTestingDefinition in this version</faultstring></soapenv:Fault>`,
      ),
      { status: 500 },
    );
  }
  const items = orgInventory.filter((i) => requested.has(i.type));
  return new Response(
    soapEnvelope(
      `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
         ${items.map(listResult).join('\n')}
       </listMetadataResponse>`,
    ),
  );
}

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
    if (url.includes('/services/Soap/m/')) return soapListMetadata(init);

    // Agentforce Studio runner.
    if (url.endsWith('/einstein/ai-testing/runs') && method === 'POST') {
      studioSubmitPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify(studioSubmitResponse));
    }
    if (/\/einstein\/ai-testing\/runs\/[a-zA-Z0-9]+\/results$/.test(url)) {
      studioResultsGets += 1;
      return studioResultsHttp === 200
        ? new Response(JSON.stringify(studioResults))
        : new Response(
            JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'no results for this run' }]),
            { status: studioResultsHttp },
          );
    }
    if (/\/einstein\/ai-testing\/runs\/[a-zA-Z0-9]+$/.test(url)) {
      return new Response(JSON.stringify(studioStatus));
    }

    // Testing Center runner — exactly as agenteval.test.ts, plus the
    // status/body knobs so org refusals need no inline re-stub.
    if (url.endsWith('/einstein/ai-evaluations/runs') && method === 'POST') {
      submitPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return legacySubmitHttp === 200
        ? new Response(JSON.stringify(submitResponse))
        : new Response(JSON.stringify(legacySubmitBody), { status: legacySubmitHttp });
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

function insertConnection(
  alias: string,
  orgId: string,
  grants: ReturnType<typeof emptyGrantSet>,
  tokens: MemoryTokenStore,
): void {
  const conn = db.insertConnection({
    alias,
    instanceUrl: 'https://eval.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId,
    orgName: alias,
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
}

/**
 * The derivation fixture. Every row documents the rule it exercises; the
 * shape is the library's (scorerResponse as a JSON string), NOT a captured
 * org payload — that arrives with the Stage-0 live run.
 */
const STUDIO_RESULTS = {
  status: 'SUCCESS',
  testCases: [
    {
      testNumber: 1,
      subjectResponse: 'Your order shipped.',
      testScorerResults: [
        // An explicit verdict key wins.
        {
          scorerName: 'topic_sequence_match',
          scorerResponse: JSON.stringify({
            result: 'PASS',
            actualValue: 'Order_Management',
            expectedValue: 'Order_Management',
            explanation: 'Routed to the expected topic.',
          }),
        },
        // PASS_FAIL catalog scorer with no verdict key: actual === expected → true.
        {
          scorerName: 'action_sequence_match',
          scorerResponse: JSON.stringify({ actualValue: "['Get_Order']", expectedValue: "['Get_Order']" }),
        },
        // Quality scorer: a score is telemetry, not a verdict → null.
        { scorerName: 'coherence', scorerResponse: JSON.stringify({ score: 87 }) },
        // Not JSON at all → the raw string is kept, passed null.
        { scorerName: 'bot_response_rating', scorerResponse: 'not json at all' },
      ],
    },
    {
      testNumber: 2,
      subjectResponse: 'x',
      testScorerResults: [
        // PASS_FAIL mismatch → false.
        {
          scorerName: 'topic_sequence_match',
          scorerResponse: JSON.stringify({ actualValue: 'off_topic', expectedValue: 'Order_Management' }),
        },
        // actualValue/expectedValue with no verdict key is the live match-scorer shape → compared.
        {
          scorerName: 'completeness',
          scorerResponse: JSON.stringify({ actualValue: 'a', expectedValue: 'b' }),
        },
        // verdict key + the library's explainability field name.
        {
          scorerName: 'response_match',
          scorerResponse: JSON.stringify({
            verdict: 'FAIL',
            metricExplainability: 'Missing the tracking number.',
          }),
        },
      ],
    },
    {
      testNumber: 3,
      subjectResponse: 'y',
      testScorerResults: [
        { scorerName: 'topic_sequence_match', scorerResponse: JSON.stringify({ passed: true }) },
        { scorerName: 'response_match', scorerResponse: JSON.stringify({ outcome: 'PASSED' }) },
      ],
    },
    // No scorers at all is never a pass.
    { testNumber: 4, testScorerResults: [] },
    {
      testNumber: 5,
      subjectResponse: 'z',
      testScorerResults: [
        // `status` is the RUN-status vocabulary — an execution marker, not a
        // verdict (the S40 lesson). SUCCESS on a quality scorer stays null…
        {
          scorerName: 'coherence',
          scorerResponse: JSON.stringify({ status: 'SUCCESS', score: 12 }),
        },
        // …and FAILED on a PASS_FAIL scorer without actual/expected is NOT false.
        { scorerName: 'topic_sequence_match', scorerResponse: JSON.stringify({ status: 'FAILED' }) },
      ],
    },
  ],
};

const LEGACY_NOTE =
  'Submitted — the agent under test will execute its REAL actions (no rollback). ' +
  'Runs take minutes; call run_agent_eval again with this run_id to poll, sparingly.';

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-eval-studio-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));

  soapCalls = 0;
  soapMode = 'ok';
  orgInventory = [
    { type: 'AiEvaluationDefinition', fullName: 'Order_Agent_Smoke' },
    { type: 'AiTestingDefinition', fullName: 'Order_Agent_Studio' },
    { type: 'AiEvaluationDefinition', fullName: 'Shared_Name' },
    { type: 'AiTestingDefinition', fullName: 'Shared_Name' },
  ];

  submitPosts = [];
  submitResponse = { runId: RUN_ID_LEGACY, status: 'NEW' };
  legacySubmitHttp = 200;
  legacySubmitBody = null;
  runStatus = { status: 'IN_PROGRESS', startTime: '2026-10-01T00:00:00Z' };
  runResults = {};
  resultsGets = 0;

  studioSubmitPosts = [];
  studioSubmitResponse = { runId: RUN_ID_STUDIO, status: 'CREATED' };
  studioStatus = { status: 'IN_PROGRESS', startTime: 't0' };
  studioResults = STUDIO_RESULTS;
  studioResultsHttp = 200;
  studioResultsGets = 0;

  const tokens = new MemoryTokenStore();

  // The full connection — detection for a bare eval is a Metadata-API read,
  // so the tests that rely on it hold metadata_read honestly.
  const full = emptyGrantSet();
  full.diagnostics_read = true;
  full.data_read = true;
  full.data_write = true;
  full.metadata_read = true;
  insertConnection('eval-org', '00D1', full, tokens);

  // diagnostics_read WITHOUT data_write — the mode-split connection.
  const diagOnly = emptyGrantSet();
  diagOnly.diagnostics_read = true;
  insertConnection('diag-only', '00D2', diagOnly, tokens);

  // Can start runs, but has NO metadata_read — detection must not probe.
  const noMetadataRead = emptyGrantSet();
  noMetadataRead.diagnostics_read = true;
  noMetadataRead.data_read = true;
  noMetadataRead.data_write = true;
  insertConnection('no-metadata-read', '00D3', noMetadataRead, tokens);

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

function startedAudits() {
  return db
    .queryAuditEvents({ limit: 50 })
    .filter((a) => a.eventType === 'agent_eval.started')
    .map((a) => JSON.stringify(a.detail ?? {}));
}

describe('run_agent_eval — Agentforce Studio runner (S44)', () => {
  it('run_id prefix routes the poll: 3A2 → Studio, 4KB → Testing Center; other prefixes are refused naming both', async () => {
    const studio = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as Record<string, unknown>;
    expect(studio.runner).toBe('agentforce_studio');
    expect(studio.status).toBe('IN_PROGRESS');
    expect(studio.start_time).toBe('t0');
    expect(studioResultsGets).toBe(0);
    expect(resultsGets).toBe(0);

    const legacy = JSON.parse(textOf(await call({ run_id: RUN_ID_LEGACY }))) as Record<string, unknown>;
    expect(legacy.runner).toBe('testing_center');
    expect(legacy.start_time).toBe('2026-10-01T00:00:00Z');

    const odd = await call({ run_id: '000000000000001AAA' });
    expect(odd.isError).toBe(true);
    expect(textOf(odd)).toContain('4KB');
    expect(textOf(odd)).toContain('3A2');
    expect(textOf(odd)).toContain('runner');
    // No network was needed to route any of these.
    expect(soapCalls).toBe(0);
  });

  it('a bare eval held only by AiTestingDefinition is detected in ONE listMetadata call and posted as testDefinitionName', async () => {
    const res = await call({ eval: 'Order_Agent_Studio' });
    expect(res.isError ?? false).toBe(false);
    expect(soapCalls).toBe(1);
    expect(studioSubmitPosts).toEqual([{ testDefinitionName: 'Order_Agent_Studio' }]);
    expect(submitPosts).toHaveLength(0);
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.run_id).toBe(RUN_ID_STUDIO);
    expect(parsed.runner).toBe('agentforce_studio');
    expect(parsed.definition).toBe('Order_Agent_Studio');
    expect(parsed.runner_detection).toEqual({ method: 'live_lookup', unsupported_types: [] });
    expect(String(parsed.note)).toContain('BETA');
    expect(String(parsed.note)).toContain('REAL actions');
    expect(String(parsed.note)).toContain('no rollback');
  });

  it('a bare eval held only by AiEvaluationDefinition still posts aiEvaluationDefinitionName with the legacy note', async () => {
    const res = await call({ eval: 'Order_Agent_Smoke' });
    expect(res.isError ?? false).toBe(false);
    expect(soapCalls).toBe(1);
    expect(submitPosts).toEqual([{ aiEvaluationDefinitionName: 'Order_Agent_Smoke' }]);
    expect(studioSubmitPosts).toHaveLength(0);
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.runner).toBe('testing_center');
    expect(parsed.run_id).toBe(RUN_ID_LEGACY);
    expect(parsed.status).toBe('NEW');
    expect(parsed.note).toBe(LEGACY_NOTE);
  });

  it('a case-insensitive match submits the org\'s exact-case name and audits it', async () => {
    const res = await call({ eval: 'order_agent_studio' });
    expect(res.isError ?? false).toBe(false);
    expect(studioSubmitPosts).toEqual([{ testDefinitionName: 'Order_Agent_Studio' }]);
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.definition).toBe('Order_Agent_Studio');
    const started = startedAudits();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain('"definition":"Order_Agent_Studio"');
  });

  it('a name held by BOTH types is refused as ambiguous, no POST', async () => {
    const res = await call({ eval: 'Shared_Name' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('runner');
    expect(textOf(res)).toContain('testing_center');
    expect(textOf(res)).toContain('agentforce_studio');
    expect(submitPosts).toHaveLength(0);
    expect(studioSubmitPosts).toHaveLength(0);
    expect(startedAudits()).toHaveLength(0);
  });

  it('a name held by NEITHER type is refused without starting anything', async () => {
    const res = await call({ eval: 'No_Such_Def' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('either type');
    expect(textOf(res)).toContain('Nothing was started');
    expect(textOf(res)).not.toContain('does not know');
    expect(submitPosts).toHaveLength(0);
    expect(studioSubmitPosts).toHaveLength(0);
  });

  it('runner override skips detection (no SOAP) and is honoured both ways', async () => {
    const studio = await call({ eval: 'Shared_Name', runner: 'agentforce_studio' });
    expect(studio.isError ?? false).toBe(false);
    expect(soapCalls).toBe(0);
    expect(studioSubmitPosts).toEqual([{ testDefinitionName: 'Shared_Name' }]);
    expect(JSON.parse(textOf(studio)).runner_detection).toEqual({ method: 'explicit' });

    const legacy = await call({ eval: 'Shared_Name', runner: 'testing_center' });
    expect(legacy.isError ?? false).toBe(false);
    expect(soapCalls).toBe(0);
    expect(submitPosts).toEqual([{ aiEvaluationDefinitionName: 'Shared_Name' }]);
    expect(JSON.parse(textOf(legacy)).runner).toBe('testing_center');
  });

  it('a FAILED lookup refuses — never a silent default to Testing Center', async () => {
    soapMode = 'http500';
    const res = await call({ eval: 'Order_Agent_Smoke' });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('runner detection failed');
    expect(text).toContain('Metadata API HTTP 500');
    expect(text).toContain('Nothing was started');
    expect(text).toContain('runner');
    expect(submitPosts).toHaveLength(0);
    expect(studioSubmitPosts).toHaveLength(0);
    expect(startedAudits()).toHaveLength(0);
  });

  it('an org that does not know AiTestingDefinition degrades per type: 3 SOAP calls, unsupported_types reported', async () => {
    soapMode = 'invalidStudioType';
    const res = await call({ eval: 'Order_Agent_Smoke' });
    expect(res.isError ?? false).toBe(false);
    // 1 faulted chunk + 2 per-query retries (listMetadataDetailed's degrade).
    expect(soapCalls).toBe(3);
    expect(submitPosts).toEqual([{ aiEvaluationDefinitionName: 'Order_Agent_Smoke' }]);
    const parsed = JSON.parse(textOf(res)) as { runner_detection: Record<string, unknown> };
    expect(parsed.runner_detection).toEqual({
      method: 'live_lookup',
      unsupported_types: ['AiTestingDefinition'],
    });

    soapCalls = 0;
    const missing = await call({ eval: 'No_Such_Def' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('does not know: AiTestingDefinition');
    expect(soapCalls).toBe(3);
  });

  it('a bare eval WITHOUT metadata_read is refused naming both runner values, with no SOAP probe; the override still works', async () => {
    const res = await call({ eval: 'Order_Agent_Studio' }, 'no-metadata-read');
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('metadata_read');
    expect(text).toContain('runner');
    expect(text).toContain('testing_center');
    expect(text).toContain('agentforce_studio');
    expect(soapCalls).toBe(0);
    expect(submitPosts).toHaveLength(0);
    expect(studioSubmitPosts).toHaveLength(0);
    const audits = db.queryAuditEvents({ limit: 20 });
    expect(
      audits.some(
        (a) =>
          a.eventType === 'grant.refused' &&
          a.tool === 'run_agent_eval' &&
          JSON.stringify(a.detail ?? {}).includes('"required":"metadata_read"'),
      ),
    ).toBe(true);

    const forced = await call(
      { eval: 'Order_Agent_Studio', runner: 'agentforce_studio' },
      'no-metadata-read',
    );
    expect(forced.isError ?? false).toBe(false);
    expect(soapCalls).toBe(0);
    expect(studioSubmitPosts).toEqual([{ testDefinitionName: 'Order_Agent_Studio' }]);
  });

  it('org refusals on the submit still relay verbatim after a successful lookup', async () => {
    legacySubmitHttp = 404;
    legacySubmitBody = [
      { errorCode: 'NOT_FOUND', message: 'AiEvaluationDefinition Order_Agent_Smoke not found' },
    ];
    const res = await call({ eval: 'Order_Agent_Smoke' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Order_Agent_Smoke not found');
    expect(soapCalls).toBe(1);
    expect(startedAudits()).toHaveLength(0);
  });

  it('Studio submit: a 2xx without runId is reported as already-in-progress; nothing is audited as started', async () => {
    studioSubmitResponse = { status: 'IN_PROGRESS' };
    const res = await call({ eval: 'Order_Agent_Studio' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('already in progress');
    expect(textOf(res)).toContain('Nothing new was started');
    // The org-wide concurrent-run cap is a different fact — not asserted here.
    expect(textOf(res)).not.toContain('~10');
    expect(startedAudits()).toHaveLength(0);
  });

  it('Studio submit status is the org\'s raw word or null — never an invented literal', async () => {
    const raw = JSON.parse(textOf(await call({ eval: 'Order_Agent_Studio' }))) as Record<string, unknown>;
    expect(raw.status).toBe('CREATED');

    studioSubmitResponse = { runId: RUN_ID_STUDIO };
    const absent = JSON.parse(textOf(await call({ eval: 'Order_Agent_Studio' }))) as Record<string, unknown>;
    expect(absent.status).toBeNull();
  });

  it('a Studio submit is audited with definition, run id and runner', async () => {
    await call({ eval: 'Order_Agent_Studio' });
    const started = startedAudits();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain('Order_Agent_Studio');
    expect(started[0]).toContain(RUN_ID_STUDIO);
    expect(started[0]).toContain('"runner":"agentforce_studio"');

    await call({ eval: 'Order_Agent_Smoke' });
    expect(startedAudits().some((d) => d.includes('"runner":"testing_center"'))).toBe(true);
  });

  it('Studio poll: CREATED, IN_PROGRESS and novel statuses fail open as in-progress without touching results', async () => {
    for (const status of ['CREATED', 'IN_PROGRESS', 'SOMETHING_NOVEL']) {
      studioStatus = { status };
      const parsed = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as Record<string, unknown>;
      expect(parsed.status).toBe(status);
      expect(parsed.runner).toBe('agentforce_studio');
      expect(String(parsed.note)).toContain('Still running');
    }
    expect(studioResultsGets).toBe(0);
  });

  it('Studio results: pass/fail derives ONLY from explicit verdict fields; status markers and scores never count', async () => {
    studioStatus = { status: 'SUCCESS', startTime: 't0', endTime: 't1' };
    const res = await call({ run_id: RUN_ID_STUDIO });
    expect(res.isError ?? false).toBe(false);
    const parsed = JSON.parse(textOf(res)) as {
      status: string;
      totals: Record<string, number>;
      cases: Array<{
        number: number;
        verdict: string;
        subject_response: string | null;
        scorers: Array<{
          name: string | null;
          passed: boolean | null;
          score: number | null;
          explanation: string | null;
          raw: unknown;
        }>;
      }>;
      note: string;
    };
    expect(parsed.status).toBe('SUCCESS');
    expect(parsed.cases.map((c) => c.verdict)).toEqual([
      'indeterminate', // null rows alongside passes: read the rows
      'failed',
      'passed',
      'indeterminate', // no scorers at all is never a pass
      'indeterminate', // status markers are not verdicts
    ]);
    expect(parsed.totals).toEqual({ cases: 5, passed: 1, failed: 1, indeterminate: 3 });

    const c1 = parsed.cases[0]!;
    expect(c1.subject_response).toBe('Your order shipped.');
    expect(c1.scorers.map((s) => s.passed)).toEqual([true, true, null, null]);
    expect(c1.scorers[0]!.explanation).toBe('Routed to the expected topic.');
    expect(c1.scorers[2]!.score).toBe(87);
    expect(c1.scorers[3]!.raw).toBe('not json at all');
    expect(c1.scorers[3]!.explanation).toBeNull();

    const c2 = parsed.cases[1]!;
    expect(c2.scorers.map((s) => s.passed)).toEqual([false, false, false]);
    expect(c2.scorers[2]!.explanation).toBe('Missing the tracking number.');

    const c5 = parsed.cases[4]!;
    expect(c5.scorers.map((s) => s.passed)).toEqual([null, null]);
    expect(c5.scorers[0]!.score).toBe(12);
    // The raw object always rides along for the reader.
    expect(c5.scorers[1]!.raw).toEqual({ status: 'FAILED' });

    expect(parsed.note).toContain('BETA');
    expect(parsed.note).toContain('DERIVED');
  });

  it('live Studio shape (2026-11-11): HTML-encoded JSON, label names, Pass/Fail status, match actual/expected, session blob', async () => {
    const enc = (o: unknown) => JSON.stringify(o).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const blob = enc({
      sessionId: 'sess-1',
      userInput: 'give me a pizza recipe',
      agentMessage: { type: 'Inform', message: "I can only help with the company's topics." },
      agentResponse: { sessionState: { runs: [{ runId: 'r1', topicName: 'GeneralFAQ' }] } },
    });
    studioStatus = { status: 'SUCCESS' };
    studioResults = {
      status: 'SUCCESS',
      testCases: [
        {
          testNumber: 1,
          testCaseId: '1W6000000000001AAA',
          subjectResponse: blob,
          testScorerResults: [
            {
              scorerName: 'Response Evaluation',
              scorerResponse: enc({
                status: 'Pass',
                score: 5.0,
                reasoning: 'Declined politely.',
                evaluationType: 'evaluator.bot_response_rating',
                computeStatus: 'COMPLETED',
                actual: 'I can only help...',
                expected: 'The agent declines.',
              }),
            },
            {
              scorerName: 'Coherence Evaluation',
              scorerResponse: enc({
                status: 'Fail',
                score: 0.0,
                reasoning: 'Incoherent.',
                evaluationType: 'evaluator.text_quality',
                computeStatus: 'COMPLETED',
              }),
            },
            {
              scorerName: 'Subagent Evaluation',
              scorerResponse: enc({ actualValue: 'GeneralFAQ', expectedValue: 'off_topic' }),
            },
            {
              scorerName: 'Action Evaluation',
              scorerResponse: enc({ actualValue: '[]', expectedValue: '[]' }),
            },
          ],
        },
      ],
    } as typeof studioResults;
    const parsed = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as {
      totals: Record<string, number>;
      cases: Array<{
        verdict: string;
        subject_response: string | null;
        routed_topics: string[];
        session_id: string | null;
        scorers: Array<{
          name: string | null;
          scorer: string | null;
          passed: boolean | null;
          score: number | null;
          explanation: string | null;
          actual_value: unknown;
          expected_value: unknown;
          compute_status: string | null;
          raw: unknown;
        }>;
      }>;
    };
    const c = parsed.cases[0]!;
    expect(c.verdict).toBe('failed');
    expect(c.subject_response).toBe("I can only help with the company's topics.");
    expect(c.routed_topics).toEqual(['GeneralFAQ']);
    expect(c.session_id).toBe('sess-1');
    expect(c.scorers.map((s) => s.scorer)).toEqual([
      'bot_response_rating',
      'coherence',
      'topic_sequence_match',
      'action_sequence_match',
    ]);
    expect(c.scorers.map((s) => s.passed)).toEqual([true, false, false, true]);
    expect(c.scorers[0]!.score).toBe(5);
    expect(c.scorers[0]!.explanation).toBe('Declined politely.');
    expect(c.scorers[0]!.compute_status).toBe('COMPLETED');
    expect(c.scorers[2]!.actual_value).toBe('GeneralFAQ');
    expect(c.scorers[2]!.expected_value).toBe('off_topic');
    expect((c.scorers[0]!.raw as Record<string, unknown>).status).toBe('Pass'); // decoded, parsed
    expect(parsed.totals).toEqual({ cases: 1, passed: 0, failed: 1, indeterminate: 0 });
  });

  it('a FAILED Studio run reads results tolerantly and says the RUN failed', async () => {
    studioStatus = { status: 'FAILED', errorMessage: 'Agent not active' };
    studioResultsHttp = 404;
    const gone = await call({ run_id: RUN_ID_STUDIO });
    expect(gone.isError ?? false).toBe(false);
    const g = JSON.parse(textOf(gone)) as Record<string, unknown>;
    expect(g.status).toBe('FAILED');
    expect(g.error_message).toBe('Agent not active');
    expect(g.totals).toEqual({ cases: 0, passed: 0, failed: 0, indeterminate: 0 });
    expect(String(g.note)).toContain('RUN reported FAILED');
    expect(String(g.note)).toContain('Results could not be read');

    studioResultsHttp = 200;
    studioResults = { status: 'FAILED', testCases: [STUDIO_RESULTS.testCases[2]] };
    const partial = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as {
      totals: Record<string, number>;
      cases: Array<{ number: number }>;
      note: string;
    };
    expect(partial.cases.map((c) => c.number)).toEqual([3]);
    expect(partial.totals.passed).toBe(1);
    expect(partial.note).toContain('partial');
    expect(partial.note).not.toContain('Results could not be read');

    // Live-observed 2026-11-09: the org nests the message under errorRepresentation and
    // returns NO cases when a scorer column errored, even though the Tests tab shows them.
    studioStatus = {
      status: 'FAILED',
      errorRepresentation: { errorMessage: 'One or more evaluation columns failed or were skipped' },
    };
    studioResults = {
      status: 'FAILED',
      errorRepresentation: { errorMessage: 'One or more evaluation columns failed or were skipped' },
      testCases: [],
    };
    const nested = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as Record<
      string,
      unknown
    >;
    expect(nested.error_message).toBe('One or more evaluation columns failed or were skipped');
    expect(nested.totals).toEqual({ cases: 0, passed: 0, failed: 0, indeterminate: 0 });
    expect(String(nested.note)).toContain('same scorer set');
  });

  it('a SUCCESS run whose results cannot be read surfaces the error instead of an empty pass', async () => {
    studioStatus = { status: 'SUCCESS' };
    studioResultsHttp = 404;
    const res = await call({ run_id: RUN_ID_STUDIO });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('no results for this run');
  });

  it('Studio TERMINATED is never a pass', async () => {
    studioStatus = { status: 'TERMINATED' };
    studioResults = { status: 'TERMINATED', testCases: [{ testNumber: 1, testScorerResults: [] }] };
    const parsed = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as {
      status: string;
      totals: Record<string, number>;
      note: string;
    };
    expect(parsed.status).toBe('TERMINATED');
    expect(parsed.note).toContain('NOT a pass');
    expect(parsed.totals).toEqual({ cases: 1, passed: 0, failed: 0, indeterminate: 1 });
  });

  it('include_details passes raw Studio testCases through; oversized Studio results truncate honestly', async () => {
    studioStatus = { status: 'SUCCESS' };
    studioResults = { testCases: [{ testNumber: 7, testScorerResults: [] }] };
    const detailed = JSON.parse(
      textOf(await call({ run_id: RUN_ID_STUDIO, include_details: true })),
    ) as Record<string, unknown>;
    expect(JSON.stringify(detailed.raw_test_cases)).toContain('"testNumber":7');

    studioResults = {
      testCases: Array.from({ length: 200 }, (_, i) => ({
        testNumber: i + 1,
        subjectResponse: 'x'.repeat(1500),
        testScorerResults: [],
      })),
    };
    const big = JSON.parse(textOf(await call({ run_id: RUN_ID_STUDIO }))) as {
      totals: { cases: number };
      cases: unknown[];
      cases_truncated?: boolean;
      cases_note?: string;
    };
    expect(big.totals.cases).toBe(200);
    expect(big.cases_truncated).toBe(true);
    expect(big.cases.length).toBeLessThan(200);
    expect(big.cases_note).toMatch(/Dropped \d+ case/);
  });

  it('THE MODE SPLIT holds for Studio and precedes the lookup', async () => {
    const poll = await call({ run_id: RUN_ID_STUDIO }, 'diag-only');
    expect(poll.isError ?? false).toBe(false);

    const start = await call({ eval: 'Order_Agent_Studio' }, 'diag-only');
    expect(start.isError).toBe(true);
    expect(textOf(start)).toContain('data_write');
    expect(textOf(start)).toContain('REAL actions');
    expect(soapCalls).toBe(0);
    expect(submitPosts).toHaveLength(0);
    expect(studioSubmitPosts).toHaveLength(0);
    const audits = db.queryAuditEvents({ limit: 20 });
    expect(
      audits.some(
        (a) =>
          a.eventType === 'grant.refused' &&
          JSON.stringify(a.detail ?? {}).includes('agent_eval_start'),
      ),
    ).toBe(true);
  });

  it('the describe text is honest about both runners: Beta, metadata_read for detection, no silent fallback, no unverified ACTIVE-version claim', async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'run_agent_eval');
    expect(tool).toBeDefined();
    const text = tool!.description ?? '';
    expect(text).toContain('BETA');
    expect(text).toContain('metadata_read');
    expect(text).toContain('a failed lookup is refused');
    expect(text).not.toContain('falls back');
    expect(text).toContain('unverified');
    expect(text).not.toContain('not available through Contrail');
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain('runner');
  });
});

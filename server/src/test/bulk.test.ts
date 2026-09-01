import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import { deploysDir, stagingDir } from '../core/paths.js';
import { RestClient } from '../salesforce/rest.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';

/**
 * S27 bulk-load tests. The invariants under test: the ritual holds for kind
 * 'bulk' (code only on the page, single-use, supersede cleans the payload
 * DIRECTORY); files are frozen at propose and verified at execute; jobs run
 * sequentially in step order with honest per-step results; failed rows come
 * back as file PATHS, never as row data in a tool result.
 */

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let tokens: MemoryTokenStore;
let approvals: ApprovalPageServer;
let client: Client;
let presentedPages: string[];

// ── Bulk API stub state ──────────────────────────────────────────────────
let createdJobs: Array<{ id: string; body: Record<string, unknown> }>;
let uploads: Map<string, { body: string; contentType: string; authorization: string }>;
let patches: Array<{ jobId: string; state: string }>;
/** job ordinal (0-based, creation order) → failed-row count at JobComplete */
let failedRowsByJobIndex: Map<number, number>;
/** job ordinals that never leave InProgress (timeout tests) */
let neverCompleteJobIndexes: Set<number>;
/** job ordinal → number of InProgress polls before JobComplete (soft-wait tests) */
let inProgressPollsByJobIndex: Map<number, number>;
/** job ordinal → job-level errorMessage (state Failed, nothing processed) */
let jobFailHard: Map<number, string>;
let pollCounts: Map<string, number>;

function jobInfo(id: string, extra: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id,
      numberRecordsProcessed: 0,
      numberRecordsFailed: 0,
      errorMessage: null,
      ...extra,
    }),
  );
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://bulk.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D9/0059',
          token_type: 'Bearer',
        }),
      );
    }
    if (/\/jobs\/ingest\/?$/.test(url) && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const id = `750BULK00000${createdJobs.length + 1}`;
      createdJobs.push({ id, body });
      return jobInfo(id, { state: 'Open' });
    }
    const batches = /\/jobs\/ingest\/([^/]+)\/batches\/?$/.exec(url);
    if (batches && method === 'PUT') {
      uploads.set(batches[1]!, {
        body: String(init?.body ?? ''),
        contentType: headers['Content-Type'] ?? '',
        authorization: headers.Authorization ?? '',
      });
      return new Response('', { status: 201 });
    }
    const failedRes = /\/jobs\/ingest\/([^/]+)\/failedResults\/?$/.exec(url);
    if (failedRes) {
      const idx = createdJobs.findIndex((j) => j.id === failedRes[1]);
      const n = failedRowsByJobIndex.get(idx) ?? 0;
      const rows = Array.from(
        { length: n },
        (_, i) => `"badrow${i + 1}","","MALFORMED_ID:bad reference"`,
      );
      return new Response(['"Name","sf__Id","sf__Error"', ...rows, ''].join('\n'));
    }
    const unprocRes = /\/jobs\/ingest\/([^/]+)\/unprocessedrecords\/?$/.exec(url);
    if (unprocRes) {
      const idx = createdJobs.findIndex((j) => j.id === unprocRes[1]);
      const rows = jobFailHard.has(idx) ? ['"unsent1"', '"unsent2"'] : [];
      return new Response(['"Name"', ...rows, ''].join('\n'));
    }
    const jobUrl = /\/jobs\/ingest\/([^/]+)\/?$/.exec(url);
    if (jobUrl && method === 'PATCH') {
      const state = (JSON.parse(String(init?.body ?? '{}')) as { state?: string }).state ?? '';
      patches.push({ jobId: jobUrl[1]!, state });
      return jobInfo(jobUrl[1]!, { state });
    }
    if (jobUrl && method === 'GET') {
      const jobId = jobUrl[1]!;
      const idx = createdJobs.findIndex((j) => j.id === jobId);
      if (jobFailHard.has(idx)) {
        return jobInfo(jobId, { state: 'Failed', errorMessage: jobFailHard.get(idx) });
      }
      if (neverCompleteJobIndexes.has(idx)) {
        return jobInfo(jobId, { state: 'InProgress' });
      }
      const polls = (pollCounts.get(jobId) ?? 0) + 1;
      pollCounts.set(jobId, polls);
      if (polls <= (inProgressPollsByJobIndex.get(idx) ?? 0)) {
        return jobInfo(jobId, { state: 'InProgress', numberRecordsProcessed: 1 });
      }
      const uploaded = uploads.get(jobId);
      const rows = uploaded ? uploaded.body.trim().split(/\r?\n/).length - 1 : 0;
      const failed = failedRowsByJobIndex.get(idx) ?? 0;
      return jobInfo(jobId, {
        state: 'JobComplete',
        numberRecordsProcessed: rows,
        numberRecordsFailed: failed,
      });
    }
    return new Response('not found', { status: 404 });
  });
}

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function writeStagingCsv(name: string, content: string | Buffer): string {
  const p = path.join(stagingDir(), name);
  fs.writeFileSync(p, content);
  return p;
}

const FLOW_OPS = {
  exchangeCode: async () => {
    throw new Error('not used');
  },
  fetchOrgInfo: async () => {
    throw new Error('not used');
  },
  fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
  revokeToken: async () => ({ ok: true }),
  openBrowser: async (): Promise<void> => {},
};

function makeConfig(bulkOverrides: Partial<ContrailConfig['bulkLoad']> = {}): ContrailConfig {
  return {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy },
    bulkLoad: {
      ...DEFAULT_CONFIG.bulkLoad,
      pollIntervalMs: 5,
      ingestTimeoutMs: 1000,
      toolWaitMs: 10_000,
      ...bulkOverrides,
    },
  };
}

async function makeClient(config: ContrailConfig): Promise<Client> {
  const deps = createDeps({ db, tokens, config, store, approvals, flowOps: FLOW_OPS });
  const server = createServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(ct);
  return c;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-bulk-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  tokens = new MemoryTokenStore();
  presentedPages = [];
  createdJobs = [];
  uploads = new Map();
  patches = [];
  failedRowsByJobIndex = new Map();
  neverCompleteJobIndexes = new Set();
  inProgressPollsByJobIndex = new Map();
  jobFailHard = new Map();
  pollCounts = new Map();

  const grants = emptyGrantSet();
  grants.data_read = true;
  grants.data_write = true;
  const conn = db.insertConnection({
    alias: 'bulk-org',
    instanceUrl: 'https://bulk.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D9',
    orgName: 'Bulk Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  const roGrants = emptyGrantSet();
  roGrants.data_read = true;
  db.insertConnection({
    alias: 'read-only',
    instanceUrl: 'https://ro.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D8',
    orgName: 'RO',
    orgType: 'production',
    isSandbox: false,
    username: null,
    userId: null,
    grants: roGrants,
  });
  stubSalesforce();

  approvals = new ApprovalPageServer(async () => {});
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (
    html: string,
    statusCheck?: () => { active: boolean; status: string },
  ) => {
    presentedPages.push(html);
    return origPresent(html, statusCheck);
  };

  client = await makeClient(makeConfig());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ACCOUNTS_CSV = 'Name,External_Id__c\nAcme,A-1\nGlobex,A-2\n';
const CONTACTS_CSV =
  'FirstName,LastName,Contact_Ext__c,Account.External_Id__c\n' +
  'Ann,Ash,C-1,A-1\nBo,Berg,C-2,A-2\n';

function twoStepArgs(): Record<string, unknown> {
  return {
    connection: 'bulk-org',
    steps: [
      { csv_file: writeStagingCsv('accounts.csv', ACCOUNTS_CSV), object: 'Account', operation: 'insert' },
      {
        csv_file: writeStagingCsv('contacts.csv', CONTACTS_CSV),
        object: 'Contact',
        operation: 'upsert',
        external_id_field: 'Contact_Ext__c',
      },
    ],
  };
}

async function propose(args: Record<string, unknown>) {
  return client.callTool({ name: 'bulk_load_propose', arguments: args });
}

async function execute(code: string, c: Client = client) {
  return c.callTool({
    name: 'bulk_load_execute',
    arguments: { connection: 'bulk-org', confirmation_code: code },
  });
}

async function executeToCompletion(code: string, c: Client = client): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const text = textOf(await execute(code, c));
    if (!text.includes('still running')) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('bulk load never completed');
}

/** The one payload directory under deploys/ (bulk payload dirs are named by request id). */
function payloadDirs(): string[] {
  return fs
    .readdirSync(deploysDir())
    .filter(
      (e) =>
        fs.statSync(path.join(deploysDir(), e)).isDirectory() &&
        !e.startsWith('bulk-stage-') &&
        !e.endsWith('-results'),
    )
    .map((e) => path.join(deploysDir(), e));
}

describe('propose: the ritual and the freeze', () => {
  it('one page carries the whole plan and the code; the agent result carries neither code nor rows', async () => {
    const res = await propose(twoStepArgs());
    const text = textOf(res);
    expect(res.isError ?? false).toBe(false);

    // Honest plan summary for the agent: counts, columns, hashes — no code.
    expect(text).toContain('"total_rows": 4');
    expect(text).toContain('"sha256_prefix"');
    expect(text).toContain('Account.External_Id__c');
    const page = presentedPages.at(-1)!;
    const code = codeFromPage(page);
    expect(text).not.toContain(code);

    // The page: full plan, mode promise, the no-rollback honesty line.
    expect(page).toContain('Approve this bulk data load');
    expect(page).toContain('STEP 1  INSERT Account — 2 rows');
    expect(page).toContain('STEP 2  UPSERT Contact — 2 rows (match on Contact_Ext__c)');
    expect(page).toContain('stop-on-failure');
    expect(page).toContain('NOT atomic');
    expect(page).toContain('frozen sha256');

    // Frozen bytes are byte-identical to the sources, in step order.
    const dirs = payloadDirs();
    expect(dirs).toHaveLength(1);
    expect(fs.readFileSync(path.join(dirs[0]!, 'step-1.csv'), 'utf8')).toBe(ACCOUNTS_CSV);
    expect(fs.readFileSync(path.join(dirs[0]!, 'step-2.csv'), 'utf8')).toBe(CONTACTS_CSV);
  });

  it('delete steps lead on the destructive card with the soft-delete warning', async () => {
    const res = await propose({
      connection: 'bulk-org',
      steps: [
        {
          csv_file: writeStagingCsv('del.csv', 'Id\n001000000000001AAA\n001000000000002AAA\n'),
          object: 'Account',
          operation: 'delete',
        },
      ],
    });
    expect(res.isError ?? false).toBe(false);
    const page = presentedPages.at(-1)!;
    expect(page).toContain('danger-card');
    expect(page).toContain('STEP 1  DELETE Account — 2 rows');
    expect(page).toContain('DELETES 2 row(s)');
    expect(page).toContain('Recycle Bin');
    expect(page).toContain('hardDelete is not offered');
  });

  it('re-propose supersedes the pending plan AND deletes its payload directory', async () => {
    await propose(twoStepArgs());
    const oldCode = codeFromPage(presentedPages.at(-1)!);
    const [oldDir] = payloadDirs();
    await propose(twoStepArgs());
    const dirs = payloadDirs();
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(oldDir!)).toBe(false);

    const res = await execute(oldCode);
    expect(textOf(res)).toContain('superseded');
  });

  it('refuses malformed plans before anything is frozen', async () => {
    const cases: Array<{ step: Record<string, unknown>; err: RegExp }> = [
      {
        step: {
          csv_file: writeStagingCsv('a.csv', ACCOUNTS_CSV),
          object: 'Contact',
          operation: 'upsert',
        },
        err: /upsert requires external_id_field/,
      },
      {
        step: {
          csv_file: writeStagingCsv('b.csv', ACCOUNTS_CSV),
          object: 'Account',
          operation: 'insert',
          external_id_field: 'External_Id__c',
        },
        err: /only meaningful for upsert/,
      },
      {
        step: {
          csv_file: writeStagingCsv('c.csv', ACCOUNTS_CSV),
          object: 'Account',
          operation: 'delete',
        },
        err: /single Id column/,
      },
      {
        step: {
          csv_file: writeStagingCsv('d.csv', 'Name\n"never closed\n'),
          object: 'Account',
          operation: 'insert',
        },
        err: /unbalanced quote/,
      },
      {
        step: {
          csv_file: writeStagingCsv('e.csv', CONTACTS_CSV),
          object: 'Contact',
          operation: 'upsert',
          external_id_field: 'Not_A_Column__c',
        },
        err: /not in this file's header/,
      },
    ];
    for (const c of cases) {
      const res = await propose({ connection: 'bulk-org', steps: [c.step] });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(c.err);
    }
    // Nothing frozen, nothing pending: every refusal happened before a request row.
    expect(payloadDirs()).toHaveLength(0);
  });

  it('confines csv_file exactly like content_file (staging/snapshots/configured roots)', async () => {
    const outside = path.join(os.tmpdir(), `contrail-bulk-outside-${Date.now()}.csv`);
    fs.writeFileSync(outside, ACCOUNTS_CSV);
    try {
      const res = await propose({
        connection: 'bulk-org',
        steps: [{ csv_file: outside, object: 'Account', operation: 'insert' }],
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/csv_file is outside every allowed deploy source root/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('needs data_write — a read-only connection is refused', async () => {
    const res = await client.callTool({
      name: 'bulk_load_propose',
      arguments: {
        connection: 'read-only',
        steps: [
          {
            csv_file: writeStagingCsv('ro.csv', ACCOUNTS_CSV),
            object: 'Account',
            operation: 'insert',
          },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('data_write');
  });
});

describe('execute: sequential jobs, honest outcomes', () => {
  it('runs the jobs in step order with the frozen bytes and the declared line ending', async () => {
    const bomCrlf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Id\r\n001000000000001AAA\r\n', 'utf8'),
    ]);
    await propose({
      connection: 'bulk-org',
      steps: [
        { csv_file: writeStagingCsv('accounts.csv', ACCOUNTS_CSV), object: 'Account', operation: 'insert' },
        { csv_file: writeStagingCsv('del.csv', bomCrlf), object: 'Account', operation: 'delete' },
      ],
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const [payloadDir] = payloadDirs();
    const text = await executeToCompletion(code);

    expect(text).toContain('"executed": true');
    expect(createdJobs.map((j) => j.body.operation)).toEqual(['insert', 'delete']);
    expect(createdJobs[0]!.body).toMatchObject({
      object: 'Account',
      lineEnding: 'LF',
      columnDelimiter: 'COMMA',
      contentType: 'CSV',
    });
    // CRLF detected and declared; the BOM never reaches the org.
    expect(createdJobs[1]!.body.lineEnding).toBe('CRLF');
    const upload2 = uploads.get(createdJobs[1]!.id)!;
    expect(upload2.body.startsWith('Id\r\n')).toBe(true);
    expect(upload2.contentType).toContain('text/csv');
    expect(upload2.authorization).toBe('Bearer AT');
    // Every job was closed (UploadComplete), none aborted.
    expect(patches.filter((p) => p.state === 'UploadComplete')).toHaveLength(2);
    expect(patches.filter((p) => p.state === 'Aborted')).toHaveLength(0);

    // Spent payload directory is gone; no results dir for a clean run.
    expect(fs.existsSync(payloadDir!)).toBe(false);
    expect(fs.existsSync(`${payloadDir}-results`)).toBe(false);

    // Replay with the same code returns the stored outcome, not a re-run.
    const replay = textOf(await execute(code));
    expect(replay).toContain('"already_completed": true');
    expect(createdJobs).toHaveLength(2);
  });

  it('failed rows: files by PATH (never row data), later steps skipped, request failed', async () => {
    failedRowsByJobIndex.set(1, 1);
    await propose({
      connection: 'bulk-org',
      steps: [
        { csv_file: writeStagingCsv('s1.csv', ACCOUNTS_CSV), object: 'Account', operation: 'insert' },
        {
          csv_file: writeStagingCsv('s2.csv', CONTACTS_CSV),
          object: 'Contact',
          operation: 'upsert',
          external_id_field: 'Contact_Ext__c',
        },
        { csv_file: writeStagingCsv('s3.csv', 'Id\n001000000000001AAA\n'), object: 'Contact', operation: 'delete' },
      ],
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const [payloadDir] = payloadDirs();
    const text = await executeToCompletion(code);

    expect(text).toContain('"executed": false');
    expect(text).toContain('"halted_after_step": 2');
    expect(text).toContain('"state": "Skipped"');
    expect(text).toContain('step-2-failed.csv');
    // The org's failed-row export landed on disk, NOT in the tool result.
    expect(text).not.toContain('badrow');
    const failedFile = path.join(`${payloadDir}-results`, 'step-2-failed.csv');
    expect(fs.readFileSync(failedFile, 'utf8')).toContain('badrow1');
    // Only 2 jobs ran — step 3 never reached the org.
    expect(createdJobs).toHaveLength(2);
    // The spent payload is cleaned; the results directory SURVIVES.
    expect(fs.existsSync(payloadDir!)).toBe(false);
    expect(fs.existsSync(`${payloadDir}-results`)).toBe(true);
    // Header-only unprocessed export was worth no file.
    expect(fs.existsSync(path.join(`${payloadDir}-results`, 'step-2-unprocessed.csv'))).toBe(false);
  });

  it('stop_on_failure:false runs every step and reports each honestly', async () => {
    failedRowsByJobIndex.set(0, 2);
    await propose({ ...twoStepArgs(), stop_on_failure: false });
    const code = codeFromPage(presentedPages.at(-1)!);
    expect(presentedPages.at(-1)!).toContain('continue-on-failure');
    const text = await executeToCompletion(code);

    expect(text).toContain('"executed": false');
    expect(text).not.toContain('Skipped');
    expect(text).not.toContain('halted_after_step');
    expect(createdJobs).toHaveLength(2);
    expect(text).toContain('"total_failed": 2');
  });

  it('a job-level failure (state Failed, nothing processed) writes the unprocessed export', async () => {
    jobFailHard.set(0, 'InvalidBatch : Field name not found : Nmae');
    await propose({
      connection: 'bulk-org',
      steps: [
        { csv_file: writeStagingCsv('s1.csv', 'Nmae\nAcme\n'), object: 'Account', operation: 'insert' },
      ],
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const [payloadDir] = payloadDirs();
    const text = await executeToCompletion(code);

    expect(text).toContain('"executed": false');
    expect(text).toContain('Field name not found');
    expect(fs.existsSync(path.join(`${payloadDir}-results`, 'step-1-unprocessed.csv'))).toBe(true);
  });

  it('a job that never finishes is aborted and reported as the timeout it is', async () => {
    neverCompleteJobIndexes.add(0);
    await propose({
      connection: 'bulk-org',
      steps: [
        { csv_file: writeStagingCsv('s1.csv', ACCOUNTS_CSV), object: 'Account', operation: 'insert' },
      ],
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const text = await executeToCompletion(code);

    expect(text).toContain('"executed": false');
    expect(text).toMatch(/did not finish within/);
    expect(patches.some((p) => p.state === 'Aborted')).toBe(true);
    // The code is spent — the timeout is a terminal outcome.
    expect(textOf(await execute(code))).toContain('"already_completed": true');
  });

  it('soft-waits: a long run returns in_progress and a repeat call re-attaches, never re-running', async () => {
    const impatient = await makeClient(makeConfig({ toolWaitMs: 5, pollIntervalMs: 20 }));
    try {
      inProgressPollsByJobIndex.set(0, 6);
      await propose(twoStepArgs());
      const code = codeFromPage(presentedPages.at(-1)!);
      const first = textOf(await execute(code, impatient));
      expect(first).toContain('still running');
      const text = await executeToCompletion(code, impatient);
      expect(text).toContain('"executed": true');
      // Re-attachment, not a second run: exactly one job per step.
      expect(createdJobs).toHaveLength(2);
    } finally {
      await impatient.close();
    }
  });

  it('refuses a wrong code with the bulk noun and spends attempts', async () => {
    await propose(twoStepArgs());
    const res = await execute('XXXX-XXXX');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('No bulk data load on "bulk-org" matches that code');
  });
});

describe('RestClient header contract (the fix that makes text/csv possible)', () => {
  it('lets a caller override Content-Type but never Authorization', async () => {
    let captured: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return new Response('{}');
    });
    const conn = db.resolveConnection('bulk-org')!;
    const fakeTokens = {
      getAccessToken: async () => 'AT',
      invalidate: () => {},
    } as unknown as AccessTokenManager;
    const rest = new RestClient(fakeTokens, conn, 'v63.0');
    await rest.request('/services/data/v63.0/jobs/ingest/750X/batches', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv; charset=UTF-8', Authorization: 'Bearer EVIL' },
      body: 'Id\n',
    });
    expect(captured['Content-Type']).toBe('text/csv; charset=UTF-8');
    expect(captured.Authorization).toBe('Bearer AT');
  });
});

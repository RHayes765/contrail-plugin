import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import {
  NOT_RESTORABLE_LIST_ONLY,
  NOT_RESTORABLE_UNPLACED,
  type RevertTargetCheck,
} from '../deploy/preimage.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { ToolDeps } from '../tools/register.js';
import type { ConnectionRecord, DeployRequestRecord } from '../core/types.js';

/**
 * S45 F4: the frozen revert package at the execute seam — finalized
 * (revert-plan.json + README.txt) on 'executed', KEPT with outcome:'unknown'
 * when Contrail lost track of the deploy, removed inline wherever nothing
 * committed (org-reported rollback, missing payload) or the code can never
 * run (supersede, expired, locked), never built from the snapshot, and swept
 * at the next real validate — which first expires stale codes on EVERY
 * connection — under deploy.revertRetentionDays (0 = never). Dry runs sweep
 * nothing.
 */

class SilentNotifier implements ApprovalNotifier {
  async notify(): Promise<NotifyOutcome> {
    return { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: 'pushover' as const, when: 'always' as const, configured: true };
  }
  resetCircuit() {}
}

const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const CREATED = '2026-11-14T15:00:01.000Z';
const COMPLETED = '2026-11-14T15:00:09.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

const FOO_PROPOSED = 'public class Foo {\n    public static Integer one() { return 1; }\n}\n';
const FOO_LIVE = 'public class Foo {\n    public static Integer one() { return 0; }\n}\n';
const NEW_CLS = 'public class NewCls {\n}\n';
const APEX_META = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass ${MD}>\n    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
const BOT_V1_LIVE = '<botVersions>\n        <fullName>v1</fullName>\n        <botDialogs/>\n    </botVersions>';
const MYBOT = `<?xml version="1.0" encoding="UTF-8"?>\n<Bot ${MD}>\n    ${BOT_V1_LIVE}\n    <label>MyBot</label>\n</Bot>\n`;
const BOT_V1_PROPOSED =
  '<botVersions>\n        <fullName>v1</fullName>\n        <botDialogs/>\n        <description>new</description>\n    </botVersions>';

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let client: Client;
let deps: ToolDeps;
let config: ContrailConfig;
let connId: string;
let otherId: string;
let presentedPages: string[];
let liveFiles: Record<string, string>;
let listRows: Record<string, Array<{ fullName: string; date: string; by: string }>>;
let invalidTypes: Set<string>;
let retrieveMode: 'ok' | 'fault';
let realMode: 'ok' | 'fail' | 'never';
let realDeploys: number;
let cancels: number;
/**
 * S46 D1: the records a stamp query returns, per queried sObject — handed
 * back whole (this stub does not evaluate the WHERE clause; targetmoved.test.ts
 * and livediff.test.ts do).
 */
let probeRows: Record<string, Array<Record<string, unknown>>>;
/** The decoded SOQL of every stamp query issued, in order. */
let stampQueries: string[];
/** Every listMetadata query issued, in order, as its raw `<met:queries>` body. */
let listQueries: string[];
/** 'fault' answers every stamp query with HTTP 500. */
let probeMode: 'ok' | 'fault';
/** 'fault' answers every listMetadata call with a SOAP fault (not INVALID_TYPE). */
let listMode: 'ok' | 'fault';

/** One stamp query answered from probeRows, or null when the SOQL is not a stamp query. */
function stampQueryResponse(soql: string): Response | null {
  const m =
    /^SELECT Id, \w+, NamespacePrefix, LastModifiedDate, LastModifiedBy\.Name FROM (\w+) WHERE /.exec(
      soql,
    );
  if (!m) return null;
  stampQueries.push(soql);
  if (probeMode === 'fault') return new Response('stamp query down', { status: 500 });
  const records = probeRows[m[1]!] ?? [];
  return new Response(JSON.stringify({ done: true, totalSize: records.length, records }));
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function fault(code: string, message: string): Response {
  return new Response(
    soapEnvelope(
      `<soapenv:Fault><faultcode>sf:${code}</faultcode><faultstring>${message}</faultstring></soapenv:Fault>`,
    ),
    { status: 500 },
  );
}

function liveZipB64(): string {
  const entries: Record<string, Uint8Array> = { 'unpackaged/package.xml': strToU8('<Package/>') };
  for (const [rel, body] of Object.entries(liveFiles)) entries[`unpackaged/${rel}`] = strToU8(body);
  return Buffer.from(zipSync(entries)).toString('base64');
}

function deployStatus(opts: { done: boolean; success: boolean; checkOnly: boolean }): Response {
  return new Response(
    soapEnvelope(
      `<checkDeployStatusResponse ${MD}><result>
         <done>${opts.done}</done><status>${opts.done ? (opts.success ? 'Succeeded' : 'Failed') : 'InProgress'}</status>
         <success>${opts.success}</success><checkOnly>${opts.checkOnly}</checkOnly>
         <createdDate>${CREATED}</createdDate>${opts.done ? `<completedDate>${COMPLETED}</completedDate>` : ''}
         <numberComponentsTotal>1</numberComponentsTotal>
         <numberComponentsDeployed>${opts.success ? 1 : 0}</numberComponentsDeployed>
         <numberComponentErrors>${opts.done && !opts.success ? 1 : 0}</numberComponentErrors>
         <numberTestsTotal>0</numberTestsTotal>
         <numberTestsCompleted>0</numberTestsCompleted>
         <numberTestErrors>0</numberTestErrors>
         ${opts.done && !opts.success ? '<errorMessage>Compile error at line 3</errorMessage>' : ''}
         <details><runTestResult><numTestsRun>0</numTestsRun>
           <numFailures>0</numFailures></runTestResult></details>
       </result></checkDeployStatusResponse>`,
    ),
  );
}

/**
 * The livediff.test.ts stub idiom (checkOnly deploy, pre-image retrieve,
 * listMetadata rows per type with sf:INVALID_TYPE for invalidTypes, the
 * stamp queries answered from probeRows), plus the REAL deploy: done+success,
 * an org-reported failure (rollbackOnError), or a status that never reports
 * done (the outcome-unknown path), and cancelDeploy.
 */
function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://revert.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DR/005R',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/tooling/query')) {
      const stamp = stampQueryResponse(new URL(url).searchParams.get('q') ?? '');
      if (stamp) return stamp;
      // Everything else on this route is the Aura live check's Tooling read.
      return new Response(JSON.stringify({ done: true, records: [], totalSize: 0 }));
    }
    if (/\/services\/data\/v[\d.]+\/query\?q=/.test(url)) {
      const stamp = stampQueryResponse(new URL(url).searchParams.get('q') ?? '');
      if (stamp) return stamp;
      return new Response('not found', { status: 404 });
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        const checkOnly = body.includes('<met:checkOnly>true</met:checkOnly>');
        if (!checkOnly) realDeploys += 1;
        const id = checkOnly ? '0Af-check' : `0Af-real-${realDeploys}`;
        return new Response(
          soapEnvelope(`<deployResponse ${MD}><result><id>${id}</id></result></deployResponse>`),
        );
      }
      if (body.includes('<met:cancelDeploy>')) {
        cancels += 1;
        return new Response(
          soapEnvelope(
            `<cancelDeployResponse ${MD}><result><done>false</done><id>x</id></result></cancelDeployResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        const id = /<met:asyncProcessId>([^<]+)</.exec(body)?.[1] ?? '';
        if (!id.startsWith('0Af-real')) {
          return deployStatus({ done: true, success: true, checkOnly: true });
        }
        if (realMode === 'never') return deployStatus({ done: false, success: false, checkOnly: false });
        return deployStatus({ done: true, success: realMode === 'ok', checkOnly: false });
      }
      if (body.includes('<met:retrieve>')) {
        if (retrieveMode === 'fault') return fault('UNKNOWN_EXCEPTION', 'retrieve blew up');
        return new Response(
          soapEnvelope(
            `<retrieveResponse ${MD}><result><id>09S1</id><done>false</done><state>Queued</state></result></retrieveResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkRetrieveStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
              `<status>Succeeded</status><success>true</success>` +
              `<zipFile>${liveZipB64()}</zipFile></result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (body.includes('<met:listMetadata>')) {
        for (const q of body.matchAll(/<met:queries>(.*?)<\/met:queries>/g)) listQueries.push(q[1]!);
        if (listMode === 'fault') return fault('UNKNOWN_EXCEPTION', 'list blew up');
        const queries = [
          ...body.matchAll(
            /<met:queries>(?:<met:folder>([^<]*)<\/met:folder>)?<met:type>([^<]+)<\/met:type><\/met:queries>/g,
          ),
        ].map((m) => m[2]!);
        for (const t of queries) {
          if (invalidTypes.has(t)) {
            return fault('INVALID_TYPE', `INVALID_TYPE: Cannot use: ${t} in this version`);
          }
        }
        const rows = queries.flatMap((t) =>
          (listRows[t] ?? []).map(
            (r) =>
              `<result><fullName>${r.fullName}</fullName><type>${t}</type><fileName>x</fileName>` +
              `<id>1</id><lastModifiedDate>${r.date}</lastModifiedDate>` +
              `<lastModifiedByName>${r.by}</lastModifiedByName></result>`,
          ),
        );
        return new Response(
          soapEnvelope(`<listMetadataResponse ${MD}>${rows.join('')}</listMetadataResponse>`),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  });
}

function insertConn(alias: string, orgId: string, tokens: MemoryTokenStore): string {
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias,
    instanceUrl: 'https://revert.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId,
    orgName: alias,
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  return conn.id;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-'));
  // stagingDir()/deploysDir() — and so every sweep — stay under the temp dir.
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  presentedPages = [];
  liveFiles = {
    'classes/Foo.cls': FOO_LIVE,
    'classes/Foo.cls-meta.xml': APEX_META,
    'bots/MyBot.bot': MYBOT,
  };
  listRows = {
    ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }],
    PresenceUserConfig: [{ fullName: 'Voice_Agents', date: '2026-11-09T08:00:00.000Z', by: 'Bob' }],
  };
  invalidTypes = new Set();
  retrieveMode = 'ok';
  realMode = 'ok';
  realDeploys = 0;
  cancels = 0;
  probeRows = {};
  stampQueries = [];
  listQueries = [];
  probeMode = 'ok';
  listMode = 'ok';

  const tokens = new MemoryTokenStore();
  connId = insertConn('rev-org', '00DR', tokens);
  otherId = insertConn('other-org', '00DO', tokens);
  stubSalesforce();

  const approvals = new ApprovalPageServer(async () => {});
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (
    html: string,
    statusCheck?: () => { active: boolean; status: string },
  ) => {
    presentedPages.push(html);
    return origPresent(html, statusCheck);
  };

  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    // S46 (C): these stubs model no post-execute re-read (rebaseline.test.ts does).
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5, rebaselineAfterDeploy: false },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5, toolWaitMs: 10_000 },
  };
  deps = createDeps({
    db,
    tokens,
    config,
    store,
    approvals,
    notifier: new SilentNotifier(),
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => undefined,
    },
  });
  const server = createServer(deps);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'revert-test', version: '0.0.0' });
  await client.connect(c);
});

afterEach(async () => {
  await client.close();
  db.close();
  vi.unstubAllGlobals();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function jsonOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{')));
}

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
}

const revertsRoot = () => path.join(tmp, 'staging', '_reverts');
const revertDir = (id: string) => path.join(revertsRoot(), id);

/** The full fixture: a live MODIFY, an ADD, an unenumerable child and an unregistered delete. */
const FULL = {
  components: [
    { type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED },
    { type: 'ApexClass', api_name: 'NewCls', content: NEW_CLS },
    { type: 'BotVersion', api_name: 'MyBot.v1', content: BOT_V1_PROPOSED },
  ],
  destructive: [{ type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
  allow_unregistered_delete: true,
};

/** A real validate; returns the request (with its code) it issued. */
async function validate(
  args: Record<string, unknown> = { components: [{ type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED }] },
  connection = 'rev-org',
): Promise<DeployRequestRecord & { code: string }> {
  const before = presentedPages.length;
  const result = await client.callTool({ name: 'validate_deploy', arguments: { connection, ...args } });
  expect(result.isError, textOf(result)).not.toBe(true);
  expect(presentedPages.length).toBe(before + 1);
  const code = codeFromPage(presentedPages[presentedPages.length - 1]!);
  const id = connection === 'rev-org' ? connId : otherId;
  return { ...db.findRequestByCode(id, 'deploy', code)!, code };
}

async function execute(code: string, connection = 'rev-org') {
  return client.callTool({
    name: 'execute_deploy',
    arguments: { connection, confirmation_code: code },
  });
}

/** Rewind a request's expiry on the underlying table (the deploy.test.ts idiom). */
async function backdateExpiry(id: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(path.join(tmp, 'test.db'));
  raw.prepare(`UPDATE deploy_requests SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', id);
  raw.close();
}

function backdate(target: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(target, when, when);
}

const audits = (type: string) => db.queryAuditEvents({}).filter((e) => e.eventType === type);

/** Every regular file under `dir` (recursive); [] for a missing dir. Links are not followed. */
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(p));
    else if (d.isFile()) out.push(p);
  }
  return out;
}

/**
 * The confirmation-code invariant over everything S45 writes: the code
 * (taken from the PAGE) is in no audit row and in no file under `dirs`.
 */
function expectCodeNowhere(code: string, dirs: string[] = []): void {
  expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(code);
  for (const d of dirs) {
    for (const f of walkFiles(d)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(code);
  }
}

describe('S45 F4: the frozen revert package', () => {
  it('validate → execute finalizes revert-plan.json + README.txt and returns revert_package', async () => {
    invalidTypes = new Set(['BotVersion']);
    const req = await validate(FULL);
    const dir = revertDir(req.id);
    const exec = await execute(req.code);
    expect(exec.isError, textOf(exec)).not.toBe(true);
    const result = jsonOf(exec);
    expect(result.deployed).toBe(true);

    const restores = [
      { type: 'ApexClass', api_name: 'Foo', content_file: path.join(dir, 'classes', 'Foo.cls') },
      {
        type: 'BotVersion',
        api_name: 'MyBot.v1',
        content_file: path.join(dir, 'children', 'BotVersion', 'MyBot.v1.xml'),
      },
    ];
    const deletes = [{ type: 'ApexClass', api_name: 'NewCls' }];
    const notRestorable = [
      { type: 'PresenceUserConfig', api_name: 'Voice_Agents', reason: NOT_RESTORABLE_LIST_ONLY },
    ];
    expect(result.revert_package).toMatchObject({
      dir,
      restores,
      deletes,
      not_restorable: notRestorable,
      plan: path.join(dir, 'revert-plan.json'),
    });
    expect(result.revert_package.outcome).toBeUndefined();
    expect(result.revert_note).toBeUndefined();

    // The files: the org's pre-deploy bytes, never the proposal.
    expect(fs.readFileSync(path.join(dir, 'classes', 'Foo.cls'), 'utf8')).toBe(FOO_LIVE);
    expect(fs.readFileSync(path.join(dir, 'classes', 'Foo.cls-meta.xml'), 'utf8')).toBe(APEX_META);
    expect(fs.readFileSync(restores[1]!.content_file, 'utf8')).toBe(BOT_V1_LIVE);
    expect(fs.existsSync(path.join(dir, 'classes', 'NewCls.cls'))).toBe(false);

    const summary = JSON.parse(req.summaryJson) as { live_check: { at: string; started_at: string } };
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan).toMatchObject({
      request_id: req.id,
      connection: 'rev-org',
      retrieved_at: summary.live_check.at,
      retrieve_started_at: summary.live_check.started_at,
      // S45 F2: the execute-time guard's pass result rides into the plan —
      // the same object the deploy result reports as target_check.
      target_check: {
        status: 'ok',
        checked: [
          { type: 'ApexClass', api_name: 'Foo' },
          // S46 D4: absent at validate and still not listed — checked, but
          // no stamp was compared.
          { type: 'ApexClass', api_name: 'NewCls', absent: true },
          { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
        ],
        unchecked: [
          { type: 'BotVersion', api_name: 'MyBot.v1', reason: 'dates_unavailable_at_validate' },
        ],
      },
      components: restores,
      destructive: deletes,
      not_restorable: notRestorable,
    });
    expect(plan.target_check.checked.map((c: { absent?: true }) => c.absent)).toEqual([
      undefined,
      true,
      undefined,
    ]);
    expect(plan.target_check).toEqual(result.target_check);
    expect(Date.parse(plan.executed_at)).not.toBeNaN();
    expect(plan.outcome).toBeUndefined();

    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme.trimEnd()).toBe(result.revert_package.note);
    expect(readme).toContain(
      `A revert re-deploys what Contrail retrieved from "rev-org" at ${summary.live_check.at}, when this deploy was validated.`,
    );
    // Two stamp comparisons and one still-absent member — never "3 of 4 … unchanged".
    expect(readme).toContain(
      "Contrail compared the org's last-modified stamps against that retrieve for 2 of 4 members and found them unchanged, " +
        'and re-checked 1 member(s) that were absent from the org at validate, and the execute-time read of their ' +
        'stamp source again returned nothing for them; it did not re-read any contents, and a matching stamp is ' +
        'evidence, not a byte comparison.',
    );
    expect(readme).not.toContain('for 3 of 4 members');
    expect(readme).toContain(
      '1 member(s) could not be re-checked (BotVersion MyBot.v1 — dates_unavailable_at_validate)',
    );
    expect(readme).toContain(
      `1 member(s) cannot be restored from this package (PresenceUserConfig Voice_Agents — ` +
        `${NOT_RESTORABLE_LIST_ONLY}) — if this deploy changed or deleted them, reverting that needs ` +
        'another source.',
    );
    // A revert is a wholesale replace of what it restores — later edits included.
    expect(readme).toContain(
      're-deploying these files OVERWRITES anything changed in them since that retrieve, another ' +
        "user's edits included",
    );

    // The code reached the human only on the page: not in the result, the
    // stored result, any audit row, or any file under the revert dir.
    expect(textOf(exec)).not.toContain(req.code);
    expect(db.findRequestByCode(connId, 'deploy', req.code)!.resultJson ?? '').not.toContain(req.code);
    expectCodeNowhere(req.code, [dir]);

    expect(audits('deploy.revert_written')).toHaveLength(1);
    expect(audits('deploy.revert_written')[0]!.detail).toMatchObject({
      requestId: req.id,
      dir,
      restores: 2,
      deletes: 1,
      not_restorable: 1,
    });
    expect(db.getDeployRequestStatus(req.id)).toBe('executed');

    // A revert is an ordinary validate_deploy of a content_file (staging is an
    // allowed source root) — and that validate's sweep keeps the fresh package.
    const back = await validate({
      components: [{ type: 'ApexClass', api_name: 'Foo', content_file: restores[0]!.content_file }],
    });
    expect(back.id).not.toBe(req.id);
    expect(fs.existsSync(path.join(dir, 'revert-plan.json'))).toBe(true);
    expect(audits('deploy.revert_swept')).toHaveLength(0);
  });

  it("the execute-time guard's pass result rides into the plan, and the README names unchecked members", async () => {
    // F2 hands its pass result to doExecute; the seam is driven directly here
    // with a fixed verdict — the plan and README must carry what it reports.
    invalidTypes = new Set(['BotVersion']);
    const req = await validate(FULL);
    expect(db.claimRequestForExecution(req.id)).toBe(true);
    const targetCheck: RevertTargetCheck = {
      status: 'ok',
      checked_at: '2026-11-14T15:04:58.000Z',
      checked: [
        { type: 'ApexClass', api_name: 'Foo' },
        { type: 'ApexClass', api_name: 'NewCls', absent: true },
        { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
      ],
      unchecked: [
        { type: 'BotVersion', api_name: 'MyBot.v1', reason: 'dates_unavailable_at_validate' },
      ],
    };
    const conn = db.getConnection(connId) as ConnectionRecord;
    const engine = deps.deploys as unknown as {
      doExecute(
        c: ConnectionRecord,
        r: DeployRequestRecord,
        job: undefined,
        t: RevertTargetCheck,
      ): Promise<Record<string, any>>;
    };
    const result = await engine.doExecute(conn, db.findRequestByCode(connId, 'deploy', req.code)!, undefined, targetCheck);
    expect(result.deployed).toBe(true);
    const dir = revertDir(req.id);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan.target_check).toEqual(targetCheck);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain(
      "Contrail compared the org's last-modified stamps against that retrieve for 2 of 4 members and found them unchanged, " +
        'and re-checked 1 member(s) that were absent from the org at validate',
    );
    expect(readme).toContain(
      `1 member(s) could not be re-checked (BotVersion MyBot.v1 — dates_unavailable_at_validate); ` +
        `their pre-image is as of ${plan.retrieved_at} only.`,
    );
    expect(readme).toContain('1 member(s) cannot be restored from this package (PresenceUserConfig Voice_Agents');
    expect(result.revert_package.note).toBe(readme.trimEnd());
  });

  it('nothing compared (every stamp unavailable at validate): target_check not_checked, audited, and the README never claims a comparison', async () => {
    invalidTypes = new Set(['ApexClass']);
    const req = await validate();
    invalidTypes = new Set();
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      unchecked: [{ type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_validate' }],
    });
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: req.id, kind: 'deploy', reason: 'nothing_compared' },
    ]);
    const readme = fs.readFileSync(path.join(revertDir(req.id), 'README.txt'), 'utf8');
    expect(readme).toContain("Contrail did not re-check the org's last-modified stamps");
    expect(readme).not.toContain('found them unchanged');
    expect(readme).not.toMatch(/for 0 of \d+ members/);
  });

  it('S46 D4: an add-only deploy holds nothing to re-deploy — the README says so, names what a revert deletes, and claims no stamp comparison', async () => {
    const newCls = { type: 'ApexClass', api_name: 'NewCls' };
    const req = await validate({ components: [{ ...newCls, content: NEW_CLS }] });
    const dir = revertDir(req.id);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('ok');
    expect(result.target_check.checked).toEqual([{ ...newCls, absent: true }]);
    expect(result.target_check.unchecked).toEqual([]);
    expect(result.revert_package).toMatchObject({
      dir,
      restores: [],
      deletes: [newCls],
      not_restorable: [],
      plan: path.join(dir, 'revert-plan.json'),
    });

    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan.components).toEqual([]);
    expect(plan.destructive).toEqual([newCls]);
    expect(plan.target_check).toEqual(result.target_check);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').trimEnd();
    expect(readme).toBe(result.revert_package.note);
    expect(readme).toBe(
      'This revert package holds no files to re-deploy: when Contrail retrieved from "rev-org" at ' +
        `${plan.retrieved_at}, while this deploy was validated, it captured nothing a revert could ` +
        'restore. What this package can revert is the 1 component(s) this deploy added: a revert ' +
        'deletes them — revert-plan.json lists them under "destructive". Before executing at ' +
        `${plan.executed_at}, Contrail re-checked 1 member(s) that were absent from the org at ` +
        'validate — of 1 member(s) it considered — and the execute-time read of their stamp source ' +
        'again returned nothing for them; no last-modified stamp was compared. A revert does not ' +
        'undo data changes, automation that ' +
        'ran, permission effects, or changes made since to components outside this package. Deleting ' +
        'the components this deploy added is destructive. Contrail never deploys a revert on its ' +
        'own: pass the destructive list to validate_deploy, and a human approves it like any deploy. ' +
        'DML is out of scope — the persisted before-values and created_ids make a manual revert ' +
        'possible.',
    );
    // Never the restore package's opening, nor a comparison that did not happen.
    expect(readme).not.toContain('A revert re-deploys what Contrail retrieved');
    expect(readme).not.toContain('OVERWRITES');
    expect(readme).not.toContain('found them unchanged');
    // No file of the deploy's own was written beside the plan and the README.
    expect(walkFiles(dir).map((f) => path.basename(f)).sort()).toEqual(['README.txt', 'revert-plan.json']);
    expect(audits('deploy.revert_written')[0]!.detail).toMatchObject({
      requestId: req.id,
      restores: 0,
      deletes: 1,
      not_restorable: 0,
    });
    expectCodeNowhere(req.code, [dir]);
  });

  it('S46 D4: an add-only deploy whose outcome is unknown hedges what it can revert — "if it committed"', async () => {
    config.deploy.deployTimeoutMs = 40;
    const req = await validate({ components: [{ type: 'ApexClass', api_name: 'NewCls', content: NEW_CLS }] });
    const dir = revertDir(req.id);
    realMode = 'never';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(false);
    expect(result.revert_package).toMatchObject({ dir, outcome: 'unknown', restores: [] });
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan).toMatchObject({ executed_at: null, outcome: 'unknown', components: [] });
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').trimEnd();
    expect(readme.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    // The adds may never have landed.
    expect(readme).toContain(
      'What this package can revert is the 1 component(s) this deploy added, if it committed: a ' +
        'revert deletes them',
    );
    expect(readme).toContain('Before submitting this deploy (whose outcome Contrail lost track of');
    expect(readme.endsWith(plan.note)).toBe(true);
    // A package that holds no files never refers to "these files" — neither
    // the README nor the plan's note appended to it.
    expect(plan.note).toBe(
      `Contrail lost track of this deploy (${result.error_message}); check Setup → Deployment ` +
        'Status.',
    );
    expect(readme).not.toContain('these files');
  });

  it('an add-only deploy whose execute-time check could not re-read the org: the README names revert-plan.json, never "these files"', async () => {
    const newCls = { type: 'ApexClass', api_name: 'NewCls' };
    const req = await validate({ components: [{ ...newCls, content: NEW_CLS }] });
    const dir = revertDir(req.id);
    listMode = 'fault';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('unavailable');
    expect(result.target_check.reason).toContain('list blew up');
    expect(result.revert_package).toMatchObject({ dir, restores: [], deletes: [newCls] });
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').trimEnd();
    expect(readme).toBe(result.revert_package.note);
    expect(readme.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    expect(readme).toContain(
      `Before executing at ${plan.executed_at}, Contrail could not re-read the org to compare ` +
        `last-modified stamps (${result.target_check.reason}); the deploy was submitted ` +
        'unverified, and revert-plan.json describes the org as of the validate-time retrieve only.',
    );
    expect(readme).not.toContain('these files');
    expect(readme).not.toContain('found them unchanged');
  });

  it('S46 D1: an add-only custom field whose stamp query failed at validate — nothing compared, and the README never says "these files"', async () => {
    const field = { type: 'CustomField', api_name: 'Invoice__c.Status__c' };
    const content = '<fields>\n        <fullName>Status__c</fullName>\n        <type>Text</type>\n    </fields>';
    probeMode = 'fault';
    const req = await validate({ components: [{ ...field, content }] });
    const summary = JSON.parse(req.summaryJson) as {
      live_check: { probe_failures?: Record<string, string> };
    };
    expect(Object.keys(summary.live_check.probe_failures ?? {})).toEqual(['CustomField']);
    probeMode = 'ok';
    const dir = revertDir(req.id);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      unchecked: [{ ...field, reason: 'dates_unavailable_at_validate' }],
    });
    expect(result.revert_package).toMatchObject({ dir, restores: [], deletes: [field] });
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').trimEnd();
    expect(readme).toBe(result.revert_package.note);
    expect(readme.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    expect(readme).toContain(
      `Before executing at ${plan.executed_at}, Contrail did not re-check the org's last-modified ` +
        'stamps; revert-plan.json describes the org as of the validate-time retrieve only.',
    );
    expect(readme).not.toContain('these files');
    expect(readme).not.toContain('found them unchanged');
  });

  it('S46 D1 + D4: a new custom field — absent by the retrieve and its stamp query at validate, the query again returning nothing at execute', async () => {
    const field = { type: 'CustomField', api_name: 'Invoice__c.Status__c' };
    const content = '<fields>\n        <fullName>Status__c</fullName>\n        <type>Text</type>\n    </fields>';
    const req = await validate({ components: [{ ...field, content }] });
    const summary = JSON.parse(req.summaryJson) as { changes: Array<{ pre_image: Record<string, unknown> }> };
    expect(summary.changes[0]!.pre_image).toMatchObject({
      present: false,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    const dir = revertDir(req.id);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.checked).toEqual([{ ...field, absent: true }]);
    expect(result.revert_package).toMatchObject({ restores: [], deletes: [field] });
    // The same query at both ends, naming the package's own member.
    const stampQuery =
      'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
      "CustomField WHERE (DeveloperName = 'Status' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";
    expect(stampQueries).toEqual([stampQuery, stampQuery]);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    // What Contrail read — never "the org has none".
    expect(readme).toContain(
      'Contrail re-checked 1 member(s) that were absent from the org at validate — of 1 member(s) ' +
        'it considered — and the execute-time read of their stamp source again returned nothing for ' +
        'them; no last-modified stamp was compared.',
    );
    expect(readme).not.toContain('found them unchanged');
  });

  it('S46: a destructive CustomField no read can name (".X__c") — unknown at validate, no absence cited, unchecked at execute', async () => {
    const unplaced = { type: 'CustomField', api_name: '.X__c' };
    const req = await validate({
      components: [{ type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED }],
      destructive: [unplaced],
    });
    const summary = JSON.parse(req.summaryJson) as {
      destructive: Array<{ api_name: string; warnings: string[]; pre_image?: Record<string, unknown> }>;
    };
    const row = summary.destructive.find((d) => d.api_name === '.X__c')!;
    expect(row.pre_image).toMatchObject({
      present: null,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
      comparable: false,
      restorable: false,
    });
    // Nothing read the org for it, and nothing says the org lacks it.
    expect(stampQueries).toEqual([]);
    expect(row.warnings.join(' ')).not.toContain('not present in the target');
    expect(presentedPages.at(-1)!).not.toContain('not present in the target');
    const dir = revertDir(req.id);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(stampQueries).toEqual([]);
    // Reported unchecked by the guard — never "checked" and never absent.
    expect(result.target_check.unchecked).toContainEqual({ ...unplaced, reason: 'stamp_not_probeable' });
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan.not_restorable).toContainEqual({ ...unplaced, reason: NOT_RESTORABLE_UNPLACED });
    expect(plan.destructive).toEqual([]);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).not.toContain('absent from the org');
    expect(readme).not.toContain('could not enumerate');
  });

  it('S46: destructive members of type "constructor" and "toString" — refused without the flag; with it never read (presence unknown), unplaced in the revert plan, unchecked at execute, and nothing throws', async () => {
    const strays = [
      { type: 'constructor', api_name: 'Stray_One' },
      { type: 'toString', api_name: 'Stray_Two' },
    ];
    const foo = { type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED };
    // Without the flag: refused as a blind delete of an unregistered type.
    const refused = await client.callTool({
      name: 'validate_deploy',
      arguments: { connection: 'rev-org', components: [foo], destructive: strays },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('constructor Stray_One: this type is not registered');
    // With it: validated and flagged. On the pre-image path they are NOT handled
    // like an unregistered type (which is listed by its type): FOLDERED_TYPES
    // (salesforce/metadataSoap.ts) is a plain-object lookup, so these names read
    // as foldered types with no folder — never retrieved, never listed, and
    // their presence is unknown (null), never absent.
    const req = await validate({
      components: [foo],
      destructive: strays,
      allow_unregistered_delete: true,
    });
    const summary = JSON.parse(req.summaryJson) as {
      destructive: Array<{ type: string; warnings: string[]; pre_image?: Record<string, unknown> }>;
    };
    for (const s of strays) {
      const row = summary.destructive.find((d) => d.type === s.type)!;
      expect(row.warnings.join(' ')).toContain(
        `UNREGISTERED TYPE DELETE — Contrail cannot read ${s.type} or list its dependents`,
      );
      expect(row.warnings.join(' ')).not.toContain('not present in the target');
      expect(row.pre_image).toMatchObject({
        present: null,
        source: 'list',
        stamp_source: 'listMetadata',
        last_modified_date: null,
        comparable: false,
        restorable: false,
      });
    }
    expect(presentedPages.at(-1)!).not.toContain('not present in the target');
    expect(listQueries).toEqual(['<met:type>ApexClass</met:type>']);
    const dir = revertDir(req.id);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    // The guard re-lists ApexClass only; the strays are reported unchecked with
    // the reason its present:null arm gives today.
    expect(listQueries).toEqual(['<met:type>ApexClass</met:type>', '<met:type>ApexClass</met:type>']);
    expect(result.target_check.unchecked).toEqual(
      expect.arrayContaining(strays.map((s) => ({ ...s, reason: 'type_not_enumerable' }))),
    );
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan.components.map((c: { api_name: string }) => c.api_name)).toEqual(['Foo']);
    expect(plan.not_restorable).toEqual(
      expect.arrayContaining(strays.map((s) => ({ ...s, reason: NOT_RESTORABLE_UNPLACED }))),
    );
    expect(plan.destructive).toEqual([]);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).not.toContain('absent from the org');
    expect(readme).not.toContain('could not enumerate');
  });

  it('an org-reported failure (rolled back) removes the revert dir and returns no package', async () => {
    const req = await validate();
    expect(fs.existsSync(revertDir(req.id))).toBe(true);
    realMode = 'fail';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(false);
    expect(result.note).toContain('rolled back');
    expect(result.revert_package).toBeUndefined();
    expect(fs.existsSync(revertDir(req.id))).toBe(false);
    expect(audits('deploy.revert_written')).toHaveLength(0);
    expect(db.getDeployRequestStatus(req.id)).toBe('execution_failed');
  });

  it('payload_missing removes the revert dir (nothing was submitted)', async () => {
    const req = await validate();
    fs.rmSync(req.payloadPath!);
    const result = jsonOf(await execute(req.code));
    expect(result.error_message).toContain('missing from disk');
    expect(realDeploys).toBe(0);
    expect(fs.existsSync(revertDir(req.id))).toBe(false);
    // Nothing ran, so no target_check note may say it "ran" unverified.
    expect(result.target_check).toBeUndefined();
  });

  it('outcome unknown (checkDeployStatus never done) keeps the dir with outcome:"unknown" — and the next validate keeps it', async () => {
    config.deploy.deployTimeoutMs = 40;
    const req = await validate();
    const dir = revertDir(req.id);
    realMode = 'never';
    const result = jsonOf(await execute(req.code));
    expect(cancels).toBe(1);
    expect(result.deployed).toBe(false);
    expect(result.error_message).toContain('did not complete');
    expect(result.revert_package).toMatchObject({
      dir,
      outcome: 'unknown',
      restores: [{ type: 'ApexClass', api_name: 'Foo', content_file: path.join(dir, 'classes', 'Foo.cls') }],
      plan: path.join(dir, 'revert-plan.json'),
    });
    // The existing "check the org" note names where the pre-images are.
    expect(result.note).toContain('Setup → Deployment Status');
    expect(result.note).toContain(dir);

    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8'));
    expect(plan).toMatchObject({
      request_id: req.id,
      executed_at: null,
      outcome: 'unknown',
      deploy_id: '0Af-real-1',
    });
    expect(plan.note).toBe(
      `Contrail lost track of this deploy (${result.error_message}); check Setup → Deployment ` +
        'Status. If it committed, these files are what the org held when this package was validated.',
    );
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain('Before submitting this deploy (whose outcome Contrail lost track of');
    expect(readme.trimEnd().endsWith(plan.note)).toBe(true);
    expect(audits('deploy.revert_written').map((e) => e.detail)).toEqual([
      expect.objectContaining({ requestId: req.id, outcome: 'unknown' }),
    ]);
    expect(db.getDeployRequestStatus(req.id)).toBe('execution_failed');
    expect(db.findRequestByCode(connId, 'deploy', req.code)!.resultJson ?? '').not.toContain(req.code);
    expectCodeNowhere(req.code, [dir]);

    // execution_failed WITH a plan is treated like executed: it survives the sweep.
    config.deploy.deployTimeoutMs = DEFAULT_CONFIG.deploy.deployTimeoutMs;
    await validate();
    expect(fs.existsSync(path.join(dir, 'revert-plan.json'))).toBe(true);
    expect(audits('deploy.revert_swept')).toHaveLength(0);
  });

  it('a live check that was unavailable at validate yields revert_package null + a revert_note — never a snapshot revert', async () => {
    retrieveMode = 'fault';
    const req = await validate();
    expect(fs.existsSync(revertDir(req.id))).toBe(false);
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.revert_package).toBeNull();
    expect(result.revert_note).toContain('unavailable when this deploy was validated (retrieve_failed:');
    expect(result.revert_note).toContain('does not build a revert from the local snapshot');
    expect(fs.existsSync(revertDir(req.id))).toBe(false);
    expect(audits('deploy.revert_written')).toHaveLength(0);
  });

  it('a newer validation (supersede) removes the earlier request’s revert dir', async () => {
    const first = await validate();
    expect(fs.existsSync(revertDir(first.id))).toBe(true);
    const second = await validate();
    expect(db.getDeployRequestStatus(first.id)).toBe('superseded');
    expect(fs.existsSync(revertDir(first.id))).toBe(false);
    expect(fs.existsSync(first.payloadPath!)).toBe(false);
    expect(fs.existsSync(revertDir(second.id))).toBe(true);
  });

  it('an expired code (claimCode) and a locked one remove their revert dirs', async () => {
    const expiring = await validate();
    await backdateExpiry(expiring.id);
    const refused = await execute(expiring.code);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('expired');
    expect(fs.existsSync(revertDir(expiring.id))).toBe(false);
    // The lazy expiry also removes the frozen zip (the pre-existing leak).
    expect(fs.existsSync(expiring.payloadPath!)).toBe(false);

    const locking = await validate();
    for (let i = 0; i < config.deploy.maxFailedAttempts; i++) await execute('ZZZZ-ZZZZ');
    expect(db.getDeployRequestStatus(locking.id)).toBe('locked');
    expect(fs.existsSync(revertDir(locking.id))).toBe(false);
    expect(realDeploys).toBe(0);
  });

  it('an expired code is refused the same way whether claimCode expired it lazily or the sweep did eagerly — code_expired', async () => {
    const conn = db.getConnection(connId) as ConnectionRecord;
    const engine = deps.deploys as unknown as {
      executeDeploy(c: ConnectionRecord, code: string): Promise<unknown>;
    };
    const refusalOf = async (code: string): Promise<{ code?: string; message: string }> => {
      try {
        await engine.executeDeploy(conn, code);
      } catch (err) {
        return err as { code?: string; message: string };
      }
      throw new Error('expected the expired code to be refused');
    };
    const expected =
      'That confirmation code expired at 2020-01-01T00:00:00.000Z. Validate again for a fresh one.';

    // Lazy: still 'validated' past expires_at — claimCode expires it.
    const lazy = await validate();
    await backdateExpiry(lazy.id);
    const lazyRefusal = await refusalOf(lazy.code);
    expect(lazyRefusal).toMatchObject({ code: 'code_expired', message: expected });
    expect(db.getDeployRequestStatus(lazy.id)).toBe('expired');
    expect(fs.existsSync(lazy.payloadPath!)).toBe(false);
    // Re-sending it meets the row already 'expired': the same refusal.
    expect(await refusalOf(lazy.code)).toMatchObject({ code: 'code_expired', message: expected });

    // Eager: the next validate's sweep (on another connection) expires it first.
    const eager = await validate();
    await backdateExpiry(eager.id);
    await validate(undefined, 'other-org');
    expect(db.getDeployRequestStatus(eager.id)).toBe('expired');
    expect(await refusalOf(eager.code)).toMatchObject({ code: 'code_expired', message: expected });
    const viaTool = await execute(eager.code);
    expect(viaTool.isError).toBe(true);
    expect(textOf(viaTool)).toBe(expected);

    expect(realDeploys).toBe(0);
    const refusals = audits('deploy.refused').map((e) => e.detail);
    expect(refusals).toHaveLength(4);
    for (const d of refusals) expect(d).toMatchObject({ reason: 'code_expired' });
  });

  it('a never-executed validation past its expiry is expired by the next validate on a DIFFERENT connection — row, zip and pre-images', async () => {
    const stale = await validate();
    await backdateExpiry(stale.id);
    expect(fs.existsSync(stale.payloadPath!)).toBe(true);
    expect(fs.existsSync(revertDir(stale.id))).toBe(true);

    await validate(undefined, 'other-org');
    expect(db.getDeployRequestStatus(stale.id)).toBe('expired');
    expect(fs.existsSync(stale.payloadPath!)).toBe(false);
    expect(fs.existsSync(revertDir(stale.id))).toBe(false);
    expect(audits('deploy.expired').map((e) => e.detail)).toEqual([
      expect.objectContaining({ count: 1, requestIds: [stale.id] }),
    ]);
    expect(audits('deploy.revert_swept').map((e) => e.detail)).toContainEqual({
      requestId: stale.id,
      reason: 'expired',
    });
    expectCodeNowhere(stale.code);
  });

  it('D4: the lazy expiry removes the frozen zip, refuses code_expired, and the code is in no audit row', async () => {
    const lazy = await validate();
    await backdateExpiry(lazy.id);
    const first = await execute(lazy.code);
    expect(first.isError).toBe(true);
    expect(textOf(first)).toBe(
      'That confirmation code expired at 2020-01-01T00:00:00.000Z. Validate again for a fresh one.',
    );
    expect(fs.existsSync(lazy.payloadPath!)).toBe(false);
    expect(db.getDeployRequestStatus(lazy.id)).toBe('expired');
    expectCodeNowhere(lazy.code);
  });

  it('a non-request entry under _reverts survives the sweep (only UUID-named directories are revert packages)', async () => {
    fs.mkdirSync(path.join(revertsRoot(), 'notes-from-the-user'), { recursive: true });
    fs.writeFileSync(path.join(revertsRoot(), 'notes-from-the-user', 'keep.txt'), 'keep me');
    fs.writeFileSync(path.join(revertsRoot(), 'loose-file.txt'), 'keep me too');
    await validate();
    expect(fs.readFileSync(path.join(revertsRoot(), 'notes-from-the-user', 'keep.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(revertsRoot(), 'loose-file.txt'), 'utf8')).toBe('keep me too');
    expect(audits('deploy.revert_swept')).toHaveLength(0);
  });

  it('a `_reverts` swapped for a link MID-SWEEP stops the sweep: nothing outside staging is removed', async () => {
    const orphanName = randomUUID();
    fs.mkdirSync(path.join(revertsRoot(), orphanName), { recursive: true });
    fs.writeFileSync(path.join(revertsRoot(), orphanName, 'x.cls'), 'x');
    // Outside staging: a directory with the SAME name the sweep already read.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    fs.mkdirSync(path.join(outside, orphanName));
    fs.writeFileSync(path.join(outside, orphanName, 'precious.txt'), 'keep me');
    const aside = path.join(tmp, 'staging', '_reverts_aside');
    // The test hook: the sweep's per-entry status read swaps _reverts for a
    // junction to `outside` — after the entries were read and checked.
    const original = db.getDeployRequestStatus.bind(db);
    let swapped = false;
    const spy = vi.spyOn(db, 'getDeployRequestStatus').mockImplementation((id: string) => {
      if (id === orphanName && !swapped) {
        swapped = true;
        fs.renameSync(revertsRoot(), aside);
        fs.symlinkSync(outside, revertsRoot(), 'junction');
      }
      return original(id);
    });
    try {
      const result = await client.callTool({
        name: 'validate_deploy',
        arguments: {
          connection: 'rev-org',
          components: [{ type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED }],
        },
      });
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(swapped).toBe(true);
      expect(fs.readFileSync(path.join(outside, orphanName, 'precious.txt'), 'utf8')).toBe('keep me');
      expect(fs.existsSync(path.join(aside, orphanName, 'x.cls'))).toBe(true);
      expect(audits('deploy.revert_swept')).toHaveLength(0);
    } finally {
      spy.mockRestore();
      if (fs.lstatSync(revertsRoot(), { throwIfNoEntry: false })?.isSymbolicLink()) {
        fs.unlinkSync(revertsRoot());
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the sweep: retention by plan age, orphans, execution_failed without a plan; links are never followed; validated stays', async () => {
    // A: executed, back-dated past retention. B: executed, fresh.
    const a = await validate();
    jsonOf(await execute(a.code));
    const b = await validate();
    jsonOf(await execute(b.code));
    for (const target of [path.join(revertDir(a.id), 'revert-plan.json'), revertDir(a.id)]) {
      backdate(target, config.deploy.revertRetentionDays + 1);
    }
    // C: an org-reported failure whose dir was left behind (no plan).
    const c = await validate();
    realMode = 'fail';
    jsonOf(await execute(c.code));
    realMode = 'ok';
    fs.mkdirSync(revertDir(c.id), { recursive: true });
    fs.writeFileSync(path.join(revertDir(c.id), 'leftover.txt'), 'x');
    // An orphan with no request row at all.
    const orphan = revertDir(randomUUID());
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'x.cls'), 'x');
    // A planted link (junction on Windows) to a directory outside staging.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    const link = path.join(revertsRoot(), 'planted');
    fs.symlinkSync(outside, link, 'junction');
    // D: a pending validation on the other connection.
    const d = await validate(undefined, 'other-org');

    try {
      const e = await validate();
      expect(fs.existsSync(revertDir(a.id))).toBe(false);
      expect(fs.existsSync(path.join(revertDir(b.id), 'revert-plan.json'))).toBe(true);
      expect(fs.existsSync(revertDir(c.id))).toBe(false);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(revertDir(d.id))).toBe(true);
      expect(db.getDeployRequestStatus(d.id)).toBe('validated');
      expect(fs.existsSync(revertDir(e.id))).toBe(true);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');

      const swept = audits('deploy.revert_swept').map((ev) => ev.detail);
      expect(swept).toEqual(
        expect.arrayContaining([
          { requestId: a.id, reason: 'retention' },
          { requestId: c.id, reason: 'execution_failed' },
          { requestId: path.basename(orphan), reason: 'no_request' },
        ]),
      );
      expect(swept).toHaveLength(3);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a dry run never sweeps: a stale validated row stays validated and an orphan stays put', async () => {
    const stale = await validate();
    await backdateExpiry(stale.id);
    const orphan = revertDir(randomUUID());
    fs.mkdirSync(orphan, { recursive: true });
    const dry = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'other-org',
        components: [{ type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED }],
        dry_run: true,
      },
    });
    expect(dry.isError, textOf(dry)).not.toBe(true);
    expect(db.getDeployRequestStatus(stale.id)).toBe('validated');
    expect(fs.existsSync(revertDir(stale.id))).toBe(true);
    expect(fs.existsSync(stale.payloadPath!)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(true);
    expect(audits('deploy.expired')).toHaveLength(0);
    expect(audits('deploy.revert_swept')).toHaveLength(0);
  });

  it('revertRetentionDays: 0 keeps executed packages forever; orphans are still swept', async () => {
    config.deploy.revertRetentionDays = 0;
    const a = await validate();
    jsonOf(await execute(a.code));
    for (const target of [path.join(revertDir(a.id), 'revert-plan.json'), revertDir(a.id)]) {
      backdate(target, 400);
    }
    const orphan = revertDir(randomUUID());
    fs.mkdirSync(orphan, { recursive: true });
    await validate();
    expect(fs.existsSync(path.join(revertDir(a.id), 'revert-plan.json'))).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(audits('deploy.revert_swept').map((e) => e.detail)).toEqual([
      { requestId: path.basename(orphan), reason: 'no_request' },
    ]);
  });
});

describe('S45 F4: revert containment — a `_reverts` (or `_reverts/<id>`) link is never followed', () => {
  const staging = () => path.join(tmp, 'staging');

  it('`_reverts` linked to staging itself or to a project folder in it: the sweep deletes nothing and a validate still issues its code', async () => {
    for (const target of ['self', 'project'] as const) {
      // A UUID-named folder (the only names the sweep would ever remove) in
      // the user's own staging space.
      const project = path.join(staging(), 'clientA');
      const victimName = randomUUID();
      const victim =
        target === 'self' ? path.join(staging(), victimName) : path.join(project, victimName);
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, 'deliverable.txt'), 'keep me');
      fs.rmSync(revertsRoot(), { recursive: true, force: true });
      fs.symlinkSync(target === 'self' ? staging() : project, revertsRoot(), 'junction');
      try {
        const before = presentedPages.length;
        const result = await client.callTool({
          name: 'validate_deploy',
          arguments: {
            connection: 'rev-org',
            components: [{ type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED }],
          },
        });
        expect(result.isError, textOf(result)).not.toBe(true);
        expect(presentedPages.length).toBe(before + 1);
        const code = codeFromPage(presentedPages[presentedPages.length - 1]!);
        const req = db.findRequestByCode(connId, 'deploy', code)!;
        const pre = JSON.parse(req.summaryJson).revert_preimages as { error?: string };
        expect(pre.error).toMatch(/not a real directory directly under/);
        expect(fs.readFileSync(path.join(victim, 'deliverable.txt'), 'utf8')).toBe('keep me');
        expect(fs.existsSync(path.join(staging(), req.id))).toBe(false);
        expect(fs.existsSync(path.join(project, req.id))).toBe(false);
        expect(audits('deploy.revert_swept')).toHaveLength(0);
      } finally {
        fs.unlinkSync(revertsRoot());
      }
    }
  });

  it('(1) a junction at _reverts before the first validate: nothing is written through it, the deploy runs with no revert package', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    fs.mkdirSync(staging(), { recursive: true });
    fs.rmSync(revertsRoot(), { recursive: true, force: true });
    fs.symlinkSync(outside, revertsRoot(), 'junction');
    try {
      const req = await validate();
      expect(fs.readdirSync(outside)).toEqual(['precious.txt']);
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.revert_package).toBeNull();
      expect(result.revert_note).toMatch(/could not write the pre-image files/);
      await validate();
      expect(fs.readdirSync(outside)).toEqual(['precious.txt']);
      expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    } finally {
      fs.unlinkSync(revertsRoot());
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('(2) `_reverts` swapped for a junction after validate: the plan and README are never written through it', async () => {
    const req = await validate();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    const moved = path.join(outside, 'moved');
    fs.cpSync(revertsRoot(), moved, { recursive: true });
    fs.rmSync(revertsRoot(), { recursive: true, force: true });
    fs.symlinkSync(moved, revertsRoot(), 'junction');
    try {
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.revert_package).toBeNull();
      expect(result.revert_note).toMatch(/could not finalize/);
      expect(fs.existsSync(path.join(moved, req.id, 'revert-plan.json'))).toBe(false);
      expect(fs.existsSync(path.join(moved, req.id, 'README.txt'))).toBe(false);
    } finally {
      fs.unlinkSync(revertsRoot());
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('(3) same swap, then a newer validation: the superseded package is not removed through the link, nothing new is written there', async () => {
    const first = await validate();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    const moved = path.join(outside, 'moved');
    fs.cpSync(revertsRoot(), moved, { recursive: true });
    fs.rmSync(revertsRoot(), { recursive: true, force: true });
    fs.symlinkSync(moved, revertsRoot(), 'junction');
    try {
      const second = await validate();
      expect(db.getDeployRequestStatus(first.id)).toBe('superseded');
      expect(fs.existsSync(path.join(moved, first.id, 'classes', 'Foo.cls'))).toBe(true);
      expect(fs.readdirSync(moved)).toEqual([first.id]);
      expect(fs.existsSync(path.join(moved, second.id))).toBe(false);
    } finally {
      fs.unlinkSync(revertsRoot());
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('(4) a junction AT _reverts/<id>: the package reports "no longer under" and nothing is written through it', async () => {
    const req = await validate();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-revert-outside-'));
    fs.rmSync(revertDir(req.id), { recursive: true, force: true });
    fs.symlinkSync(outside, revertDir(req.id), 'junction');
    try {
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.revert_package).toBeNull();
      expect(result.revert_note).toMatch(/are no longer under/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(revertDir(req.id));
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

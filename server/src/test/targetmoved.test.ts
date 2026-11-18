import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { hhmm } from '../deploy/preimage.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { DeployRequestRecord } from '../core/types.js';

/**
 * S45 F2: the execute-time "target moved" guard. A synchronous read-only peek
 * decides whether it runs (wrong codes still meet claimCode's accounting);
 * for a deploy it runs INSIDE the deploy-exec:<requestId> job ahead of the
 * claim and RETURNS terminal results; DML and activation run it inline. A
 * moved target voids the code with the verbatim refusal stored as its result
 * (re-sending the code replays it); a member the org cannot enumerate, or
 * whose validate-time stamp is missing, is unchecked — never a void; the
 * degrade path anchors on the ORG clock; an unreadable org FAILS OPEN WITH
 * DISCLOSURE (target_check unavailable + audit), Ryley's 2026-11-14 call.
 *
 * S46 D1.4: the guard re-reads each member from the stamp source recorded at
 * validate — the listing, or (CustomField, ValidationRule, CustomLabel,
 * ListView) the member's own stamp query; a request validated by 0.39, which
 * recorded no source, is re-listed. A failed stamp query is member-level
 * unchecked, never a void and never the whole check.
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
const FOO_DATE = '2026-11-10T09:30:00.000Z';

const FOO_PROPOSED = 'public class Foo {\n    public static Integer one() { return 1; }\n}\n';
const FOO_LIVE = 'public class Foo {\n    public static Integer one() { return 0; }\n}\n';
const APEX_META = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass ${MD}>\n    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
const BOT_V1_LIVE = '<botVersions>\n        <fullName>v1</fullName>\n        <botDialogs/>\n    </botVersions>';
const MYBOT = `<?xml version="1.0" encoding="UTF-8"?>\n<Bot ${MD}>\n    ${BOT_V1_LIVE}\n    <label>MyBot</label>\n</Bot>\n`;
const BOT_V1_PROPOSED =
  '<botVersions>\n        <fullName>v1</fullName>\n        <botDialogs/>\n        <description>new</description>\n    </botVersions>';
const ADMIN_LIVE = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile ${MD}>\n    <custom>false</custom>\n</Profile>\n`;
const ADMIN_PROPOSED = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile ${MD}>\n    <custom>false</custom>\n    <description>x</description>\n</Profile>\n`;

const STATUS_FIELD = `<fields>\n        <fullName>Status__c</fullName>\n        <type>Text</type>\n    </fields>`;
/**
 * S46 D1: a parent document as a child-typed retrieve returns it — only the
 * blocks the manifest named, none of the object's own elements.
 */
const partialObject = (...blocks: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
  blocks.map((b) => `    ${b}\n`).join('') +
  '</CustomObject>\n';
/** The stamp Invoice__c.Status__c carries when a test validates it as present. */
const FIELD_DATE = '2026-11-08T14:00:00.000Z';

const ACCT = '001000000000001AAA';
const ACCT2 = '001000000000002AAA';
const LONG_DESCRIPTION = 'x'.repeat(1000);

/** One row a stamp query can return (probeRows is keyed by the queried sObject). */
interface ProbeRow {
  /** The name column's value: DeveloperName, ValidationName, or a label's Name. */
  name: string;
  /** EntityDefinition.QualifiedApiName / SobjectType; none for a label. */
  parent?: string;
  /** NamespacePrefix; omitted = null. */
  ns?: string;
  /** LastModifiedDate, as the org writes it. */
  date: string;
  /** LastModifiedBy.Name; null = the row carries no user. */
  by: string | null;
}

/** The stamp queries' name and parent columns per sObject (deploy/stampprobe.ts). */
const PROBE_COLUMNS: Record<string, { name: string; parent: string | null; api: 'tooling' | 'data' }> = {
  CustomField: { name: 'DeveloperName', parent: 'EntityDefinition.QualifiedApiName', api: 'tooling' },
  ValidationRule: { name: 'ValidationName', parent: 'EntityDefinition.QualifiedApiName', api: 'tooling' },
  ExternalString: { name: 'Name', parent: null, api: 'tooling' },
  ListView: { name: 'DeveloperName', parent: 'SobjectType', api: 'data' },
};

let tmp: string;
let db: ContrailDb;
let client: Client;
let config: ContrailConfig;
let connId: string;
let presentedPages: string[];
let liveFiles: Record<string, string>;
let listRows: Record<string, Array<{ fullName: string; date: string; by: string }>>;
let invalidTypes: Set<string>;
let retrieveMode: 'ok' | 'fault';
let listMode: 'ok' | 'fault' | 'hang' | 'slow';
let store: SnapshotStore;
/**
 * A one-shot gate on the guard's FIRST execute-time org read ('list' =
 * listMetadata, 'query' = REST /query): armed by a test after validate or
 * propose, it optionally holds the read (`hold`) and runs `hook` just before
 * the stub answers — the window between the guard's read and its claim.
 */
let gate: { on: 'list' | 'query'; hold?: Promise<void>; hook?: () => void; entered: boolean } | null;
let omitCreated: boolean;
let realMode: 'ok' | 'fail' | 'never';
let realDeploys: number;
let listCalls: string[];
let probeStarted: boolean;
let accounts: Record<string, Record<string, unknown>>;
/** The decoded SOQL of every Data API query AND every stamp query (Tooling ones included), in order. */
let restQueries: string[];
let restQueryMode: 'ok' | 'fault';
/** S46 D1: the rows the stamp queries answer from, per queried sObject. */
let probeRows: Record<string, ProbeRow[]>;
/** 'fault' = every stamp query answers HTTP 500; 'hang' = a stamp query never answers. */
let probeMode: 'ok' | 'fault' | 'hang';
/** The fetch `init.signal` of every stamp query issued, in order. */
let stampSignals: Array<AbortSignal | null | undefined>;
let dmlWrites: number;
let botVersionRows: Array<{ Id: string; DeveloperName: string; Status: string }>;
let activationPosts: number;

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
         ${opts.checkOnly && omitCreated ? '' : `<createdDate>${CREATED}</createdDate>`}${opts.done ? `<completedDate>${COMPLETED}</completedDate>` : ''}
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

/** The SELECT list and the quoted ids of a stubbed SOQL query. */
function parseSoql(soql: string): { fields: string[]; object: string; ids: string[] } {
  const m = /^SELECT (.+?) FROM (\w+)(.*)$/is.exec(soql);
  if (!m) return { fields: [], object: '', ids: [] };
  return {
    fields: m[1]!.split(',').map((f) => f.trim()),
    object: m[2]!,
    ids: [...m[3]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!),
  };
}

/**
 * S46 D1: answer ONE stamp query from its decoded SOQL — the probeRows of
 * the queried sObject that a WHERE clause names (the name
 * case-insensitively, the parent exactly; nothing is filtered on namespace,
 * as the real queries filter nothing on it). null when the SOQL is not a
 * stamp query. Every stamp query is recorded in restQueries and its fetch
 * signal in stampSignals; probeMode 'fault' answers HTTP 500, 'hang' never
 * answers. A stamp query sent to the wrong API answers as the org does for
 * an sObject that API does not have.
 */
function stampQueryResponse(
  api: 'tooling' | 'data',
  soql: string,
  init?: RequestInit,
): Response | Promise<Response> | null {
  const m =
    /^SELECT Id, (\w+), NamespacePrefix, LastModifiedDate, LastModifiedBy\.Name FROM (\w+) WHERE (.+)$/.exec(
      soql,
    );
  const sobject = m?.[2] ?? '';
  const cols = PROBE_COLUMNS[sobject];
  if (!m || !cols || cols.name !== m[1]) return null;
  restQueries.push(soql);
  stampSignals.push(init?.signal);
  if (probeMode === 'hang') {
    probeStarted = true;
    return new Promise<Response>(() => {});
  }
  if (probeMode === 'fault') return new Response('stamp query down', { status: 500 });
  if (cols.api !== api) {
    return new Response(
      JSON.stringify([{ errorCode: 'INVALID_TYPE', message: `sObject type '${sobject}' is not supported.` }]),
      { status: 400 },
    );
  }
  const valueOf = (clause: string, column: string) =>
    new RegExp(`${column.replace(/\./g, '\\.')} = '([^']*)'`).exec(clause)?.[1];
  const wanted = m[3]!.split(' OR ').map((clause) => ({
    name: valueOf(clause, cols.name)?.toLowerCase(),
    parent: cols.parent === null ? undefined : valueOf(clause, cols.parent),
  }));
  const records = (probeRows[sobject] ?? [])
    .filter((r) => wanted.some((w) => w.name === r.name.toLowerCase() && w.parent === r.parent))
    .map((r, i) => ({
      attributes: { type: sobject },
      Id: `stub-${sobject}-${i}`,
      [cols.name]: r.name,
      NamespacePrefix: r.ns ?? null,
      LastModifiedDate: r.date,
      LastModifiedBy: r.by === null ? null : { Name: r.by },
    }));
  return new Response(JSON.stringify({ done: true, totalSize: records.length, records }));
}

/**
 * The revert.test.ts SOAP idiom (checkOnly + real deploy, pre-image retrieve,
 * listMetadata rows per type with sf:INVALID_TYPE for invalidTypes) plus a
 * listMode for the guard's own read (a fault, or a call that never answers),
 * the stamp queries (Tooling for CustomField / ValidationRule /
 * ExternalString, the Data API for ListView) answered from probeRows under
 * probeMode, and REST routes for DML (Account rows by id, /composite writes)
 * and the activation resource (BotVersion rows, /connect/bot-versions POST).
 */
function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://moved.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DM/005M',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/tooling/query')) {
      const stamp = stampQueryResponse('tooling', new URL(url).searchParams.get('q') ?? '', init);
      if (stamp) return stamp;
      // Everything else on this route is the Aura live check's Tooling read.
      return new Response(JSON.stringify({ done: true, records: [], totalSize: 0 }));
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
        listCalls.push(body);
        if (gate && gate.on === 'list' && !gate.entered) {
          gate.entered = true;
          if (gate.hold) await gate.hold;
          gate.hook?.();
        }
        if (listMode === 'hang') {
          probeStarted = true;
          return new Promise<Response>(() => {});
        }
        if (listMode === 'slow') await new Promise((r) => setTimeout(r, 300));
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
    if (url.includes('/query?q=')) {
      const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));
      const stamp = stampQueryResponse('data', soql, init);
      if (stamp) return stamp;
      restQueries.push(soql);
      if (gate && gate.on === 'query' && !gate.entered) {
        gate.entered = true;
        if (gate.hold) await gate.hold;
        gate.hook?.();
      }
      if (restQueryMode === 'fault') {
        return new Response(JSON.stringify([{ errorCode: 'SERVER_UNAVAILABLE', message: 'down' }]), {
          status: 503,
        });
      }
      const q = parseSoql(soql);
      if (q.object === 'BotVersion') {
        return new Response(
          JSON.stringify({ totalSize: botVersionRows.length, done: true, records: botVersionRows }),
        );
      }
      if (q.object === 'Account') {
        // Like the org: a 15-character id matches its 18-character record,
        // the row carries the 18-character Id, and every field comes back in
        // its CANONICAL casing whatever the SELECT list said.
        const records = Object.keys(accounts)
          .filter((full) => q.ids.some((id) => id === full || id === full.slice(0, 15)))
          .map((id) => {
            const row: Record<string, unknown> = { attributes: { type: 'Account', url: 'x' } };
            for (const f of q.fields) {
              const canon =
                Object.keys(accounts[id]!).find((c) => c.toLowerCase() === f.toLowerCase()) ?? f;
              row[canon] = accounts[id]![canon] ?? null;
            }
            return row;
          });
        return new Response(JSON.stringify({ totalSize: records.length, done: true, records }));
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (url.includes('/composite/sobjects')) {
      dmlWrites += 1;
      if (method === 'DELETE') {
        const ids = new URL(url).searchParams.get('ids')?.split(',') ?? [];
        return new Response(JSON.stringify(ids.map((id) => ({ id, success: true }))));
      }
      const payload = JSON.parse(String(init?.body ?? '{}')) as { records?: unknown[] };
      return new Response(
        JSON.stringify(
          (payload.records ?? []).map((_, i) => ({ id: `001NEW00000000${i}AAA`, success: true })),
        ),
      );
    }
    // Must stay AFTER the more specific /composite/sobjects branch above.
    if (url.endsWith('/composite')) {
      dmlWrites += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        compositeRequest: Array<{ method: string; referenceId: string }>;
      };
      return new Response(
        JSON.stringify({
          compositeResponse: body.compositeRequest.map((sub, i) => ({
            referenceId: sub.referenceId,
            httpStatusCode: sub.method === 'POST' ? 201 : 204,
            body: sub.method === 'POST' ? { id: `001PLAN0000000${i}AAA`, success: true, errors: [] } : null,
          })),
        }),
      );
    }
    const activation = url.match(/\/connect\/bot-versions\/([^/]+)\/activation$/);
    if (activation) {
      if (method === 'POST') activationPosts += 1;
      return new Response(JSON.stringify({ isActivated: false, messages: [], success: true }));
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-moved-'));
  // stagingDir()/deploysDir() — and so every sweep — stay under the temp dir.
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presentedPages = [];
  liveFiles = {
    'classes/Foo.cls': FOO_LIVE,
    'classes/Foo.cls-meta.xml': APEX_META,
    'bots/MyBot.bot': MYBOT,
    'profiles/Admin.profile': ADMIN_LIVE,
  };
  listRows = {
    ApexClass: [{ fullName: 'Foo', date: FOO_DATE, by: 'Bob Baseline' }],
    Profile: [{ fullName: 'Admin', date: '2026-11-04T10:00:00.000Z', by: 'Bob Baseline' }],
    PresenceUserConfig: [{ fullName: 'Voice_Agents', date: '2026-11-09T08:00:00.000Z', by: 'Bob Baseline' }],
  };
  invalidTypes = new Set();
  retrieveMode = 'ok';
  listMode = 'ok';
  omitCreated = false;
  realMode = 'ok';
  realDeploys = 0;
  listCalls = [];
  probeStarted = false;
  accounts = {
    [ACCT]: { Id: ACCT, Name: 'Old Name', Description: LONG_DESCRIPTION, Phone: '555-0100' },
    [ACCT2]: { Id: ACCT2, Name: 'Second', Description: 'two' },
  };
  gate = null;
  restQueries = [];
  restQueryMode = 'ok';
  probeRows = {};
  probeMode = 'ok';
  stampSignals = [];
  dmlWrites = 0;
  botVersionRows = [
    { Id: '0X9000000000001AAA', DeveloperName: 'v1', Status: 'Inactive' },
    { Id: '0X9000000000002AAA', DeveloperName: 'v2', Status: 'Active' },
  ];
  activationPosts = 0;

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  grants.data_read = true;
  grants.data_write = true;
  const conn = db.insertConnection({
    alias: 'moved-org',
    instanceUrl: 'https://moved.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DM',
    orgName: 'moved-org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  connId = conn.id;
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
    // S46 (C): these stubs model no post-execute re-read.
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5, rebaselineAfterDeploy: false },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5, toolWaitMs: 10_000 },
  };
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  const deps = createDeps({
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
  client = new Client({ name: 'targetmoved-test', version: '0.0.0' });
  await client.connect(c);
});

afterEach(async () => {
  vi.useRealTimers();
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

const FOO = { type: 'ApexClass', api_name: 'Foo', content: FOO_PROPOSED };
const NEW_CLS = { type: 'ApexClass', api_name: 'NewCls', content: 'public class NewCls {\n}\n' };
/** S46 D1: a member whose stamp comes from its own query (Tooling CustomField), never the listing. */
const FIELD = { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD };
const FIELD_NAME = { type: 'CustomField', api_name: 'Invoice__c.Status__c' };
/** The one stamp query a package holding FIELD issues, verbatim. */
const FIELD_STAMP_QUERY =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
  "CustomField WHERE (DeveloperName = 'Status' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";
const revertDir = (id: string) => path.join(tmp, 'staging', '_reverts', id);
const audits = (type: string) => db.queryAuditEvents({}).filter((e) => e.eventType === type);
const at = (ms: number) => new Date(Date.parse(CREATED) + ms).toISOString();

/** The confirmation-code invariant: the code (taken from the PAGE) is in no audit row. */
function expectCodeNowhere(code: string): void {
  expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(code);
}

/** Foo in the local snapshot, so the snapshot (degrade) classification is MODIFY. */
function seedFooSnapshot(): void {
  store.writeCurrent(connId, new Map([['classes/Foo.cls', strToU8(FOO_LIVE)]]));
  db.replaceArtifactsForTypes(connId, ['ApexClass'], [
    {
      connectionId: connId,
      type: 'ApexClass',
      apiName: 'Foo',
      filePath: 'classes/Foo.cls',
      contentHash: 'h',
      lastModifiedDate: FOO_DATE,
      lastModifiedBy: 'Bob Baseline',
      retrievedAt: '2026-11-11T00:00:00.000Z',
      content: '',
    },
  ]);
}

/** A deferred the gate holds the guard's read on. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** A real validate; returns the request (with its code) it issued. */
async function validate(
  args: Record<string, unknown> = { components: [FOO] },
): Promise<DeployRequestRecord & { code: string }> {
  const before = presentedPages.length;
  const result = await client.callTool({
    name: 'validate_deploy',
    arguments: { connection: 'moved-org', ...args },
  });
  expect(result.isError, textOf(result)).not.toBe(true);
  expect(presentedPages.length).toBe(before + 1);
  const code = codeFromPage(presentedPages[presentedPages.length - 1]!);
  return { ...db.findRequestByCode(connId, 'deploy', code)!, code };
}

async function execute(code: string) {
  return client.callTool({
    name: 'execute_deploy',
    arguments: { connection: 'moved-org', confirmation_code: code },
  });
}

/** Someone edits Foo in the org after validation. */
function editFoo(date = '2026-11-14T15:04:00.000Z', by = 'Carol Jones'): void {
  listRows.ApexClass = [{ fullName: 'Foo', date, by }];
}

/** FIELD's stamp row as its query returns it (the zone written the way Tooling writes it). */
function fieldRow(date = '2026-11-08T14:00:00.000+0000', by: string | null = 'Bob Baseline', ns?: string): ProbeRow {
  return { name: 'Status', parent: 'Invoice__c', date, by, ...(ns ? { ns } : {}) };
}

/**
 * The org holds FIELD: the child-typed retrieve returns its block (not the
 * proposal's bytes) in a partial container, and its stamp query returns its row.
 */
function fieldInOrg(row: ProbeRow = fieldRow()): void {
  liveFiles['objects/Invoice__c.object'] = partialObject(
    '<fields>\n        <fullName>Status__c</fullName>\n        <label>Status</label>\n        <type>Text</type>\n    </fields>',
  );
  probeRows.CustomField = [row];
}

/** Rewrite a validated request's stored summary, as another build would have written it. */
function rewriteSummary(
  req: DeployRequestRecord,
  edit: (summary: Record<string, any>) => void,
): void {
  const summary = JSON.parse(req.summaryJson) as Record<string, any>;
  edit(summary);
  db.setDeployRequestSummaryJson(req.id, JSON.stringify(summary));
}

describe('S45 F2: deploy — the guard inside the deploy-exec job', () => {
  it('a moved member voids the code: executed:false, target_moved, the refusal names who/when, zip + revert dir gone, audited — never "Deploy errored"', async () => {
    const req = await validate();
    expect(fs.existsSync(req.payloadPath!)).toBe(true);
    expect(fs.existsSync(revertDir(req.id))).toBe(true);
    editFoo();
    const exec = await execute(req.code);
    expect(exec.isError).not.toBe(true);
    expect(textOf(exec)).not.toContain('Deploy errored');
    const result = jsonOf(exec);
    expect(result).toMatchObject({
      executed: false,
      deployed: false,
      target_moved: true,
      moved: [
        {
          type: 'ApexClass',
          api_name: 'Foo',
          state: 'changed',
          last_modified_by: 'Carol Jones',
          last_modified_date: '2026-11-14T15:04:00.000Z',
          frozen_date: FOO_DATE,
        },
      ],
    });
    expect(result.refusal).toBe(
      'TARGET MOVED — not executed, and this code is now void. ' +
        `listMetadata (${hhmm(result.checked_at)}) reports members changed in "moved-org" since ` +
        'this package was validated: ApexClass Foo — last modified by Carol Jones at ' +
        `2026-11-14T15:04:00.000Z (the approval was based on the version last modified at ${FOO_DATE}). ` +
        'The approved diff no longer describes what this deploy would overwrite. Re-run ' +
        'validate_deploy to see the current state and get a fresh code. This check is best-effort: ' +
        'Contrail re-reads the org immediately before claiming the code and compares last-modified ' +
        'stamps, not bytes; a change landing after that read — while the deploy is submitted and ' +
        'processed by the org — is not caught.',
    );
    expect(realDeploys).toBe(0);
    expect(db.getDeployRequestStatus(req.id)).toBe('superseded');
    const stored = db.findRequestByCode(connId, 'deploy', req.code)!;
    expect(JSON.parse(stored.resultJson!)).toEqual(result);
    // The code never leaves the page: not in the result, the stored refusal, or any audit row.
    expect(textOf(exec)).not.toContain(req.code);
    expect(stored.resultJson ?? '').not.toContain(req.code);
    expectCodeNowhere(req.code);
    expect(fs.existsSync(req.payloadPath!)).toBe(false);
    expect(fs.existsSync(revertDir(req.id))).toBe(false);
    const moved = audits('deploy.target_moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.detail).toMatchObject({
      requestId: req.id,
      moved: [{ type: 'ApexClass', api_name: 'Foo', state: 'changed' }],
    });
    // No colleague's name in the audit detail.
    expect(JSON.stringify(moved[0]!.detail)).not.toContain('Carol');
  });

  it('re-sending the voided code replays THAT refusal (code_unusable), never "a newer validation"', async () => {
    const req = await validate();
    editFoo();
    const first = jsonOf(await execute(req.code));
    expect(first.target_moved).toBe(true);
    const again = await execute(req.code);
    expect(again.isError).toBe(true);
    const text = textOf(again);
    expect(text).toBe(`This code was already voided and was not executed — ${first.refusal}`);
    expect(text).toContain('ApexClass Foo — last modified by Carol Jones');
    expect(text).not.toContain('newer validation');
    expect(text).not.toContain(req.code);
    expectCodeNowhere(req.code);
    const refused = audits('deploy.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({
      reason: 'superseded',
      requestId: req.id,
      cause: 'target_moved',
    });
    expect(realDeploys).toBe(0);
  });

  it('two concurrent execute_deploy calls with one code on a moved target: one org read, both refusals name the member', async () => {
    const req = await validate();
    editFoo();
    const listsBefore = listCalls.length;
    const [a, b] = await Promise.all([execute(req.code), execute(req.code)]);
    for (const r of [a, b]) expect(textOf(r)).toContain('ApexClass Foo — last modified by Carol Jones');
    expect(listCalls.length - listsBefore).toBe(1);
    // Both attached to the one deploy-exec job: each got the terminal moved
    // result, neither met claimCode's voided-code replay.
    for (const r of [a, b]) expect(jsonOf(r)).toMatchObject({ executed: false, target_moved: true });
    expect(audits('deploy.refused')).toHaveLength(0);
    expect(realDeploys).toBe(0);
    expect(audits('deploy.target_moved')).toHaveLength(1);
  });

  it("'gone': a validated member the org no longer lists is TARGET MOVED — never re-created unrefused", async () => {
    const req = await validate();
    listRows.ApexClass = [];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.moved).toEqual([
      {
        type: 'ApexClass',
        api_name: 'Foo',
        state: 'gone',
        last_modified_by: null,
        last_modified_date: null,
        frozen_date: FOO_DATE,
      },
    ]);
    expect(result.refusal).toContain(
      `ApexClass Foo — listMetadata no longer reports it (the approval was based on the version last modified at ${FOO_DATE})`,
    );
    expect(realDeploys).toBe(0);
    expect(db.getDeployRequestStatus(req.id)).toBe('superseded');
    expect((audits('deploy.target_moved')[0]!.detail as { moved: Array<{ state: string }> }).moved[0]!.state).toBe('gone');
  });

  it("'created': an ADD whose member the org now lists is TARGET MOVED, attributed to listMetadata", async () => {
    const req = await validate({ components: [NEW_CLS] });
    const summary = JSON.parse(req.summaryJson) as { changes: Array<{ pre_image: { present: boolean } }> };
    expect(summary.changes[0]!.pre_image.present).toBe(false);
    listRows.ApexClass = [
      ...listRows.ApexClass!,
      { fullName: 'NewCls', date: '2026-11-14T15:04:00.000Z', by: 'Carol Jones' },
    ];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.moved).toEqual([
      {
        type: 'ApexClass',
        api_name: 'NewCls',
        state: 'created',
        last_modified_by: 'Carol Jones',
        last_modified_date: '2026-11-14T15:04:00.000Z',
        frozen_date: null,
      },
    ]);
    expect(result.refusal).toContain(
      'ApexClass NewCls — listMetadata now reports it, last modified by Carol Jones at ' +
        '2026-11-14T15:04:00.000Z (the approval was based on the org reporting no such member)',
    );
    expect(result.refusal).not.toContain('version then in the org');
    expect(realDeploys).toBe(0);
  });

  it('stamps compare as epoch ms, never as strings: the same instant written differently is unchanged', async () => {
    const req = await validate();
    listRows.ApexClass = [{ fullName: 'Foo', date: '2026-11-10T09:30:00Z', by: 'Bob Baseline' }];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('ok');
    expect(result.target_check.checked).toContainEqual({ type: 'ApexClass', api_name: 'Foo' });
    expect(audits('deploy.target_moved')).toHaveLength(0);
  });

  it('a listed row with no parseable stamp at execute is unchecked (dates_unavailable_at_execute), never a void', async () => {
    const req = await validate();
    listRows.ApexClass = [{ fullName: 'Foo', date: '', by: 'Bob Baseline' }];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check.unchecked).toEqual([
      { type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_execute' },
    ]);
    expect(audits('deploy.target_moved')).toHaveLength(0);
  });

  it("a guard verdict that outlives the first call's soft-wait is collected by the next poll — not code_unusable", async () => {
    const req = await validate();
    config.deploy.toolWaitMs = 50;
    listMode = 'slow';
    editFoo();
    const first = await execute(req.code);
    expect(first.isError).not.toBe(true);
    expect(jsonOf(first).progress).toBe('re-checking the target org before claiming the code');
    await until(() => db.getDeployRequestStatus(req.id) === 'superseded');
    const poll = await execute(req.code);
    expect(poll.isError, textOf(poll)).not.toBe(true);
    const result = jsonOf(poll);
    expect(result).toMatchObject({ executed: false, target_moved: true });
    expect(result.moved.map((m: { api_name: string }) => m.api_name)).toEqual(['Foo']);
    expect(result.refusal.startsWith('TARGET MOVED')).toBe(true);
    expect(audits('deploy.refused')).toHaveLength(0);
    expect(audits('deploy.target_moved')).toHaveLength(1);
    // Collected once: a further resend meets claimCode's replay.
    const again = await execute(req.code);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('This code was already voided and was not executed — TARGET MOVED');
    expect(realDeploys).toBe(0);
  });

  it("an unchanged target executes and reports target_check {status: 'ok', checked_at, checked, unchecked}", async () => {
    const req = await validate();
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'ok',
      checked: [{ type: 'ApexClass', api_name: 'Foo' }],
      unchecked: [],
    });
    expect(result.target_check.note).toBeUndefined();
    expect(Date.parse(result.target_check.checked_at)).not.toBeNaN();
    expect(audits('deploy.target_moved')).toHaveLength(0);
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
  });

  it('a wrong code with the pre-step still decrements attempts_remaining and audits no_matching_code — no org read', async () => {
    const req = await validate();
    const listsBefore = listCalls.length;
    const wrong = req.code === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH';
    const res = await execute(wrong);
    expect(res.isError).toBe(true);
    const remaining = config.deploy.maxFailedAttempts - 1;
    expect(textOf(res)).toContain(`${remaining} attempt(s) remain`);
    const refused = audits('deploy.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({
      reason: 'no_matching_code',
      attempts_remaining: remaining,
    });
    expect(listCalls.length).toBe(listsBefore);
    expect(db.getDeployRequestStatus(req.id)).toBe('validated');
  });

  it('a poll while the deploy is executing re-attaches to the job — never a second deploy', async () => {
    const req = await validate();
    config.deploy.toolWaitMs = 50;
    realMode = 'never';
    const first = jsonOf(await execute(req.code));
    expect(first.progress).toBeDefined();
    for (let i = 0; i < 100 && db.getDeployRequestStatus(req.id) !== 'executing'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(db.getDeployRequestStatus(req.id)).toBe('executing');
    const second = await execute(req.code);
    expect(second.isError).not.toBe(true);
    expect(textOf(second)).toContain('Deploy is still running');
    // Attached to the live job (its own progress) — not the no-job "already in progress" shape.
    expect(jsonOf(second).progress).not.toBe('a deploy for this code is already in progress');
    expect(realDeploys).toBe(1);
    realMode = 'ok';
    let done: Record<string, any> | null = null;
    for (let i = 0; i < 100 && !done; i++) {
      const r = jsonOf(await execute(req.code));
      if (r.deployed !== undefined) done = r;
    }
    expect(done).toMatchObject({ deployed: true, target_check: { checked: [{ api_name: 'Foo' }] } });
    expect(realDeploys).toBe(1);
    // The guard ran once, inside the job — the polls only re-attached.
    expect(listCalls.filter((b) => b.includes('ApexClass')).length).toBe(2);
  });
});

describe('S45 F2: deploy — what is checked, and what is unchecked', () => {
  it('a member with no validate-time stamp is unchecked while its siblings are still compared', async () => {
    invalidTypes = new Set(['BotVersion']);
    const comps = {
      components: [FOO, { type: 'BotVersion', api_name: 'MyBot.v1', content: BOT_V1_PROPOSED }],
    };
    const req = await validate(comps);
    const listsBefore = listCalls.length;
    const ok = jsonOf(await execute(req.code));
    expect(ok.deployed).toBe(true);
    // Mixed: one member compared, one not — still 'ok' (at least one comparison passed).
    expect(ok.target_check).toMatchObject({
      status: 'ok',
      checked: [{ type: 'ApexClass', api_name: 'Foo' }],
      unchecked: [{ type: 'BotVersion', api_name: 'MyBot.v1', reason: 'dates_unavailable_at_validate' }],
    });
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
    // The unchecked member's type is not even listed at execute.
    expect(listCalls.slice(listsBefore).join('')).not.toContain('BotVersion');

    const again = await validate(comps);
    editFoo();
    const moved = jsonOf(await execute(again.code));
    expect(moved.target_moved).toBe(true);
    expect(moved.moved.map((m: { api_name: string }) => m.api_name)).toEqual(['Foo']);
    expect(moved.unchecked).toEqual([
      { type: 'BotVersion', api_name: 'MyBot.v1', reason: 'dates_unavailable_at_validate' },
    ]);
  });

  it('a Profile modify still gets the date check (presence and dates are reliable; only content is not)', async () => {
    const comps = { components: [{ type: 'Profile', api_name: 'Admin', content: ADMIN_PROPOSED }] };
    const req = await validate(comps);
    const summary = JSON.parse(req.summaryJson) as { changes: Array<{ pre_image: { comparable: boolean } }> };
    expect(summary.changes[0]!.pre_image.comparable).toBe(false);
    listRows.Profile = [{ fullName: 'Admin', date: '2026-11-14T15:06:00.000Z', by: 'Dana Admin' }];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.refusal).toContain(
      'Profile Admin — last modified by Dana Admin at 2026-11-14T15:06:00.000Z',
    );
  });

  it('an unregistered destructive member: unchanged stamp executes, changed stamp is TARGET MOVED, an unenumerable type is unchecked', async () => {
    const pkg = {
      components: [FOO],
      destructive: [{ type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
      allow_unregistered_delete: true,
    };
    const unchanged = await validate(pkg);
    const ok = jsonOf(await execute(unchanged.code));
    expect(ok.deployed).toBe(true);
    expect(ok.target_check.checked).toContainEqual({ type: 'PresenceUserConfig', api_name: 'Voice_Agents' });

    const changed = await validate(pkg);
    listRows.PresenceUserConfig = [
      { fullName: 'Voice_Agents', date: '2026-11-14T15:07:00.000Z', by: 'Eve Ops' },
    ];
    const moved = jsonOf(await execute(changed.code));
    expect(moved.target_moved).toBe(true);
    expect(moved.refusal).toContain('PresenceUserConfig Voice_Agents — last modified by Eve Ops');

    const unenumerable = await validate(pkg);
    invalidTypes = new Set(['PresenceUserConfig']);
    const unchecked = jsonOf(await execute(unenumerable.code));
    expect(unchecked.deployed).toBe(true);
    expect(unchecked.target_check.unchecked).toEqual([
      { type: 'PresenceUserConfig', api_name: 'Voice_Agents', reason: 'type_not_enumerable' },
    ]);
    expect(unchecked.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
  });
});

describe('S45 F2: the guard window — the code invariants hold while the org read is in flight', () => {
  const wrongFor = (code: string) => (code === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH');

  it('(c) lost void race: a claim landing during a MOVED verdict wins — in progress, never TARGET MOVED', async () => {
    const req = await validate();
    editFoo();
    gate = {
      on: 'list',
      entered: false,
      hook: () => {
        // Another process claims the code between the guard's read and its void.
        expect(db.claimRequestForExecution(req.id)).toBe(true);
      },
    };
    const exec = await execute(req.code);
    expect(exec.isError, textOf(exec)).not.toBe(true);
    const result = jsonOf(exec);
    expect(result.progress).toBe('a deploy for this code is already in progress');
    expect(result.target_moved).toBeUndefined();
    expect(db.getDeployRequestStatus(req.id)).toBe('executing');
    expect(audits('deploy.target_moved')).toHaveLength(0);
    expect(fs.existsSync(req.payloadPath!)).toBe(true);
    expect(fs.existsSync(revertDir(req.id))).toBe(true);
    expect(realDeploys).toBe(0);
  });

  it('(d) a void landing during a PASSING guard: the claim refuses with the stored refusal, nothing deploys', async () => {
    const req = await validate();
    gate = {
      on: 'list',
      entered: false,
      hook: () => {
        db.voidRequestWithResult(
          req.id,
          JSON.stringify({ executed: false, target_moved: true, refusal: 'R' }),
        );
      },
    };
    const exec = await execute(req.code);
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toBe('This code was already voided and was not executed — R');
    expect(realDeploys).toBe(0);
  });

  it('(a) wrong codes that lock the request while the guard reads: the gated call is refused, never executed', async () => {
    const req = await validate();
    const held = deferred();
    gate = { on: 'list', entered: false, hold: held.promise };
    const pending = execute(req.code);
    await until(() => gate!.entered);
    for (let i = 0; i < config.deploy.maxFailedAttempts; i++) await execute(wrongFor(req.code));
    expect(db.getDeployRequestStatus(req.id)).toBe('locked');
    held.release();
    const exec = await pending;
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain('locked');
    expect(realDeploys).toBe(0);
    expectCodeNowhere(req.code);
  });

  it('(b) the code expiring while the guard reads: the D4 code_expired refusal, and the zip is removed', async () => {
    const req = await validate();
    const held = deferred();
    gate = { on: 'list', entered: false, hold: held.promise };
    const pending = execute(req.code);
    await until(() => gate!.entered);
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(tmp, 'test.db'));
    raw
      .prepare(`UPDATE deploy_requests SET expires_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', req.id);
    raw.close();
    held.release();
    const exec = await pending;
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toBe(
      'That confirmation code expired at 2020-01-01T00:00:00.000Z. Validate again for a fresh one.',
    );
    expect(fs.existsSync(req.payloadPath!)).toBe(false);
    expect(db.getDeployRequestStatus(req.id)).toBe('expired');
    expect(realDeploys).toBe(0);
  });

  it('(e) DML: a caller gated in the re-query while another executes the same code gets that stored result', async () => {
    const { code } = await proposeDml(UPDATE_ACCT);
    const held = deferred();
    gate = { on: 'query', entered: false, hold: held.promise };
    const a = executeDml(code);
    await until(() => gate!.entered);
    const b = jsonOf(await executeDml(code));
    expect(b.executed).toBe(true);
    held.release();
    const resA = jsonOf(await a);
    expect(resA.already_completed).toBe(true);
    expect(resA.executed).toBe(true);
    expect(dmlWrites).toBe(1);
  });
});

describe("S45 F2: deploy — 'not_checked' whenever nothing was compared", () => {
  it('the validate-time listing faulted (stamps unavailable) and the member was edited since: not_checked, audited nothing_compared, the deploy runs', async () => {
    listMode = 'fault';
    const req = await validate();
    const summary = JSON.parse(req.summaryJson) as { live_check: { status: string; dates_unavailable?: string } };
    expect(summary.live_check.status).toBe('ok');
    expect(summary.live_check.dates_unavailable).toContain('list blew up');
    listMode = 'ok';
    editFoo('2026-11-14T15:04:00.000Z', 'Carol Jones');
    const result = jsonOf(await execute(req.code));
    // The plan's unchecked rule: never a void — but never 'ok' either.
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      unchecked: [{ type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_validate' }],
      note:
        "No member could be compared (each one's reason is under unchecked), so this write ran " +
        'without a target check.',
    });
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: req.id, kind: 'deploy', reason: 'nothing_compared' },
    ]);
  });

  it('a package of only members the guard cannot compare (unenumerable types) is not_checked', async () => {
    invalidTypes = new Set(['BotVersion', 'PresenceUserConfig']);
    const req = await validate({
      components: [{ type: 'BotVersion', api_name: 'MyBot.v1', content: BOT_V1_PROPOSED }],
      destructive: [{ type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
      allow_unregistered_delete: true,
    });
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('not_checked');
    expect(result.target_check.checked).toEqual([]);
    expect(result.target_check.unchecked).toEqual([
      { type: 'BotVersion', api_name: 'MyBot.v1', reason: 'dates_unavailable_at_validate' },
      { type: 'PresenceUserConfig', api_name: 'Voice_Agents', reason: 'type_not_enumerable' },
    ]);
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail?.reason)).toEqual([
      'nothing_compared',
    ]);
  });
});

describe('S45 F2: deploy — the ORG-clock fallback when no live baseline exists', () => {
  it('with no live baseline: a non-ADD member missing from the listing is unchecked (absent_no_baseline), an ADD missing is checked', async () => {
    seedFooSnapshot();
    retrieveMode = 'fault';
    const req = await validate({ components: [FOO, NEW_CLS] });
    const summary = JSON.parse(req.summaryJson) as { changes: Array<{ api_name: string; change: string }> };
    expect(summary.changes.map((c) => [c.api_name, c.change])).toEqual([
      ['Foo', 'modify'],
      ['NewCls', 'add'],
    ]);
    listRows.ApexClass = [];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.unchecked).toEqual([
      { type: 'ApexClass', api_name: 'Foo', reason: 'absent_no_baseline' },
    ]);
    // S46 D4: marked absent — no stamp was compared, and (no live baseline)
    // nothing read the org at validate either.
    expect(result.target_check.checked).toEqual([
      { type: 'ApexClass', api_name: 'NewCls', absent: true },
    ]);
    expect(result.target_check.status).toBe('ok');
  });

  it('pins the 5 s margin around the checkOnly createdDate: +30 s and −3 s refuse, −10 s and −30 s execute', async () => {
    retrieveMode = 'fault';
    const cases: Array<[number, boolean]> = [
      [30_000, true],
      [-30_000, false],
      [-3_000, true],
      [-10_000, false],
    ];
    for (const [offset, refuses] of cases) {
      listRows.ApexClass = [{ fullName: 'Foo', date: FOO_DATE, by: 'Bob Baseline' }];
      const req = await validate();
      const summary = JSON.parse(req.summaryJson) as {
        live_check: { status: string; org_clock?: { created_date: string } };
      };
      expect(summary.live_check.status).toBe('unavailable');
      expect(summary.live_check.org_clock?.created_date).toBe(CREATED);
      editFoo(at(offset), 'Carol Jones');
      const result = jsonOf(await execute(req.code));
      if (refuses) {
        expect(result.target_moved, `offset ${offset}`).toBe(true);
        const refusal = result.refusal as string;
        if (offset >= 0) {
          expect(refusal).toContain(
            `ApexClass Foo — last modified by Carol Jones at ${at(offset)}, after this package was ` +
              `validated at ${CREATED} (no live baseline was captured at validate: retrieve_failed:`,
          );
          expect(refusal).not.toContain('within 5 seconds before');
        } else {
          // Inside the margin BEFORE the org-side validation start: voided,
          // but never described as "after".
          expect(refusal).toContain(
            'reports members changed in "moved-org" since, or within 5 seconds before, this package was validated:',
          );
          expect(refusal).toContain(
            `ApexClass Foo — last modified by Carol Jones at ${at(offset)}, within 5 seconds before ` +
              `this package's org-side validation started at ${CREATED}, too close to rule out that the ` +
              'approved diff missed it (no live baseline was captured at validate: retrieve_failed:',
          );
          expect(refusal).not.toContain('after this package was validated');
        }
        expect(refusal).toContain(
          'Contrail compared against the org-side validation time, minus a 5-second ordering margin)',
        );
        // Every variant names the org-side validation time it compared against.
        expect(refusal).toContain(offset >= 0 ? 'validated at' : 'validation started at');
        for (const bad of ['undefined', 'null', 'based on ']) expect(refusal).not.toContain(bad);
        expect(realDeploys).toBe(0);
      } else {
        expect(result.deployed, `offset ${offset}`).toBe(true);
        expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
        // No live baseline → no revert package, never one built from the snapshot.
        expect(result.revert_package).toBeNull();
      }
      realDeploys = 0;
    }
  });

  it("no org clock → status 'not_checked': every member unchecked, no org read, the deploy executes, audited no_baseline", async () => {
    retrieveMode = 'fault';
    omitCreated = true;
    const req = await validate();
    const summary = JSON.parse(req.summaryJson) as { live_check: { org_clock?: unknown } };
    expect(summary.live_check.org_clock).toBeUndefined();
    const listsBefore = listCalls.length;
    editFoo();
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      unchecked: [{ type: 'ApexClass', api_name: 'Foo', reason: 'live_check_unavailable_no_org_clock' }],
    });
    expect(result.target_check.note).toContain('every member is unchecked');
    expect(listCalls.length).toBe(listsBefore);
    // Recorded like a failed read: the write ran unverified.
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: req.id, kind: 'deploy', reason: 'no_baseline' },
    ]);
  });

  it("a request validated before the live check existed (no live_check) → 'not_checked', executes, audited no_baseline", async () => {
    const req = await validate();
    // Strip live_check (and the pre-images) from the stored summary, as a
    // request validated by an earlier version would have it.
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    delete summary.live_check;
    for (const c of summary.changes) delete c.pre_image;
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(tmp, 'test.db'));
    raw.prepare(`UPDATE deploy_requests SET summary_json = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      req.id,
    );
    raw.close();
    const listsBefore = listCalls.length;
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      unchecked: [{ type: 'ApexClass', api_name: 'Foo', reason: 'live_check_unavailable_no_org_clock' }],
    });
    expect(result.target_check.note).toContain('(no live check was recorded)');
    expect(listCalls.length).toBe(listsBefore);
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: req.id, kind: 'deploy', reason: 'no_baseline' },
    ]);
  });
});

describe('S45 F2: deploy — the guard cannot read the org: FAIL OPEN WITH DISCLOSURE', () => {
  it('a listMetadata fault → the deploy executes with target_check unavailable + the note, audited before the claim', async () => {
    const req = await validate();
    listMode = 'fault';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('unavailable');
    expect(result.target_check.reason).toContain('list blew up');
    expect(result.target_check.note).toBe(
      'Contrail could not re-read the org to confirm nothing had moved before executing ' +
        `(${result.target_check.reason}); this deploy ran against whatever the org held at that ` +
        "moment, and the approval page's diff may not describe what was overwritten.",
    );
    const unavailable = audits('deploy.target_check_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.detail).toEqual({
      requestId: req.id,
      kind: 'deploy',
      reason: result.target_check.reason,
    });
    // The revert README never claims a comparison that did not happen.
    expect(result.revert_package.note).toContain('could not re-read the org to compare last-modified stamps');
  });

  it('the audit row exists even when the deploy itself then fails', async () => {
    const req = await validate();
    listMode = 'fault';
    realMode = 'fail';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(false);
    expect(result.target_check.status).toBe('unavailable');
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail?.requestId)).toEqual([req.id]);
  });

  it('the 15 s deadline (fake timers) → the deploy executes with target_check unavailable', async () => {
    const req = await validate();
    listMode = 'hang';
    config.deploy.toolWaitMs = 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = execute(req.code).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 500 && !probeStarted; i++) await vi.advanceTimersByTimeAsync(1);
    expect(probeStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    for (let i = 0; i < 500 && !settled; i++) await vi.advanceTimersByTimeAsync(1);
    const result = jsonOf(await pending);
    vi.useRealTimers();
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'unavailable',
      reason: 'the org did not answer within 15 s',
    });
    expect(audits('deploy.target_check_unavailable')).toHaveLength(1);
  });
});

describe('S46 D1.4: deploy — a stamp-query member is re-read by its own query, never the listing', () => {
  const REFUSAL_TAIL =
    'The approved diff no longer describes what this deploy would overwrite. Re-run ' +
    'validate_deploy to see the current state and get a fresh code. This check is best-effort: ' +
    'Contrail re-reads the org immediately before claiming the code and compares last-modified ' +
    'stamps, not bytes; a change landing after that read — while the deploy is submitted and ' +
    'processed by the org — is not caught.';
  const NOTHING_COMPARED =
    "No member could be compared (each one's reason is under unchecked), so this write ran " +
    'without a target check.';
  /** Every listMetadata body sent since `from`, joined. */
  const listedSince = (from: number) => listCalls.slice(from).join('');

  it("'changed': the refusal names a Tooling query on CustomField, moved[0].source is set, and CustomField is never listed", async () => {
    fieldInOrg();
    const req = await validate({ components: [FIELD] });
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    expect(summary.changes[0].pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: FIELD_DATE,
      last_modified_by: 'Bob Baseline',
    });
    expect(summary.live_check.stamp_scheme).toBe(2);
    const queriesBefore = restQueries.length;
    probeRows.CustomField = [fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
    const exec = await execute(req.code);
    expect(exec.isError).not.toBe(true);
    const result = jsonOf(exec);
    expect(result).toMatchObject({ executed: false, deployed: false, target_moved: true });
    expect(result.moved).toEqual([
      {
        ...FIELD_NAME,
        state: 'changed',
        last_modified_by: 'Carol Jones',
        last_modified_date: '2026-11-14T15:04:00.000Z',
        frozen_date: FIELD_DATE,
        source: 'tooling:CustomField',
      },
    ]);
    expect(result.refusal).toBe(
      'TARGET MOVED — not executed, and this code is now void. ' +
        `A Tooling query on CustomField (${hhmm(result.checked_at)}) reports members changed in ` +
        '"moved-org" since this package was validated: CustomField Invoice__c.Status__c — last ' +
        'modified by Carol Jones at 2026-11-14T15:04:00.000Z (the approval was based on the ' +
        `version last modified at ${FIELD_DATE}). ${REFUSAL_TAIL}`,
    );
    // One query naming the package's own member — at validate and again at
    // execute — and no listMetadata call for the type at either end.
    expect(restQueries.slice(queriesBefore)).toEqual([FIELD_STAMP_QUERY]);
    expect(restQueries.slice(0, queriesBefore)).toEqual([FIELD_STAMP_QUERY]);
    expect(listedSince(0)).not.toContain('CustomField');
    expect(realDeploys).toBe(0);
    expect(db.getDeployRequestStatus(req.id)).toBe('superseded');
    const audited = audits('deploy.target_moved');
    expect(audited).toHaveLength(1);
    expect(audited[0]!.detail).toMatchObject({
      requestId: req.id,
      moved: [{ ...FIELD_NAME, state: 'changed' }],
    });
    expect(JSON.stringify(audited[0]!.detail)).not.toContain('Carol');
    expectCodeNowhere(req.code);
  });

  it("'gone': a dated member whose query now returns no row with its name is TARGET MOVED, attributed to the query", async () => {
    fieldInOrg();
    const req = await validate({ components: [FIELD] });
    probeRows.CustomField = [];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.moved).toEqual([
      {
        ...FIELD_NAME,
        state: 'gone',
        last_modified_by: null,
        last_modified_date: null,
        frozen_date: FIELD_DATE,
        source: 'tooling:CustomField',
      },
    ]);
    expect(result.refusal).toContain(
      `A Tooling query on CustomField (${hhmm(result.checked_at)}) reports members changed in "moved-org"`,
    );
    expect(result.refusal).toContain(
      'CustomField Invoice__c.Status__c — a Tooling query on CustomField no longer reports it ' +
        `(the approval was based on the version last modified at ${FIELD_DATE})`,
    );
    expect(result.refusal).not.toContain('listMetadata');
    expect(listedSince(0)).not.toContain('CustomField');
    expect(realDeploys).toBe(0);
  });

  it("'created': an ADD whose own row the query now returns is TARGET MOVED, attributed to the query", async () => {
    // No block in the retrieve and no row: absent at validate.
    const req = await validate({ components: [FIELD] });
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    expect(summary.changes[0].pre_image).toMatchObject({
      present: false,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    probeRows.CustomField = [fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.moved).toEqual([
      {
        ...FIELD_NAME,
        state: 'created',
        last_modified_by: 'Carol Jones',
        last_modified_date: '2026-11-14T15:04:00.000Z',
        frozen_date: null,
        source: 'tooling:CustomField',
      },
    ]);
    expect(result.refusal).toContain(
      'CustomField Invoice__c.Status__c — a Tooling query on CustomField now reports it, last ' +
        'modified by Carol Jones at 2026-11-14T15:04:00.000Z (the approval was based on the org ' +
        'reporting no such member)',
    );
    expect(listedSince(0)).not.toContain('CustomField');
    expect(realDeploys).toBe(0);
  });

  it('a package moved on both sources: the head names both, each member keeps its own source', async () => {
    fieldInOrg();
    const req = await validate({ components: [FOO, FIELD] });
    const listsBefore = listCalls.length;
    editFoo();
    probeRows.CustomField = [fieldRow('2026-11-14T15:05:00.000+0000', 'Dana Admin')];
    const result = jsonOf(await execute(req.code));
    expect(result.target_moved).toBe(true);
    expect(result.refusal).toContain(
      `listMetadata and a Tooling query on CustomField (${hhmm(result.checked_at)}) report members ` +
        'changed in "moved-org" since this package was validated: ApexClass Foo — last modified by ' +
        'Carol Jones',
    );
    // Package order, whichever source read the member; only the probed one carries `source`.
    expect(result.moved.map((m: Record<string, unknown>) => [m.api_name, m.source])).toEqual([
      ['Foo', undefined],
      ['Invoice__c.Status__c', 'tooling:CustomField'],
    ]);
    // The listing named the listing-sourced type only.
    expect(listedSince(listsBefore)).toContain('<met:type>ApexClass</met:type>');
    expect(listedSince(0)).not.toContain('CustomField');
  });

  it('an unchanged stamp written +0000 at validate and Z at execute is checked (epoch comparison)', async () => {
    fieldInOrg(fieldRow('2026-11-08T14:00:00.000+0000'));
    const req = await validate({ components: [FIELD] });
    probeRows.CustomField = [fieldRow('2026-11-08T14:00:00Z')];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check).toMatchObject({ status: 'ok', unchecked: [] });
    // A stamp comparison — not marked absent.
    expect(result.target_check.checked).toEqual([FIELD_NAME]);
    expect(audits('deploy.target_moved')).toHaveLength(0);
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
  });

  it('an ADD for which the read returns nothing is checked with absent: true — by the query, and by the listing', async () => {
    const field = await validate({ components: [FIELD] });
    const queriesBefore = restQueries.length;
    const viaQuery = jsonOf(await execute(field.code));
    expect(viaQuery.deployed).toBe(true);
    expect(viaQuery.target_check.status).toBe('ok');
    expect(viaQuery.target_check.checked).toEqual([{ ...FIELD_NAME, absent: true }]);
    expect(viaQuery.target_check.unchecked).toEqual([]);
    expect(restQueries.slice(queriesBefore)).toEqual([FIELD_STAMP_QUERY]);

    const cls = await validate({ components: [NEW_CLS] });
    const viaListing = jsonOf(await execute(cls.code));
    expect(viaListing.deployed).toBe(true);
    expect(viaListing.target_check.checked).toEqual([
      { type: 'ApexClass', api_name: 'NewCls', absent: true },
    ]);
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
  });

  it('the 0.39 path: a request with no stamp_scheme and no stamp_source is re-LISTED — no stamp query at execute, and a move reads as 0.39 wrote it', async () => {
    const as039 = (req: DeployRequestRecord): void =>
      rewriteSummary(req, (summary) => {
        delete summary.live_check.stamp_scheme;
        for (const c of [...summary.changes, ...(summary.destructive ?? [])]) {
          delete c.pre_image.stamp_source;
        }
      });
    fieldInOrg();
    const req = await validate({ components: [FIELD] });
    as039(req);
    // 0.39 froze the LISTING's stamp; the stamp query would now say "changed".
    listRows.CustomField = [{ fullName: 'Invoice__c.Status__c', date: FIELD_DATE, by: 'Bob Baseline' }];
    probeRows.CustomField = [fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
    let listsBefore = listCalls.length;
    let queriesBefore = restQueries.length;
    const ok = jsonOf(await execute(req.code));
    expect(ok.deployed).toBe(true);
    expect(ok.target_check).toMatchObject({ status: 'ok', unchecked: [] });
    expect(ok.target_check.checked).toEqual([FIELD_NAME]);
    expect(listedSince(listsBefore)).toContain('<met:type>CustomField</met:type>');
    expect(restQueries.slice(queriesBefore)).toEqual([]);

    // The same request shape with the listing's stamp moved: 0.39's refusal, word for word.
    probeRows.CustomField = [fieldRow()];
    const again = await validate({ components: [FIELD] });
    as039(again);
    listRows.CustomField = [
      { fullName: 'Invoice__c.Status__c', date: '2026-11-14T15:04:00.000Z', by: 'Carol Jones' },
    ];
    listsBefore = listCalls.length;
    queriesBefore = restQueries.length;
    const moved = jsonOf(await execute(again.code));
    expect(moved.target_moved).toBe(true);
    expect(moved.refusal).toBe(
      'TARGET MOVED — not executed, and this code is now void. ' +
        `listMetadata (${hhmm(moved.checked_at)}) reports members changed in "moved-org" since ` +
        'this package was validated: CustomField Invoice__c.Status__c — last modified by Carol ' +
        'Jones at 2026-11-14T15:04:00.000Z (the approval was based on the version last modified ' +
        `at ${FIELD_DATE}). ${REFUSAL_TAIL}`,
    );
    expect(moved.moved[0].source).toBeUndefined();
    expect(listedSince(listsBefore)).toContain('<met:type>CustomField</met:type>');
    expect(restQueries.slice(queriesBefore)).toEqual([]);
  });

  it('a stamp query that fails at execute is member-level unchecked: siblings are still compared, nothing is voided or audited', async () => {
    fieldInOrg();
    const req = await validate({ components: [FOO, FIELD] });
    probeMode = 'fault';
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check.status).toBe('ok');
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(result.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'stamp_query_failed_at_execute' },
    ]);
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
    expect(audits('deploy.target_moved')).toHaveLength(0);
    // Never replaced by the listing.
    expect(listedSince(0)).not.toContain('CustomField');

    // The only member: nothing was compared, and that is audited.
    probeMode = 'ok';
    const alone = await validate({ components: [FIELD] });
    probeMode = 'fault';
    const unverified = jsonOf(await execute(alone.code));
    expect(unverified.deployed).toBe(true);
    expect(unverified.target_check).toMatchObject({
      status: 'not_checked',
      checked: [],
      note: NOTHING_COMPARED,
    });
    expect(unverified.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'stamp_query_failed_at_execute' },
    ]);
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: alone.id, kind: 'deploy', reason: 'nothing_compared' },
    ]);
    expect(listedSince(0)).not.toContain('CustomField');
  });

  it('a stamp-query row with no usable stamp at execute — two rows for the one member, or an unparseable date — is unchecked (dates_unavailable_at_execute), never a void', async () => {
    fieldInOrg();
    const req = await validate({ components: [FOO, FIELD] });
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    expect(summary.changes[1].pre_image).toMatchObject({
      present: true,
      last_modified_date: FIELD_DATE,
    });
    // Two rows for the one target: the probe keeps the row and nulls its stamp.
    probeRows.CustomField = [fieldRow(), fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check.status).toBe('ok');
    // The row is there, so the member is not 'gone'; it carries no stamp, so
    // it is not 'changed' — and it is not counted as checked either.
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(result.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'dates_unavailable_at_execute' },
    ]);
    expect(audits('deploy.target_moved')).toHaveLength(0);

    // One row whose date cannot be read: the same verdict.
    probeRows.CustomField = [fieldRow()];
    const again = await validate({ components: [FOO, FIELD] });
    probeRows.CustomField = [fieldRow('not a date', 'Carol Jones')];
    const unreadable = jsonOf(await execute(again.code));
    expect(unreadable.deployed).toBe(true);
    expect(unreadable.target_moved).toBeUndefined();
    expect(unreadable.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(unreadable.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'dates_unavailable_at_execute' },
    ]);
    expect(audits('deploy.target_moved')).toHaveLength(0);
    expect(realDeploys).toBe(2);
    expect(listedSince(0)).not.toContain('CustomField');
  });

  it('the ORG-clock path treats a stamp-query row with no usable stamp the same way: unchecked — never checked, never absent, never a void', async () => {
    retrieveMode = 'fault';
    probeRows.CustomField = [fieldRow(at(-60_000))];
    const req = await validate({ components: [FOO, FIELD] });
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    expect(summary.live_check).toMatchObject({ status: 'unavailable', stamp_scheme: 2 });
    probeRows.CustomField = [fieldRow(at(-60_000)), fieldRow(at(-50_000), 'Carol Jones')];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(result.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'dates_unavailable_at_execute' },
    ]);
    expect(audits('deploy.target_moved')).toHaveLength(0);
  });

  it("a stamp query that never answers: the 15 s deadline aborts ITS fetch signal and the deploy executes with target_check unavailable", async () => {
    fieldInOrg();
    const req = await validate({ components: [FIELD] });
    probeMode = 'hang';
    config.deploy.toolWaitMs = 60_000;
    const signalsBefore = stampSignals.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = execute(req.code).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 500 && !probeStarted; i++) await vi.advanceTimersByTimeAsync(1);
    expect(probeStarted).toBe(true);
    // The guard's deadline signal reached the stamp query's fetch.
    const signal = stampSignals[signalsBefore];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal!.aborted).toBe(true);
    for (let i = 0; i < 500 && !settled; i++) await vi.advanceTimersByTimeAsync(1);
    const result = jsonOf(await pending);
    vi.useRealTimers();
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'unavailable',
      reason: 'the org did not answer within 15 s',
    });
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: req.id, kind: 'deploy', reason: 'the org did not answer within 15 s' },
    ]);
  });

  it('the ORG-clock path goes through the query too (stamp_scheme with no pre-image): checked before the org clock, TARGET MOVED after it — never the listing', async () => {
    retrieveMode = 'fault';
    probeRows.CustomField = [fieldRow(at(-60_000))];
    const req = await validate({ components: [FIELD] });
    const summary = JSON.parse(req.summaryJson) as Record<string, any>;
    expect(summary.live_check).toMatchObject({
      status: 'unavailable',
      stamp_scheme: 2,
      org_clock: { created_date: CREATED },
    });
    expect(summary.changes[0].pre_image).toBeUndefined();
    let listsBefore = listCalls.length;
    let queriesBefore = restQueries.length;
    const ok = jsonOf(await execute(req.code));
    expect(ok.deployed).toBe(true);
    expect(ok.target_check).toMatchObject({ status: 'ok', unchecked: [] });
    expect(ok.target_check.checked).toEqual([FIELD_NAME]);
    let issued = restQueries.slice(queriesBefore);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.startsWith('SELECT Id, DeveloperName, NamespacePrefix')).toBe(true);
    expect(listedSince(listsBefore)).not.toContain('CustomField');

    // Edited after the org-side validation time: the degrade variant, its subject the query.
    const again = await validate({ components: [FIELD] });
    probeRows.CustomField = [fieldRow(at(30_000), 'Carol Jones')];
    listsBefore = listCalls.length;
    queriesBefore = restQueries.length;
    const moved = jsonOf(await execute(again.code));
    expect(moved.target_moved).toBe(true);
    expect(moved.moved).toEqual([
      {
        ...FIELD_NAME,
        state: 'changed',
        last_modified_by: 'Carol Jones',
        last_modified_date: at(30_000),
        frozen_date: null,
        source: 'tooling:CustomField',
      },
    ]);
    expect(moved.refusal).toContain(
      'TARGET MOVED — not executed, and this code is now void. ' +
        `A Tooling query on CustomField (${hhmm(moved.checked_at)}) reports members changed in ` +
        '"moved-org" since this package was validated: CustomField Invoice__c.Status__c — last ' +
        `modified by Carol Jones at ${at(30_000)}, after this package was validated at ${CREATED} ` +
        '(no live baseline was captured at validate: retrieve_failed:',
    );
    expect(moved.refusal).toContain(
      'Contrail compared against the org-side validation time, minus a 5-second ordering margin)',
    );
    expect(audits('deploy.target_moved')[0]!.detail).toMatchObject({ org_clock_fallback: true });
    issued = restQueries.slice(queriesBefore);
    expect(issued).toEqual([FIELD_STAMP_QUERY]);
    expect(listedSince(0)).not.toContain('CustomField');
    expect(realDeploys).toBe(1);
  });

  it('stamp_source_mismatch: a frozen probe source this build does not read for the type is unchecked — no query, no listing', async () => {
    fieldInOrg();
    const req = await validate({ components: [FOO, FIELD] });
    rewriteSummary(req, (summary) => {
      summary.changes[1].pre_image.stamp_source = 'data:ListView';
    });
    const queriesBefore = restQueries.length;
    // Whatever the query would say is not asked.
    probeRows.CustomField = [fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
    const result = jsonOf(await execute(req.code));
    expect(result.deployed).toBe(true);
    expect(result.target_check.status).toBe('ok');
    expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(result.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'stamp_source_mismatch' },
    ]);
    expect(restQueries.slice(queriesBefore)).toEqual([]);
    expect(listedSince(0)).not.toContain('CustomField');
  });

  it('stamp_not_probeable: a member no stamp query can name that was absent at validate; one that was PRESENT is dates_unavailable_at_validate first', async () => {
    // A destructive CustomField whose name does not end in __c: no query names
    // it, and the parent-container retrieve returned no document for it.
    const gone = { type: 'CustomField', api_name: 'Account.Gone' };
    const absent = await validate({ components: [FOO], destructive: [gone] });
    const absentSummary = JSON.parse(absent.summaryJson) as Record<string, any>;
    expect(absentSummary.destructive[0].pre_image).toMatchObject({
      present: false,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    let queriesBefore = restQueries.length;
    const first = jsonOf(await execute(absent.code));
    expect(first.deployed).toBe(true);
    expect(first.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(first.target_check.unchecked).toEqual([{ ...gone, reason: 'stamp_not_probeable' }]);
    expect(restQueries.slice(queriesBefore)).toEqual([]);

    // A standard field the retrieve DID return: present, undated — caught by
    // the validate-time null date before any routing.
    liveFiles['objects/Account.object'] = partialObject(
      '<fields>\n        <fullName>Industry</fullName>\n        <type>Picklist</type>\n    </fields>',
    );
    const industry = {
      type: 'CustomField',
      api_name: 'Account.Industry',
      content:
        '<fields>\n        <fullName>Industry</fullName>\n        <trackHistory>true</trackHistory>\n        <type>Picklist</type>\n    </fields>',
    };
    const present = await validate({ components: [FOO, industry] });
    const presentSummary = JSON.parse(present.summaryJson) as Record<string, any>;
    expect(presentSummary.changes[1].pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    queriesBefore = restQueries.length;
    const second = jsonOf(await execute(present.code));
    expect(second.deployed).toBe(true);
    expect(second.target_check.unchecked).toEqual([
      { type: 'CustomField', api_name: 'Account.Industry', reason: 'dates_unavailable_at_validate' },
    ]);
    expect(restQueries.slice(queriesBefore)).toEqual([]);
    expect(listedSince(0)).not.toContain('CustomField');
  });

  it('absence at validate is a fact only where the member\'s OWN source answered: a failed stamp query leaves it unchecked; a listing that threw does not', async () => {
    // The type's stamp query failed at validate: "no row" was never read.
    probeMode = 'fault';
    const failed = await validate({ components: [FOO, FIELD] });
    const failedSummary = JSON.parse(failed.summaryJson) as Record<string, any>;
    expect(failedSummary.live_check.dates_unavailable_types).toEqual(['CustomField']);
    expect(failedSummary.changes[1].pre_image).toMatchObject({ present: false });
    probeMode = 'ok';
    let queriesBefore = restQueries.length;
    const first = jsonOf(await execute(failed.code));
    expect(first.deployed).toBe(true);
    expect(first.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(first.target_check.unchecked).toEqual([
      { ...FIELD_NAME, reason: 'dates_unavailable_at_validate' },
    ]);
    expect(restQueries.slice(queriesBefore)).toEqual([]);

    // The LISTING threw at validate: every listing-sourced date is null, but
    // that says nothing about the field's stamp query, which answered.
    listMode = 'fault';
    const listingDown = await validate({ components: [FOO, FIELD] });
    const downSummary = JSON.parse(listingDown.summaryJson) as Record<string, any>;
    expect(downSummary.live_check.dates_unavailable).toContain('list blew up');
    expect(downSummary.live_check.dates_unavailable_types).toEqual([]);
    listMode = 'ok';
    queriesBefore = restQueries.length;
    const second = jsonOf(await execute(listingDown.code));
    expect(second.deployed).toBe(true);
    expect(second.target_check.checked).toEqual([{ ...FIELD_NAME, absent: true }]);
    expect(second.target_check.unchecked).toEqual([
      { type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_validate' },
    ]);
    expect(restQueries.slice(queriesBefore)).toEqual([FIELD_STAMP_QUERY]);
  });

  describe('stamp_row_unmatched — the member\'s name came back only under a namespace the package did not name', () => {
    const STRANGER = fieldRow('2026-11-01T10:00:00.000+0000', 'Pat Packager', 'ns');

    it('an ADD whose query returns only the namespaced row at execute: the deploy runs, the member is unchecked — neither checked nor moved', async () => {
      const req = await validate({ components: [FIELD] });
      const summary = JSON.parse(req.summaryJson) as Record<string, any>;
      expect(summary.changes[0].pre_image).toMatchObject({ present: false });
      expect(summary.live_check.probe_unmatched).toBeUndefined();
      probeRows.CustomField = [STRANGER];
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.target_moved).toBeUndefined();
      expect(result.target_check.unchecked).toEqual([
        { ...FIELD_NAME, reason: 'stamp_row_unmatched' },
      ]);
      expect(result.target_check.checked).toEqual([]);
      // Nothing compared: disclosed like any other unverified write.
      expect(result.target_check.status).toBe('not_checked');
      expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
        { requestId: req.id, kind: 'deploy', reason: 'nothing_compared' },
      ]);
      expect(audits('deploy.target_moved')).toHaveLength(0);
    });

    it("the member's own row beside the namespaced one is still 'created'", async () => {
      const req = await validate({ components: [FIELD] });
      probeRows.CustomField = [STRANGER, fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
      const result = jsonOf(await execute(req.code));
      expect(result.target_moved).toBe(true);
      expect(result.moved).toEqual([
        {
          ...FIELD_NAME,
          state: 'created',
          last_modified_by: 'Carol Jones',
          last_modified_date: '2026-11-14T15:04:00.000Z',
          frozen_date: null,
          source: 'tooling:CustomField',
        },
      ]);
      expect(result.refusal).not.toContain('Pat Packager');
      expect(realDeploys).toBe(0);
    });

    it('unmatched at VALIDATE and no row at all at execute: still stamp_row_unmatched, never absent', async () => {
      probeRows.CustomField = [STRANGER];
      const req = await validate({ components: [FIELD] });
      const summary = JSON.parse(req.summaryJson) as Record<string, any>;
      expect(summary.live_check.probe_unmatched).toEqual(['CustomField:Invoice__c.Status__c']);
      expect(summary.changes[0].pre_image).toMatchObject({ present: false, last_modified_date: null });
      probeRows.CustomField = [];
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.target_check.unchecked).toEqual([
        { ...FIELD_NAME, reason: 'stamp_row_unmatched' },
      ]);
      expect(result.target_check.checked).toEqual([]);
      expect(JSON.stringify(result.target_check)).not.toContain('absent');
    });

    it("unmatched at VALIDATE, and the member's OWN row appears at execute: 'created' — the validate-time set speaks only for a member with no row of its own", async () => {
      probeRows.CustomField = [STRANGER];
      const req = await validate({ components: [FIELD] });
      const summary = JSON.parse(req.summaryJson) as Record<string, any>;
      expect(summary.live_check.probe_unmatched).toEqual(['CustomField:Invoice__c.Status__c']);
      expect(summary.changes[0].pre_image).toMatchObject({ present: false, last_modified_date: null });
      // Created after validate, beside the namespaced row.
      probeRows.CustomField = [STRANGER, fieldRow('2026-11-14T15:04:00.000+0000', 'Carol Jones')];
      const result = jsonOf(await execute(req.code));
      expect(result).toMatchObject({ executed: false, deployed: false, target_moved: true });
      expect(result.moved).toEqual([
        {
          ...FIELD_NAME,
          state: 'created',
          last_modified_by: 'Carol Jones',
          last_modified_date: '2026-11-14T15:04:00.000Z',
          frozen_date: null,
          source: 'tooling:CustomField',
        },
      ]);
      // Its own row was compared: it is not also reported unchecked.
      expect(result.unchecked).toBeUndefined();
      expect(result.refusal).not.toContain('Pat Packager');
      expect(realDeploys).toBe(0);
    });

    it("a frozen, dated member whose query now returns only the namespaced row: stamp_row_unmatched, never 'gone'", async () => {
      fieldInOrg();
      const req = await validate({ components: [FOO, FIELD] });
      probeRows.CustomField = [STRANGER];
      const result = jsonOf(await execute(req.code));
      expect(result.deployed).toBe(true);
      expect(result.target_moved).toBeUndefined();
      expect(result.target_check.checked).toEqual([{ type: 'ApexClass', api_name: 'Foo' }]);
      expect(result.target_check.unchecked).toEqual([
        { ...FIELD_NAME, reason: 'stamp_row_unmatched' },
      ]);
      expect(audits('deploy.target_moved')).toHaveLength(0);
    });
  });
});

// ── DML ──────────────────────────────────────────────────────────────────

async function proposeDml(args: Record<string, unknown>) {
  const before = presentedPages.length;
  const result = await client.callTool({
    name: 'dml_propose',
    arguments: { connection: 'moved-org', ...args },
  });
  expect(result.isError, textOf(result)).not.toBe(true);
  expect(presentedPages.length).toBe(before + 1);
  const code = codeFromPage(presentedPages[presentedPages.length - 1]!);
  return { result, code, request: db.findRequestByCode(connId, 'dml', code)! };
}

async function executeDml(code: string) {
  return client.callTool({
    name: 'dml_execute',
    arguments: { connection: 'moved-org', confirmation_code: code },
  });
}

const UPDATE_ACCT = {
  operation: 'update',
  object: 'Account',
  records: [{ Id: ACCT, Name: 'New Name', Description: 'short' }],
};

describe('S45 F2: DML — the old values the page showed, re-queried', () => {
  it('before/precheck persist at the preview top level, untruncated — and are ABSENT from the propose result', async () => {
    const { result, request } = await proposeDml(UPDATE_ACCT);
    const summary = JSON.parse(request.summaryJson) as Record<string, any>;
    expect(summary.precheck).toBe('ok');
    expect(summary.before).toEqual({ [ACCT]: { Name: 'Old Name', Description: LONG_DESCRIPTION } });
    // Never on the row objects.
    for (const row of summary.rows) expect(row.before).toBeUndefined();
    const shown = jsonOf(result);
    expect(shown.before).toBeUndefined();
    expect(shown.precheck).toBeUndefined();
    expect(shown.found).toBeUndefined();
    expect(textOf(result)).not.toContain('x'.repeat(301));
  });

  it('a changed value → TARGET MOVED with old/new, nothing written, the code void (re-send replays it)', async () => {
    const { code, request } = await proposeDml(UPDATE_ACCT);
    accounts[ACCT]!.Name = 'Changed Elsewhere';
    accounts[ACCT]!.Description = 'y'.repeat(500);
    const exec = await executeDml(code);
    expect(exec.isError).not.toBe(true);
    const result = jsonOf(exec);
    expect(result).toMatchObject({ executed: false, target_moved: true });
    expect(result.refusal).toContain(
      'TARGET MOVED — not executed, and this code is now void. Re-running the preview query at ' +
        `${hhmm(result.checked_at)} shows the records you approved have changed since dml_propose: ` +
        `Account ${ACCT} Name is now "Changed Elsewhere" (the approval showed "Old Name")`,
    );
    expect(result.refusal).toContain('Re-run dml_propose to see the current values and get a fresh code.');
    // Long values are capped in the refusal.
    expect(result.refusal).not.toContain('y'.repeat(200));
    expect(result.refusal).not.toContain('x'.repeat(200));
    expect(dmlWrites).toBe(0);
    expect(db.getDeployRequestStatus(request.id)).toBe('superseded');
    expect(audits('dml.target_moved')).toHaveLength(1);
    expect(JSON.stringify(audits('dml.target_moved')[0]!.detail)).not.toContain('Changed Elsewhere');
    expect(textOf(exec)).not.toContain(code);
    expect(db.findRequestByCode(connId, 'dml', code)!.resultJson ?? '').not.toContain(code);
    expectCodeNowhere(code);

    const again = await executeDml(code);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(`This code was already voided and was not executed — ${result.refusal}`);
    expect(textOf(again)).not.toContain(code);
    expectCodeNowhere(code);
  });

  it('a 15-character id is compared like its 18-character record: delete and update are checked, a field change is TARGET MOVED', async () => {
    const id15 = ACCT.slice(0, 15);
    const del = await proposeDml({ operation: 'delete', object: 'Account', ids: [id15] });
    const delSummary = JSON.parse(del.request.summaryJson) as Record<string, any>;
    expect(delSummary.found).toEqual([id15]);
    expect(delSummary.rows[0].warnings).toEqual([]);
    const deleted = jsonOf(await executeDml(del.code));
    expect(deleted.executed).toBe(true);
    expect(deleted.target_check).toMatchObject({ status: 'ok', checked: [{ object: 'Account', id: id15 }] });

    const upd = await proposeDml({ operation: 'update', object: 'Account', records: [{ Id: id15, Name: 'N' }] });
    expect(JSON.parse(upd.request.summaryJson).before).toEqual({ [id15]: { Name: 'Old Name' } });
    accounts[ACCT]!.Name = 'Edited Elsewhere';
    const moved = jsonOf(await executeDml(upd.code));
    expect(moved.target_moved).toBe(true);
    expect(moved.moved).toEqual([{ object: 'Account', id: id15, field: 'Name', state: 'changed' }]);
    expect(dmlWrites).toBe(1);
  });

  it('field names match case-insensitively: the before-value is kept under the canonical key and compared', async () => {
    const lower = { operation: 'update', object: 'Account', records: [{ Id: ACCT, phone: '555' }] };
    const { code, request } = await proposeDml(lower);
    const summary = JSON.parse(request.summaryJson) as Record<string, any>;
    expect(summary.before).toEqual({ [ACCT]: { Phone: '555-0100' } });
    expect(summary.rows[0].label).toBe(`UPDATE Account ${ACCT}: phone: "555-0100" → "555"`);
    accounts[ACCT]!.Phone = '555-9999';
    const moved = jsonOf(await executeDml(code));
    expect(moved.target_moved).toBe(true);
    expect(moved.moved).toEqual([{ object: 'Account', id: ACCT, field: 'Phone', state: 'changed' }]);
    expect(dmlWrites).toBe(0);

    accounts[ACCT]!.Phone = '555-0100';
    const again = await proposeDml(lower);
    const ok = jsonOf(await executeDml(again.code));
    expect(ok.executed).toBe(true);
    expect(ok.target_check.checked).toContainEqual({ object: 'Account', id: ACCT });
  });

  it("a found record whose approval showed no before-value is unchecked (no_before_value_shown), status 'ok', not audited", async () => {
    const { code, request } = await proposeDml(UPDATE_ACCT);
    const summary = JSON.parse(request.summaryJson) as Record<string, any>;
    summary.before = { [ACCT]: {} };
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(tmp, 'test.db'));
    raw.prepare(`UPDATE deploy_requests SET summary_json = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      request.id,
    );
    raw.close();
    const result = jsonOf(await executeDml(code));
    expect(result.executed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'ok',
      checked: [],
      unchecked: [{ object: 'Account', id: ACCT, reason: 'no_before_value_shown' }],
    });
    expect(audits('deploy.target_check_unavailable')).toHaveLength(0);
    expect(dmlWrites).toBe(1);
  });

  it('the same values → executes, target_check names the record', async () => {
    const { code } = await proposeDml(UPDATE_ACCT);
    const result = jsonOf(await executeDml(code));
    expect(result.executed).toBe(true);
    expect(result.target_check).toMatchObject({
      status: 'ok',
      checked: [{ object: 'Account', id: ACCT }],
      unchecked: [],
    });
    expect(dmlWrites).toBe(1);
  });

  it('a delete whose record is gone → the "returned by the preview query at propose but not at" wording', async () => {
    const { code } = await proposeDml({ operation: 'delete', object: 'Account', ids: [ACCT] });
    delete accounts[ACCT];
    const result = jsonOf(await executeDml(code));
    expect(result.target_moved).toBe(true);
    expect(result.refusal).toContain(
      `Account ${ACCT} was returned by the preview query at propose but not at ${hhmm(result.checked_at)} ` +
        "— it was deleted, or is no longer visible to this connection's user (a converted Lead also " +
        'drops out); those cases look identical from here.',
    );
    expect(dmlWrites).toBe(0);
  });

  it("a failed pre-check at propose leaves the record unchecked (not moved): status 'not_checked', audited no_baseline", async () => {
    restQueryMode = 'fault';
    const { code, request, result } = await proposeDml({ operation: 'delete', object: 'Account', ids: [ACCT] });
    expect(JSON.parse(request.summaryJson).precheck).toBe('failed');
    expect(jsonOf(result).precheck).toBeUndefined();
    restQueryMode = 'ok';
    const exec = jsonOf(await executeDml(code));
    expect(exec.executed).toBe(true);
    expect(exec.target_check.status).toBe('not_checked');
    expect(exec.target_check.unchecked).toEqual([
      { object: 'Account', id: ACCT, reason: 'precheck_failed_at_propose' },
    ]);
    expect(exec.target_check.note).toContain('this write ran without a target check');
    expect(audits('deploy.target_check_unavailable').map((e) => e.detail)).toEqual([
      { requestId: request.id, kind: 'dml', reason: 'no_baseline' },
    ]);
  });

  it('a plan: literal-id steps are re-checked with the same wording; the propose result carries no guard data', async () => {
    const { code, request, result } = await proposeDml({
      steps: [
        { operation: 'update', object: 'Account', id: ACCT, record: { Name: 'Plan Name' } },
        { operation: 'delete', object: 'Account', id: ACCT2 },
      ],
    });
    const summary = JSON.parse(request.summaryJson) as Record<string, any>;
    expect(summary.before).toEqual({
      '1': { object: 'Account', id: ACCT, operation: 'update', exists: true, fields: { Name: 'Old Name' } },
      '2': { object: 'Account', id: ACCT2, operation: 'delete', exists: true },
    });
    expect(jsonOf(result).before).toBeUndefined();
    expect(jsonOf(result).precheck).toBeUndefined();
    accounts[ACCT]!.Name = 'Edited';
    delete accounts[ACCT2];
    const exec = jsonOf(await executeDml(code));
    expect(exec.target_moved).toBe(true);
    expect(exec.refusal).toContain(`Account ${ACCT} Name is now "Edited" (the approval showed "Old Name")`);
    expect(exec.refusal).toContain(
      `Account ${ACCT2} was returned by the preview query at propose but not at ${hhmm(exec.checked_at)}`,
    );
    expect(dmlWrites).toBe(0);
  });

  it('insert-only → no query at execute; target_check not_applicable', async () => {
    const { code } = await proposeDml({
      operation: 'insert',
      object: 'Account',
      records: [{ Name: 'Fresh' }],
    });
    const queriesBefore = restQueries.length;
    const result = jsonOf(await executeDml(code));
    expect(result.executed).toBe(true);
    expect(restQueries.length).toBe(queriesBefore);
    expect(result.target_check).toEqual({
      status: 'not_applicable',
      note: 'an insert has no existing record to re-check',
    });
  });

  it('the re-query fails → fail open: executes with target_check unavailable + the audit', async () => {
    const { code, request } = await proposeDml(UPDATE_ACCT);
    restQueryMode = 'fault';
    const result = jsonOf(await executeDml(code));
    expect(result.executed).toBe(true);
    expect(result.target_check.status).toBe('unavailable');
    expect(result.target_check.note).toContain('this change ran against whatever the org held');
    expect(audits('deploy.target_check_unavailable')[0]!.detail).toMatchObject({
      requestId: request.id,
      kind: 'dml',
    });
  });
});

describe('S45 F2: activation — Status vs the frozen from_status', () => {
  it('a version whose Status changed since propose → TARGET MOVED, no POST, the code void', async () => {
    const before = presentedPages.length;
    const propose = await client.callTool({
      name: 'agent_activation_propose',
      arguments: { connection: 'moved-org', agent: 'Support_Agent', version: 'v2', status: 'Inactive' },
    });
    expect(propose.isError, textOf(propose)).not.toBe(true);
    expect(presentedPages.length).toBe(before + 1);
    const code = codeFromPage(presentedPages.at(-1)!);
    const request = db.findRequestByCode(connId, 'activation', code)!;
    // Someone deactivated it in Setup in the meantime.
    botVersionRows[1]!.Status = 'Inactive';
    const exec = await client.callTool({
      name: 'agent_activation_execute',
      arguments: { connection: 'moved-org', confirmation_code: code },
    });
    const result = jsonOf(exec);
    expect(result).toMatchObject({ executed: false, target_moved: true });
    expect(result.refusal).toBe(
      'TARGET MOVED — not executed, and this code is now void. ' +
        `SELECT Status at ${hhmm(result.checked_at)} reports BotVersion v2 of Support_Agent is ` +
        'Inactive; the approval was for a change from Active. Re-run agent_activation_propose.',
    );
    expect(activationPosts).toBe(0);
    expect(db.getDeployRequestStatus(request.id)).toBe('superseded');
    expect(audits('activation.target_moved')).toHaveLength(1);
    expect(textOf(exec)).not.toContain(code);
    expect(db.findRequestByCode(connId, 'activation', code)!.resultJson ?? '').not.toContain(code);
    expectCodeNowhere(code);
  });

  it('an unchanged Status executes with target_check naming the version', async () => {
    await client.callTool({
      name: 'agent_activation_propose',
      arguments: { connection: 'moved-org', agent: 'Support_Agent', version: 'v2', status: 'Inactive' },
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const result = jsonOf(
      await client.callTool({
        name: 'agent_activation_execute',
        arguments: { connection: 'moved-org', confirmation_code: code },
      }),
    );
    expect(activationPosts).toBe(1);
    expect(result.target_moved).toBeUndefined();
    expect(result.target_check).toMatchObject({
      status: 'ok',
      checked: [{ type: 'BotVersion', api_name: 'Support_Agent.v2' }],
      unchecked: [],
    });
  });
});

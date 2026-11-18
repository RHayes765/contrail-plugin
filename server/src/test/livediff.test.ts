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
import { composePushover, type ApprovalNotifier, type NotifyOutcome } from '../core/notify.js';
import type { ApprovalPageOptions } from '../connect/pages.js';

/**
 * S45 F1: the live pre-image at the validate seam — classification from the
 * LIVE org (presence and content apart), CHANGED IN TARGET driven by dates,
 * per-file bundle diffs, the collapsed <details> diff on the approval page
 * (escaped — pre-images are org text), the degrade banner reserved for a
 * failed RETRIEVE, nothing at all on a dry run, live_check/pre_image in the
 * summary, the revert pre-images under staging/_reverts, and the phone copy
 * that never names who edited what.
 */

class RecordingNotifier implements ApprovalNotifier {
  calls: Array<{ view: ApprovalPageOptions; includeCode: boolean }> = [];
  async notify(view: ApprovalPageOptions, opts: { includeCode: boolean }): Promise<NotifyOutcome> {
    this.calls.push({ view, includeCode: opts.includeCode });
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
const SNAP_AT = '2026-11-01T12:00:00.000Z';
// The page renders the snapshot date from HOST-LOCAL fields; the expected day
// is derived the same way, so these pins hold in every time zone.
const localDay = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const SNAP_DAY = localDay(SNAP_AT);
const CREATED = '2026-11-14T15:00:01.000Z';
const COMPLETED = '2026-11-14T15:00:09.000Z';

const FOO_PROPOSED = 'public class Foo {\n    public static Integer one() { return 1; }\n}\n';
const FOO_OLD = 'public class Foo {\n    public static Integer one() { return 0; }\n}\n';
const APEX_META = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass ${MD}>\n    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
const LWC_META =
  `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle ${MD}>\n` +
  '    <apiVersion>66.0</apiVersion>\n    <isExposed>false</isExposed>\n</LightningComponentBundle>\n';
const LWC_FILES: Record<string, string> = {
  'myCmp.js':
    "import { LightningElement } from 'lwc';\nexport default class MyCmp extends LightningElement {}\n",
  'myCmp.js-meta.xml': LWC_META,
  'myCmp.html': '<template>\n    <p>hi</p>\n</template>\n',
};
const AURA_META = `<?xml version="1.0" encoding="UTF-8"?>\n<AuraDefinitionBundle ${MD}>\n    <apiVersion>66.0</apiVersion>\n</AuraDefinitionBundle>\n`;
const AURA_FILES: Record<string, string> = {
  'myAura.cmp': '<aura:component>\n    <p>aura</p>\n</aura:component>\n',
  'myAura.cmp-meta.xml': AURA_META,
};
const objectXml = (statusType: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
  `    <fields>\n        <fullName>Status__c</fullName>\n        <type>${statusType}</type>\n    </fields>\n` +
  '    <label>Invoice</label>\n</CustomObject>\n';
const STATUS_FIELD = `<fields>\n        <fullName>Status__c</fullName>\n        <type>Text</type>\n    </fields>`;
const fieldBlock = (name: string, type = 'Text') =>
  `<fields>\n        <fullName>${name}</fullName>\n        <type>${type}</type>\n    </fields>`;
/**
 * S46 D1: a parent document as a child-typed retrieve returns it — only the
 * blocks the manifest named, none of the object's own elements.
 */
const partialObject = (...blocks: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
  blocks.map((b) => `    ${b}\n`).join('') +
  '</CustomObject>\n';

interface ListRow {
  fullName: string;
  date: string;
  by: string;
}

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
let store: SnapshotStore;
let client: Client;
let connId: string;
let presentedPages: string[];
let notifier: RecordingNotifier;
let soapBodies: string[];
let statusCalls: number;
let liveFiles: Record<string, string>;
let listRows: Record<string, ListRow[]>;
let invalidTypes: Set<string>;
/** 'failed' = the org reports the retrieve as finished and failed (its <messages> included). */
let retrieveMode: 'ok' | 'fault' | 'never' | 'failed';
/** 'fault' = every listMetadata call faults with something other than INVALID_TYPE. */
let listMode: 'ok' | 'fault';
let deployMode: 'ok' | 'http500AfterPolls';
let toolingMode: 'ok' | 'fail';
/** S46 D1: the rows the stamp queries answer from, per queried sObject. */
let probeRows: Record<string, ProbeRow[]>;
/** 'fault' = every stamp query answers HTTP 500. */
let probeMode: 'ok' | 'fault';
/** The decoded SOQL of every stamp query issued, in order. */
let restQueries: string[];
/** `problem` texts the finished retrieve status carries as <messages> elements. */
let retrieveProblems: string[];

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

/**
 * S46 D1: answer ONE stamp query from its decoded SOQL — the probeRows of
 * the queried sObject that a WHERE clause names (the name
 * case-insensitively, the parent exactly; nothing is filtered on namespace,
 * as the real queries filter nothing on it). null when the SOQL is not a
 * stamp query. A stamp query sent to the wrong API answers as the org does
 * for an sObject that API does not have.
 */
function stampQueryResponse(api: 'tooling' | 'data', soql: string): Response | null {
  const m =
    /^SELECT Id, (\w+), NamespacePrefix, LastModifiedDate, LastModifiedBy\.Name FROM (\w+) WHERE (.+)$/.exec(
      soql,
    );
  const sobject = m?.[2] ?? '';
  const cols = PROBE_COLUMNS[sobject];
  if (!m || !cols || cols.name !== m[1]) return null;
  restQueries.push(soql);
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
 * The deploy.test.ts / preimage.test.ts stub idioms in one: the checkOnly
 * deploy (with org-side created/completed stamps), the pre-image retrieve
 * (ok / fault / never done / finished as failed; retrieveProblems ride its
 * finished status as <messages>), listMetadata rows per queried type with an
 * sf:INVALID_TYPE fault for any type in invalidTypes (or another fault for
 * every listing when listMode is 'fault'), and the stamp queries (Tooling for
 * CustomField / ValidationRule / ExternalString, the Data API for ListView)
 * answered from probeRows.
 */
function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://live.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DL/005L',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/tooling/query')) {
      const stamp = stampQueryResponse('tooling', new URL(url).searchParams.get('q') ?? '');
      if (stamp) return stamp;
      // Everything else on this route is the Aura live check's Tooling read.
      if (toolingMode === 'fail') return new Response('tooling down', { status: 500 });
      return new Response(JSON.stringify({ done: true, records: [], totalSize: 0 }));
    }
    if (/\/services\/data\/v[\d.]+\/query\?q=/.test(url)) {
      const stamp = stampQueryResponse('data', new URL(url).searchParams.get('q') ?? '');
      if (stamp) return stamp;
      return new Response('not found', { status: 404 });
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      soapBodies.push(body);
      if (body.includes('<met:deploy>')) {
        if (deployMode === 'http500AfterPolls') {
          // The checkOnly deploy fails only once the pre-image retrieve has
          // polled twice — proving the two run CONCURRENTLY.
          const deadline = Date.now() + 2000;
          while (statusCalls < 2 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5));
          }
          return new Response('deploy service down', { status: 500 });
        }
        return new Response(
          soapEnvelope(
            `<deployResponse ${MD}><result><id>0Af-live-1</id></result></deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse ${MD}><result>
               <done>true</done><status>Succeeded</status>
               <success>true</success><checkOnly>true</checkOnly>
               <createdDate>${CREATED}</createdDate><completedDate>${COMPLETED}</completedDate>
               <numberComponentsTotal>1</numberComponentsTotal>
               <numberComponentsDeployed>1</numberComponentsDeployed>
               <numberComponentErrors>0</numberComponentErrors>
               <numberTestsTotal>0</numberTestsTotal>
               <numberTestsCompleted>0</numberTestsCompleted>
               <numberTestErrors>0</numberTestErrors>
               <details><runTestResult><numTestsRun>0</numTestsRun>
                 <numFailures>0</numFailures></runTestResult></details>
             </result></checkDeployStatusResponse>`,
          ),
        );
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
        statusCalls += 1;
        if (retrieveMode === 'never') {
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse ${MD}><result><done>false</done><id>09S1</id>` +
                `<status>InProgress</status><success>false</success></result></checkRetrieveStatusResponse>`,
            ),
          );
        }
        const messages = retrieveProblems
          .map(
            (p) =>
              `<messages><fileName>unpackaged/package.xml</fileName>` +
              `<problem>${p.replace(/'/g, '&apos;')}</problem></messages>`,
          )
          .join('');
        if (retrieveMode === 'failed') {
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
                `${messages}<status>Failed</status><success>false</success>` +
                `<errorMessage>boom</errorMessage></result></checkRetrieveStatusResponse>`,
            ),
          );
        }
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
              `${messages}<status>Succeeded</status><success>true</success>` +
              `<zipFile>${liveZipB64()}</zipFile></result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (body.includes('<met:listMetadata>')) {
        if (listMode === 'fault') return fault('INSUFFICIENT_ACCESS', 'no metadata api for you');
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

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-livediff-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  presentedPages = [];
  notifier = new RecordingNotifier();
  soapBodies = [];
  statusCalls = 0;
  liveFiles = {};
  listRows = {};
  invalidTypes = new Set();
  retrieveMode = 'ok';
  listMode = 'ok';
  deployMode = 'ok';
  toolingMode = 'ok';
  probeRows = {};
  probeMode = 'ok';
  restQueries = [];
  retrieveProblems = [];

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias: 'live-org',
    instanceUrl: 'https://live.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DL',
    orgName: 'Live',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT');
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

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5 },
    notifications: { ...DEFAULT_CONFIG.notifications, when: 'always' },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5 },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store,
    approvals,
    notifier,
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
  client = new Client({ name: 'livediff-test', version: '0.0.0' });
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

interface ResultChange {
  type: string;
  api_name: string;
  change: string;
  warnings: string[];
  pre_image?: Record<string, unknown>;
}

function jsonOf(result: Awaited<ReturnType<Client['callTool']>>): {
  request_id: string | null;
  changes: ResultChange[];
  destructive: ResultChange[];
  permission_warning: string | null;
  live_check: Record<string, unknown> | null;
} {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{')));
}

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
}

/** Seed the local snapshot: current/ files plus index rows (dates default null). */
function seedSnapshot(
  files: Record<string, string>,
  rows: Array<{
    type: string;
    apiName: string;
    filePath: string;
    lastModifiedDate?: string | null;
    lastModifiedBy?: string | null;
  }>,
): void {
  store.writeCurrent(
    connId,
    new Map(Object.entries(files).map(([rel, body]) => [rel, strToU8(body)])),
  );
  db.replaceArtifactsForTypes(
    connId,
    [...new Set(rows.map((r) => r.type))],
    rows.map((r) => ({
      connectionId: connId,
      type: r.type,
      apiName: r.apiName,
      filePath: r.filePath,
      contentHash: 'h',
      lastModifiedDate: r.lastModifiedDate ?? null,
      lastModifiedBy: r.lastModifiedBy ?? null,
      retrievedAt: SNAP_AT,
      content: '',
    })),
  );
}

async function validate(args: Record<string, unknown>) {
  return client.callTool({
    name: 'validate_deploy',
    arguments: { connection: 'live-org', ...args },
  });
}

const foo = (content = FOO_PROPOSED) => ({ type: 'ApexClass', api_name: 'Foo', content });
/** The page's HH:MM for an ISO stamp (host-local, like the engine's). */
const hhmmOf = (iso: unknown) => {
  const d = new Date(String(iso));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const envelope = (files: Record<string, string>) =>
  JSON.stringify({ contrail_bundle: 1, files });

/** Every regular file under `dir` (recursive); [] for a missing dir. */
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

/** The code (from the PAGE) is in no audit row and in no file under `dirs`. */
function expectCodeNowhere(code: string, dirs: string[] = []): void {
  expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(code);
  for (const d of dirs) {
    for (const f of walkFiles(d)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(code);
  }
}

/** The row the engine handed the page + phone for one label. */
function viewRow(label: string) {
  const view = notifier.calls[notifier.calls.length - 1]!.view;
  const row = view.changes.find((r) => r.label.endsWith(label));
  if (!row) throw new Error(`no row ${label}`);
  return row;
}

/** The page-top lines the engine handed the page + phone on the last validate. */
const topWarnings = () => notifier.calls[notifier.calls.length - 1]!.view.warnings ?? [];
/** Every type a listMetadata call has named so far in this test. */
const listedTypes = () =>
  soapBodies
    .filter((b) => b.includes('<met:listMetadata>'))
    .flatMap((b) => [...b.matchAll(/<met:type>([^<]+)<\/met:type>/g)].map((m) => m[1]!));
/** The manifest of the most recent pre-image retrieve. */
const lastRetrieveBody = () => soapBodies.filter((b) => b.includes('<met:retrieve>')).at(-1) ?? '';
/** The one dates-unavailable line, built from its groups (already joined with '; '). */
const datesLine = (at: unknown, groups: string) =>
  `Live diff is against the org (retrieved ${hhmmOf(at)}); last-modified stamps were unavailable ` +
  `for ${groups}, so CHANGED-IN-TARGET detection for those members relies on content only and ` +
  'the execute-time check will report them as unchecked.';
/** The stamp query for CustomField Invoice__c.Status__c, verbatim. */
const STATUS_STAMP_QUERY =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
  "CustomField WHERE (DeveloperName = 'Status' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";

describe('S45 F1: live pre-image classification and the approval page diff', () => {
  it('EXISTS IN TARGET: a snapshot ADD the org has flips to MODIFY with a live diff — escaped, collapsed, who in the detail only', async () => {
    liveFiles = {
      'classes/Foo.cls':
        'public class Foo {\n    // <script>alert(1)</script>\n    public static Integer one() { return 0; }\n}\n',
      'classes/Foo.cls-meta.xml': APEX_META,
    };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Alice Example' }] };
    const result = await validate({ components: [foo()] });
    const parsed = jsonOf(result);
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings[0]).toMatch(
      /^EXISTS IN TARGET — this deploy OVERWRITES a live ApexClass Foo that your snapshot does not have \(retrieved \d\d:\d\d\); the diff below is against the live version\.$/,
    );
    expect(entry.warnings.join(' ')).not.toContain('Alice');

    const page = presentedPages[0]!;
    expect(page).toContain('<details class="chg-diff">');
    expect(page).toMatch(/diff vs live org \(retrieved \d\d:\d\d\) · \+1 \/ −2 lines/);
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('last modified in the org by Alice Example at 2026-11-');

    // The phone copy: the headline survives the 140-char cut with its
    // consequence, and the editor's name never leaves the desktop.
    const view = notifier.calls[0]!.view;
    const push = composePushover(view, { includeCode: true, summary: 'full' });
    expect(push.message).toContain('EXISTS IN TARGET');
    const line = push.message.split('\n').find((l) => l.includes('EXISTS IN TARGET'))!;
    expect(line.indexOf('OVERWRITES')).toBeGreaterThan(-1);
    expect(line.indexOf('OVERWRITES')).toBeLessThan(140);
    expect(push.message).not.toContain('Alice Example');

    // The code: on the page, never in the tool result.
    const code = codeFromPage(page);
    expect(textOf(result)).not.toContain(code);
  });

  it('NOT IN TARGET: a snapshot MODIFY the org lacks becomes an ADD with no diff', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: SNAP_AT, lastModifiedBy: 'Bob' },
    ]);
    listRows = { ApexClass: [] };
    const parsed = jsonOf(await validate({ components: [foo()] }));
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('add');
    expect(entry.warnings[0]).toMatch(
      /^NOT IN TARGET — your snapshot has ApexClass Foo, but the org does not \(retrieved \d\d:\d\d\)\. This deploy CREATES it rather than modifying it\.$/,
    );
    expect(entry.pre_image).toMatchObject({ present: false, source: 'retrieve' });
    expect(viewRow('ApexClass:Foo').diff).toBeUndefined();
    expect(presentedPages[0]!).not.toContain('class="chg-diff"');
  });

  it('snapshot == proposed but the org moved on: MODIFY + CHANGED IN TARGET + a non-empty diff vs live, attributed in the detail only', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_PROPOSED }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: SNAP_AT, lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-12T10:00:00.000Z', by: 'Alice Example' }] };
    const parsed = jsonOf(await validate({ components: [foo()] }));
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings[0]).toMatch(
      new RegExp(
        String.raw`^CHANGED IN TARGET SINCE YOUR SNAPSHOT — the diff below is against the LIVE version \(retrieved \d\d:\d\d\); your snapshot is from ${SNAP_DAY} \d\d:\d\d\.$`,
      ),
    );
    const row = viewRow('ApexClass:Foo');
    expect(row.diff?.identical).toBe(false);
    expect(row.diff?.baseline_label).toMatch(/^diff vs live org \(retrieved \d\d:\d\d\)$/);
    expect(row.diff?.text_hunks?.length).toBeGreaterThan(0);
    expect(row.detail).toContain('last modified in the org by Alice Example at');

    const view = notifier.calls[0]!.view;
    expect(view.warnings!.find((w) => w.includes('since your snapshot'))).toMatch(
      /^1 component\(s\) changed in "live-org" since your snapshot — rows marked CHANGED IN TARGET show when \(and, in their detail, who\); every diff on this page is against the live version retrieved at \d\d:\d\d, except rows labelled "diff vs your snapshot"\.$/,
    );
    const push = composePushover(view, { includeCode: true, summary: 'full' });
    expect(push.message).toContain('CHANGED IN TARGET');
    expect(push.message).not.toContain('Alice Example');
    expect(presentedPages[0]!).not.toContain('UNAVAILABLE');
  });

  it('snapshot ≠ proposed but the org already holds the proposal: UNCHANGED_CONTENT, "identical to the live version"', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: '2026-11-10T09:30:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'classes/Foo.cls': FOO_PROPOSED, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(await validate({ components: [foo()] }));
    expect(parsed.changes[0]!.change).toBe('unchanged_content');
    expect(parsed.changes[0]!.warnings.join(' ')).not.toMatch(/IN TARGET/);
    expect(viewRow('ApexClass:Foo').diff).toMatchObject({ identical: true, summary: 'identical to the live version' });
    expect(presentedPages[0]!).toContain('identical to the live version');
  });

  it('an unchanged Aura and LWC bundle (live == snapshot) raise no CHANGED warning, diff identical, and name nobody', async () => {
    const lwcSnap = Object.fromEntries(Object.entries(LWC_FILES).map(([k, v]) => [`lwc/myCmp/${k}`, v]));
    const auraSnap = Object.fromEntries(Object.entries(AURA_FILES).map(([k, v]) => [`aura/myAura/${k}`, v]));
    seedSnapshot({ ...lwcSnap, ...auraSnap }, [
      { type: 'LightningComponentBundle', apiName: 'myCmp', filePath: 'lwc/myCmp/myCmp.js', lastModifiedDate: '2026-11-03T10:00:00.000Z', lastModifiedBy: 'Alice Example' },
      { type: 'AuraDefinitionBundle', apiName: 'myAura', filePath: 'aura/myAura/myAura.cmp', lastModifiedDate: '2026-11-03T11:00:00.000Z', lastModifiedBy: 'Alice Example' },
    ]);
    liveFiles = { ...lwcSnap, ...auraSnap };
    listRows = {
      LightningComponentBundle: [{ fullName: 'myCmp', date: '2026-11-03T10:00:00.000Z', by: 'Alice Example' }],
      AuraDefinitionBundle: [{ fullName: 'myAura', date: '2026-11-03T11:00:00.000Z', by: 'Alice Example' }],
    };
    const parsed = jsonOf(
      await validate({
        components: [
          { type: 'LightningComponentBundle', api_name: 'myCmp', content: envelope(LWC_FILES) },
          { type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(AURA_FILES) },
        ],
      }),
    );
    for (const entry of parsed.changes) {
      expect(entry.change).toBe('unchanged_content');
      expect(entry.warnings.join(' ')).not.toMatch(/CHANGED IN TARGET|live bytes differ/);
    }
    expect(viewRow('LightningComponentBundle:myCmp').diff?.identical).toBe(true);
    expect(viewRow('AuraDefinitionBundle:myAura').diff?.identical).toBe(true);
    const page = presentedPages[0]!;
    expect(page).not.toMatch(/by Alice Example/);
    expect(page).not.toContain('CHANGED IN TARGET');
  });

  it('with dates unavailable, bundle bytes are compared to the snapshot PER FILE (readBundleFiles), never as one main file', async () => {
    // The equal-dates case above never reaches the byte comparison; null
    // snapshot dates force it. An unchanged bundle must raise no note …
    const lwcSnap = Object.fromEntries(Object.entries(LWC_FILES).map(([k, v]) => [`lwc/myCmp/${k}`, v]));
    const auraSnap = Object.fromEntries(Object.entries(AURA_FILES).map(([k, v]) => [`aura/myAura/${k}`, v]));
    seedSnapshot({ ...lwcSnap, ...auraSnap }, [
      { type: 'LightningComponentBundle', apiName: 'myCmp', filePath: 'lwc/myCmp/myCmp.js', lastModifiedDate: null },
      { type: 'AuraDefinitionBundle', apiName: 'myAura', filePath: 'aura/myAura/myAura.cmp', lastModifiedDate: null },
    ]);
    liveFiles = { ...lwcSnap, ...auraSnap };
    listRows = {
      LightningComponentBundle: [{ fullName: 'myCmp', date: '2026-11-03T10:00:00.000Z', by: 'Alice Example' }],
      AuraDefinitionBundle: [{ fullName: 'myAura', date: '2026-11-03T11:00:00.000Z', by: 'Alice Example' }],
    };
    const components = [
      { type: 'LightningComponentBundle', api_name: 'myCmp', content: envelope(LWC_FILES) },
      { type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(AURA_FILES) },
    ];
    const same = jsonOf(await validate({ components }));
    for (const entry of same.changes) {
      expect(entry.change).toBe('unchanged_content');
      expect(entry.warnings.join(' ')).not.toMatch(/CHANGED IN TARGET|live bytes differ/);
    }
    expect(presentedPages[0]!).not.toMatch(/by Alice Example/);

    // … while a NON-main file that differs live raises the neutral note
    // (a main-file-only comparison would miss it), still naming nobody.
    liveFiles = {
      ...lwcSnap,
      ...auraSnap,
      'lwc/myCmp/myCmp.html': '<template>\n    <p>edited in the org</p>\n</template>\n',
    };
    const drift = jsonOf(await validate({ components }));
    const lwc = drift.changes.find((c) => c.type === 'LightningComponentBundle')!;
    expect(lwc.change).toBe('modify');
    expect(lwc.warnings[0]).toMatch(/^live bytes differ from your snapshot \(retrieved \d\d:\d\d\)/);
    expect(lwc.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    const aura = drift.changes.find((c) => c.type === 'AuraDefinitionBundle')!;
    expect(aura.warnings.join(' ')).not.toMatch(/CHANGED IN TARGET|live bytes differ/);
    expect(presentedPages[1]!).not.toMatch(/by Alice Example/);
  });

  it('one LWC file changed: a per-file hunk labelled with its path, never a JSON-envelope diff', async () => {
    const lwcSnap = Object.fromEntries(Object.entries(LWC_FILES).map(([k, v]) => [`lwc/myCmp/${k}`, v]));
    seedSnapshot(lwcSnap, [
      { type: 'LightningComponentBundle', apiName: 'myCmp', filePath: 'lwc/myCmp/myCmp.js', lastModifiedDate: '2026-11-03T10:00:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = lwcSnap;
    listRows = { LightningComponentBundle: [{ fullName: 'myCmp', date: '2026-11-03T10:00:00.000Z', by: 'Bob' }] };
    const proposed = { ...LWC_FILES, 'myCmp.html': '<template>\n    <p>hello</p>\n</template>\n' };
    const parsed = jsonOf(
      await validate({
        components: [{ type: 'LightningComponentBundle', api_name: 'myCmp', content: envelope(proposed) }],
      }),
    );
    expect(parsed.changes[0]!.change).toBe('modify');
    const diff = viewRow('LightningComponentBundle:myCmp').diff!;
    expect(diff.format).toBe('bundle');
    expect(diff.summary).toMatch(/^diff vs live org \(retrieved \d\d:\d\d\) · 1 file changed \(myCmp\.html\)$/);
    expect(diff.text_hunks!.map((h) => h.file)).toEqual(['myCmp.html']);
    expect(diff.text_hunks![0]!.removed).toEqual(['    <p>hi</p>']);
    expect(diff.text_hunks![0]!.added).toEqual(['    <p>hello</p>']);
    const page = presentedPages[0]!;
    expect(page).toContain('<span class="dh-file">myCmp.html</span>');
    expect(page).not.toContain('contrail_bundle');
  });

  it('CHANGED attribution needs BOTH dates: a null on either side gives only the neutral note (and only when bytes differ)', async () => {
    // (a) the org cannot list the type → live date null.
    seedSnapshot({ 'classes/Foo.cls': FOO_PROPOSED }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: SNAP_AT, lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    invalidTypes = new Set(['ApexClass']);
    const a = jsonOf(await validate({ components: [foo()] }));
    expect(a.changes[0]!.change).toBe('modify');
    expect(a.changes[0]!.warnings[0]).toMatch(
      /^live bytes differ from your snapshot \(retrieved \d\d:\d\d\) — a last-modified stamp was missing for this member — the org's or your snapshot's — so Contrail cannot say who or when\.$/,
    );
    expect(a.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(a.live_check).toMatchObject({ status: 'ok', dates_unavailable_types: ['ApexClass'] });
    // The dates-unavailable case is still a LIVE diff — never "not re-read".
    const pageA = presentedPages[0]!;
    expect(pageA).toMatch(
      /Live diff is against the org \(retrieved \d\d:\d\d\); last-modified stamps were unavailable for ApexClass \(listMetadata reported INVALID_TYPE\), so CHANGED-IN-TARGET detection for those members relies on content only and the execute-time check will report them as unchecked\./,
    );
    expect(pageA).not.toContain('the org was not re-read');
    expect(pageA).toMatch(/diff vs live org \(retrieved \d\d:\d\d\)/);
    expect(pageA).not.toMatch(/last modified in the org by/);

    // (b) the snapshot row carries no date → same neutral note.
    invalidTypes = new Set();
    seedSnapshot({ 'classes/Foo.cls': FOO_PROPOSED }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: null },
    ]);
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-12T10:00:00.000Z', by: 'Alice Example' }] };
    const b = jsonOf(await validate({ components: [foo()] }));
    // S46 D1: here the ORG's stamp is there and the snapshot's is the missing
    // one — the sentence is the same one, and it never says the org's (or
    // "this type's") stamps were unavailable.
    expect(b.changes[0]!.pre_image).toMatchObject({ last_modified_date: '2026-11-12T10:00:00.000Z' });
    expect(b.changes[0]!.warnings[0]).toBe(
      `live bytes differ from your snapshot (retrieved ${hhmmOf(b.live_check!.at)}) — a ` +
        "last-modified stamp was missing for this member — the org's or your snapshot's — so " +
        'Contrail cannot say who or when.',
    );
    expect(b.changes[0]!.warnings.join(' ')).not.toContain('for this type');
    expect(b.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(presentedPages[1]!).not.toContain('Alice Example');
    // No stamp was unavailable on the org's side, so the page carries no dates line.
    expect(presentedPages[1]!).not.toContain('last-modified stamps were unavailable');

    // (c) a date is missing AND the bytes match → nothing at all.
    liveFiles = { 'classes/Foo.cls': FOO_PROPOSED, 'classes/Foo.cls-meta.xml': APEX_META };
    const c = jsonOf(await validate({ components: [foo()] }));
    expect(c.changes[0]!.change).toBe('unchanged_content');
    expect(c.changes[0]!.warnings).toEqual([]);
  });

  it('a child whose snapshot row carries its container stamp is compared against the snapshot time instead', async () => {
    const stamp = '2026-10-20T08:00:00.000Z';
    seedSnapshot({ 'objects/Invoice__c.object': objectXml('Text') }, [
      { type: 'CustomObject', apiName: 'Invoice__c', filePath: 'objects/Invoice__c.object', lastModifiedDate: stamp, lastModifiedBy: 'Bob' },
      { type: 'CustomField', apiName: 'Invoice__c.Status__c', filePath: 'objects/Invoice__c.object', lastModifiedDate: stamp, lastModifiedBy: 'Bob' },
    ]);
    // S46 D1: the retrieve names the field by its own type, so the org
    // answers with a container holding only that block; the field's stamp
    // comes from its stamp query, written the way Tooling writes it.
    liveFiles = { 'objects/Invoice__c.object': partialObject(fieldBlock('Status__c', 'Text')) };
    // The field's own stamp predates the snapshot: unchanged since it.
    probeRows = { CustomField: [{ name: 'Status', parent: 'Invoice__c', date: '2026-10-25T08:00:00.000+0000', by: 'Bob' }] };
    const field = { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD };
    const before = jsonOf(await validate({ components: [field] }));
    expect(before.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(before.changes[0]!.pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: '2026-10-25T08:00:00.000Z',
      last_modified_by: 'Bob',
    });
    expect(before.live_check).toMatchObject({ status: 'ok', stamp_scheme: 2, dates_unavailable_types: [] });
    expect(before.live_check!.probe_failures).toBeUndefined();
    expect(before.live_check!.probe_unmatched).toBeUndefined();
    expect(presentedPages[0]!).not.toContain('last-modified stamps were unavailable');

    // Its own stamp is after the snapshot was taken: changed since it.
    liveFiles = { 'objects/Invoice__c.object': partialObject(fieldBlock('Status__c', 'LongTextArea')) };
    probeRows = { CustomField: [{ name: 'Status', parent: 'Invoice__c', date: '2026-11-12T08:00:00.000+0000', by: 'Alice Example' }] };
    const after = jsonOf(await validate({ components: [field] }));
    expect(after.changes[0]!.change).toBe('modify');
    expect(after.changes[0]!.warnings[0]).toMatch(/^CHANGED IN TARGET SINCE YOUR SNAPSHOT/);
    expect(viewRow('CustomField:Invoice__c.Status__c').diff).toMatchObject({ format: 'xml', identical: false });

    // The org-wide listing of the type is never issued: one stamp query per
    // validate names the package's own member, and the retrieve names the
    // child, not its parent document.
    expect(listedTypes()).not.toContain('CustomField');
    expect(restQueries).toEqual([STATUS_STAMP_QUERY, STATUS_STAMP_QUERY]);
    expect(STATUS_STAMP_QUERY.startsWith('SELECT Id, DeveloperName, NamespacePrefix')).toBe(true);
    expect(lastRetrieveBody()).toContain(
      '<met:members>Invoice__c.Status__c</met:members><met:name>CustomField</met:name>',
    );
    expect(lastRetrieveBody()).not.toContain('<met:name>CustomObject</met:name>');
  });

  it('a container-stamped child: CHANGED IN TARGET only past a 60 s clock margin; inside it, the byte comparison and the neutral note', async () => {
    const stamp = '2026-10-20T08:00:00.000Z';
    seedSnapshot({ 'objects/Invoice__c.object': objectXml('Text') }, [
      { type: 'CustomObject', apiName: 'Invoice__c', filePath: 'objects/Invoice__c.object', lastModifiedDate: stamp, lastModifiedBy: 'Bob' },
      { type: 'CustomField', apiName: 'Invoice__c.Status__c', filePath: 'objects/Invoice__c.object', lastModifiedDate: stamp, lastModifiedBy: 'Bob' },
    ]);
    const field = { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD };
    const afterSnap = (s: number) => new Date(Date.parse(SNAP_AT) + s * 1000).toISOString();
    const fieldRow = () => viewRow('CustomField:Invoice__c.Status__c');

    const stampedAt = (date: string): Record<string, ProbeRow[]> => ({
      CustomField: [{ name: 'Status', parent: 'Invoice__c', date, by: 'Alice Example' }],
    });

    // 61 s after the snapshot, bytes differ: attributed, who/when in the detail.
    liveFiles = { 'objects/Invoice__c.object': partialObject(fieldBlock('Status__c', 'LongTextArea')) };
    probeRows = stampedAt(afterSnap(61));
    const past = jsonOf(await validate({ components: [field] }));
    expect(past.changes[0]!.change).toBe('modify');
    expect(past.changes[0]!.warnings[0]).toMatch(/^CHANGED IN TARGET SINCE YOUR SNAPSHOT/);
    expect(fieldRow().detail).toContain('last modified in the org by Alice Example at');
    // The snapshot said UNCHANGED (its copy equals the proposal); the live
    // check says MODIFY — the field-type advisory is computed against the LIVE copy.
    expect(past.changes[0]!.warnings).toContain(
      'FIELD TYPE CHANGE LongTextArea → Text — possible irreversible data loss',
    );

    // 30 s after, bytes differ: no attribution — only the neutral note.
    probeRows = stampedAt(afterSnap(30));
    const inside = jsonOf(await validate({ components: [field] }));
    expect(inside.changes[0]!.change).toBe('modify');
    expect(inside.changes[0]!.warnings[0]).toBe(
      `live bytes differ from your snapshot (retrieved ${hhmmOf(inside.live_check!.at)}) — this ` +
        "member's last-modified stamp is within a minute of when your snapshot was taken, too " +
        'close to tell apart from clock differences between this computer and the org, so ' +
        'Contrail cannot say who or when.',
    );
    expect(inside.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(fieldRow().detail ?? '').not.toContain('Alice Example');
    expect(presentedPages.at(-1)!).not.toContain('Alice Example');

    // 30 s after, bytes equal: nothing at all.
    liveFiles = { 'objects/Invoice__c.object': partialObject(fieldBlock('Status__c', 'Text')) };
    const same = jsonOf(await validate({ components: [field] }));
    expect(same.changes[0]!.change).toBe('unchanged_content');
    expect(same.changes[0]!.warnings).toEqual([]);

    // Every stamp above came from the field's stamp query — never a listing.
    expect(listedTypes()).not.toContain('CustomField');
    expect(restQueries).toEqual([STATUS_STAMP_QUERY, STATUS_STAMP_QUERY, STATUS_STAMP_QUERY]);
  });

  it('a reclassified row carries the change-dependent warnings of its NEW classification (ADD → MODIFY)', async () => {
    const layout = (body: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<Layout ${MD}>\n    ${body}\n</Layout>\n`;
    const action = (label: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<QuickAction ${MD}>\n    <label>${label}</label>\n    <type>LogACall</type>\n</QuickAction>\n`;
    // Neither is in the snapshot — analyzeChanges said ADD (with the add-only
    // advisories) — but the org has both.
    liveFiles = {
      'layouts/Account-Main.layout': layout('<showRunAssignmentRulesCheckbox>false</showRunAssignmentRulesCheckbox>'),
      'quickActions/Account.Log_Call.quickAction': action('Log a Call'),
    };
    listRows = {
      Layout: [{ fullName: 'Account-Main', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }],
      QuickAction: [{ fullName: 'Account.Log_Call', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }],
    };
    const parsed = jsonOf(
      await validate({
        components: [
          { type: 'Layout', api_name: 'Account-Main', content: layout('<showRunAssignmentRulesCheckbox>true</showRunAssignmentRulesCheckbox>') },
          { type: 'QuickAction', api_name: 'Account.Log_Call', content: action('Log a Call (new)') },
        ],
      }),
    );
    const [lay, qa] = parsed.changes;
    expect(lay!.change).toBe('modify');
    expect(lay!.warnings).toEqual([
      expect.stringMatching(/^EXISTS IN TARGET — this deploy OVERWRITES a live Layout Account-Main/),
      "WHOLE-DOCUMENT REPLACE — this deploy fully replaces the org's Layout; anything not " +
        'present in the proposed content is removed.',
    ]);
    expect(lay!.warnings.join(' ')).not.toContain('NEW LAYOUT IS NOT ASSIGNED');
    expect(qa!.change).toBe('modify');
    expect(qa!.warnings).toEqual([
      expect.stringMatching(/^EXISTS IN TARGET — this deploy OVERWRITES a live QuickAction Account\.Log_Call/),
    ]);
  });

  it('a GenAiPlannerBundle ADD the org has flips to MODIFY and gains the deactivate-first gate, computed per file against the live bundle', async () => {
    const planner = (desc: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<GenAiPlannerBundle ${MD}>\n    <description>${desc}</description>\n</GenAiPlannerBundle>\n`;
    liveFiles = { 'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle': planner('live') };
    listRows = { GenAiPlannerBundle: [{ fullName: 'Agent_v1', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(
      await validate({
        components: [
          {
            type: 'GenAiPlannerBundle',
            api_name: 'Agent_v1',
            content: envelope({ 'Agent_v1.genAiPlannerBundle': planner('proposed') }),
          },
        ],
      }),
    );
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings[0]).toMatch(/^EXISTS IN TARGET — this deploy OVERWRITES a live GenAiPlannerBundle Agent_v1/);
    expect(entry.warnings).toContain(
      "BUNDLE REPLACE — this deploy replaces the org's whole GenAiPlannerBundle directory " +
        '(1 files; changed: Agent_v1.genAiPlannerBundle).',
    );
    expect(entry.warnings.some((w) => w.startsWith('AGENT MUST BE DEACTIVATED FIRST — deploying GenAiPlannerBundle'))).toBe(true);
  });

  it('a snapshot MODIFY the org lacks becomes an ADD: the replace warning goes, the add-only advisory comes', async () => {
    const layout = `<?xml version="1.0" encoding="UTF-8"?>\n<Layout ${MD}>\n    <showRunAssignmentRulesCheckbox>true</showRunAssignmentRulesCheckbox>\n</Layout>\n`;
    seedSnapshot({ 'layouts/Account-Main.layout': layout.replace('true', 'false') }, [
      { type: 'Layout', apiName: 'Account-Main', filePath: 'layouts/Account-Main.layout', lastModifiedDate: SNAP_AT, lastModifiedBy: 'Bob' },
    ]);
    listRows = { Layout: [] };
    const parsed = jsonOf(
      await validate({ components: [{ type: 'Layout', api_name: 'Account-Main', content: layout }] }),
    );
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('add');
    expect(entry.warnings).toEqual([
      expect.stringMatching(/^NOT IN TARGET — your snapshot has Layout Account-Main, but the org does not/),
      'NEW LAYOUT IS NOT ASSIGNED by this deploy — profiles keep their current layout until ' +
        'layoutAssignments change (Profile metadata or Setup).',
    ]);
    expect(entry.warnings.join(' ')).not.toContain('WHOLE-DOCUMENT REPLACE');
  });

  it('the FlowDefinition deactivation entry is never reclassified', async () => {
    const deactivate = `<?xml version="1.0" encoding="UTF-8"?>\n<FlowDefinition ${MD}>\n    <activeVersionNumber>0</activeVersionNumber>\n</FlowDefinition>\n`;
    liveFiles = { 'flowDefinitions/My_Flow.flowDefinition': deactivate };
    listRows = { FlowDefinition: [{ fullName: 'My_Flow', date: '2026-11-01T10:00:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(
      await validate({ components: [{ type: 'FlowDefinition', api_name: 'My_Flow', content: deactivate }] }),
    );
    const entry = parsed.changes[0]!;
    // Live bytes equal the proposal, yet it stays MODIFY + DEACTIVATES.
    expect(entry.change).toBe('modify');
    expect(entry.warnings.join(' ')).toContain('DEACTIVATES flow My_Flow');
    expect(entry.warnings.join(' ')).not.toMatch(/IN TARGET/);
    expect(entry.pre_image).toMatchObject({ present: true });

    // Absent in the org: still MODIFY, no NOT IN TARGET.
    liveFiles = {};
    listRows = { FlowDefinition: [] };
    const absent = jsonOf(
      await validate({ components: [{ type: 'FlowDefinition', api_name: 'My_Flow', content: deactivate }] }),
    );
    expect(absent.changes[0]!.change).toBe('modify');
    expect(absent.changes[0]!.warnings.join(' ')).not.toMatch(/IN TARGET/);
  });

  it('the degrade banner appears only when the RETRIEVE fails — the snapshot verdict stands and nothing is frozen', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: SNAP_AT, lastModifiedBy: 'Bob' },
    ]);
    retrieveMode = 'fault';
    const parsed = jsonOf(await validate({ components: [foo()] }));
    // S46 D1: stamp_scheme rides an UNAVAILABLE live check too — with no
    // pre-image to carry a stamp_source, it is the only marker the
    // execute-time guard has that this request was validated under the
    // stamp queries.
    expect(parsed.live_check).toMatchObject({ status: 'unavailable', stamp_scheme: 2 });
    expect(String(parsed.live_check!.reason)).toMatch(/^retrieve_failed:/);
    expect(parsed.changes[0]!.change).toBe('modify');
    expect(parsed.changes[0]!.pre_image).toBeUndefined();
    const page = presentedPages[0]!;
    expect(page).toMatch(
      new RegExp(
        String.raw`LIVE COMPARISON UNAVAILABLE \(retrieve_failed:[^)]*\) — compared against your snapshot from ${SNAP_DAY} \d\d:\d\d; the org was not re-read\. Classifications \(ADD\/MODIFY\) and diffs below come from the local snapshot only\.`,
      ),
    );
    expect(viewRow('ApexClass:Foo').diff?.summary).toMatch(
      new RegExp(String.raw`^diff vs your snapshot \(${SNAP_DAY} \d\d:\d\d\) · \+1 \/ −1 lines$`),
    );
    expect(fs.existsSync(path.join(tmp, 'staging', '_reverts', parsed.request_id!))).toBe(false);

    // A listing fault alone never raises the banner.
    retrieveMode = 'ok';
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    invalidTypes = new Set(['ApexClass']);
    const ok = jsonOf(await validate({ components: [foo()] }));
    expect(ok.live_check).toMatchObject({ status: 'ok' });
    expect(presentedPages[1]!).not.toContain('LIVE COMPARISON UNAVAILABLE');
  });

  it('a dry run issues no retrieve, listing or stamp query and leaves a pre-seeded _reverts directory untouched', async () => {
    const orphan = path.join(tmp, 'staging', '_reverts', 'not-a-known-request');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'keep.txt'), 'untouched');
    liveFiles = { 'classes/Foo.cls': FOO_OLD };
    const result = await validate({
      components: [foo(), { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD }],
      dry_run: true,
    });
    const parsed = jsonOf(result);
    expect(parsed.request_id).toBeNull();
    expect(parsed.live_check).toBeNull();
    expect(parsed.changes[0]!.pre_image).toBeUndefined();
    expect(soapBodies.some((b) => b.includes('<met:retrieve>'))).toBe(false);
    expect(soapBodies.some((b) => b.includes('<met:listMetadata>'))).toBe(false);
    expect(restQueries).toEqual([]);
    expect(fs.readFileSync(path.join(orphan, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(path.join(tmp, 'staging', '_reverts'))).toEqual(['not-a-known-request']);
    expect(presentedPages).toHaveLength(0);
  });

  it('pre_image and live_check (started_at, org_clock) ride the summary and the tool result; the revert pre-images are frozen under staging/_reverts', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: '2026-11-10T09:30:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const result = await validate({ components: [foo()] });
    const parsed = jsonOf(result);
    expect(parsed.live_check).toMatchObject({
      status: 'ok',
      org_clock: { created_date: CREATED, completed_date: COMPLETED },
      dates_unavailable_types: [],
      stamp_scheme: 2,
      members: 1,
    });
    // Nothing failed, nothing was unmatched and the retrieve said nothing:
    // the optional S46 keys are absent, not empty.
    expect(Object.keys(parsed.live_check!).sort()).toEqual(
      ['at', 'dates_unavailable_types', 'members', 'org_clock', 'stamp_scheme', 'started_at', 'status'],
    );
    expect(Date.parse(String(parsed.live_check!.started_at))).not.toBeNaN();
    expect(Date.parse(String(parsed.live_check!.at))).toBeGreaterThanOrEqual(
      Date.parse(String(parsed.live_check!.started_at)),
    );
    expect(parsed.changes[0]!.pre_image).toMatchObject({
      present: true,
      source: 'retrieve',
      stamp_source: 'listMetadata',
      last_modified_date: '2026-11-10T09:30:00.000Z',
      last_modified_by: 'Bob',
      comparable: true,
      restorable: true,
    });
    expect(String(parsed.changes[0]!.pre_image!.sha256)).toMatch(/^[0-9a-f]{64}$/);

    const code = codeFromPage(presentedPages[0]!);
    expect(textOf(result)).not.toContain(code);
    const request = db.findRequestByCode(connId, 'deploy', code)!;
    // The code is live and _reverts/<id> holds the pre-images: none carries it.
    expectCodeNowhere(code, [path.join(tmp, 'staging', '_reverts', request.id)]);
    const summary = JSON.parse(request.summaryJson) as Record<string, any>;
    expect(summary.live_check).toEqual(parsed.live_check);
    expect(summary.changes[0].pre_image).toEqual(parsed.changes[0]!.pre_image);
    // The diff itself is never persisted (it would ride every execute result).
    expect(request.summaryJson).not.toContain('text_hunks');

    const dir = path.join(tmp, 'staging', '_reverts', request.id);
    expect(fs.readFileSync(path.join(dir, 'classes', 'Foo.cls'), 'utf8')).toBe(FOO_OLD);
    expect(fs.readFileSync(path.join(dir, 'classes', 'Foo.cls-meta.xml'), 'utf8')).toBe(APEX_META);
    expect(summary.revert_preimages).toMatchObject({
      dir,
      components: [{ type: 'ApexClass', api_name: 'Foo', content_file: path.join(dir, 'classes', 'Foo.cls') }],
      not_restorable: [],
      absent: [],
    });
  });

  it('destructive members: "not present in the target" only when the type was enumerated', async () => {
    listRows = { ApexClass: [] };
    invalidTypes = new Set(['PresenceUserConfig']);
    const parsed = jsonOf(
      await validate({
        components: [],
        destructive: [
          { type: 'ApexClass', api_name: 'Gone' },
          { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
        ],
        allow_unregistered_delete: true,
      }),
    );
    const [gone, presence] = parsed.destructive;
    expect(gone!.pre_image).toMatchObject({ present: false });
    expect(gone!.warnings).toContainEqual(
      expect.stringMatching(
        /^not present in the target \(retrieved \d\d:\d\d\) — listMetadata reports no such member; the org decides whether this delete fails or no-ops$/,
      ),
    );
    expect(presence!.pre_image).toMatchObject({ present: null, source: 'list' });
    expect(presence!.warnings.join(' ')).not.toContain('not present in the target');
  });

  it('S46 D1: a destructive member of a stamp-query type is "not present" only on the retrieve AND its query, and the line names both', async () => {
    const gone = { type: 'CustomField', api_name: 'Invoice__c.Gone__c' };
    const absentLine = (parsed: ReturnType<typeof jsonOf>) =>
      parsed.destructive[0]!.warnings.filter((w) => w.startsWith('not present in the target'));

    // The retrieve returned no container and the stamp query no row.
    const plain = jsonOf(await validate({ components: [], destructive: [gone] }));
    expect(plain.destructive[0]!.pre_image).toMatchObject({
      present: false,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    expect(absentLine(plain)).toEqual([
      `not present in the target (retrieved ${hhmmOf(plain.live_check!.at)}) — the retrieve ` +
        'returned nothing for it and a Tooling query on CustomField found no row; the org ' +
        'decides whether this delete fails or no-ops',
    ]);
    expect(plain.live_check!.probe_unmatched).toBeUndefined();
    // The listing is not what was consulted, and it is not named.
    expect(listedTypes()).not.toContain('CustomField');
    expect(presentedPages[0]!).not.toContain('listMetadata reports no such member');
    // A member the org lacks has no stamp to be missing: the page-top dates
    // line names only members the org holds, so it is not printed for this one.
    expect(topWarnings().filter((w) => w.startsWith('Live diff is against the org'))).toEqual([]);
    expect(presentedPages[0]!).not.toContain('last-modified stamps were unavailable');

    // The query returned the member's name, under a namespace the package did
    // not name: Contrail cannot say whose row that is, so "found no row" is
    // never printed about it — the row gets no absence line at all.
    probeRows = {
      CustomField: [{ name: 'Gone', parent: 'Invoice__c', ns: 'ns', date: '2026-11-12T08:00:00.000+0000', by: 'Alice Example' }],
    };
    const unmatched = jsonOf(await validate({ components: [], destructive: [gone] }));
    expect(unmatched.destructive[0]!.pre_image).toMatchObject({ present: false, last_modified_date: null });
    expect(absentLine(unmatched)).toEqual([]);
    expect(unmatched.live_check!.probe_unmatched).toEqual(['CustomField:Invoice__c.Gone__c']);
    expect(presentedPages[1]!).not.toContain('not present in the target');
    expect(presentedPages[1]!).not.toContain('found no row');

    // The stamp query failed: no row is not "no row was found".
    probeRows = {};
    probeMode = 'fault';
    const failed = jsonOf(await validate({ components: [], destructive: [gone] }));
    expect(failed.destructive[0]!.pre_image).toMatchObject({ present: false });
    expect(absentLine(failed)).toEqual([]);
    expect(Object.keys(failed.live_check!.probe_failures as object)).toEqual(['CustomField']);

    // No stamp query can name the member (a field name with no __c): nothing
    // was asked about it, so nothing is said.
    probeMode = 'ok';
    const before = restQueries.length;
    const unnamed = jsonOf(
      await validate({ components: [], destructive: [{ type: 'CustomField', api_name: 'Invoice__c.Gone' }] }),
    );
    expect(restQueries).toHaveLength(before);
    expect(absentLine(unnamed)).toEqual([]);
  });

  it('a page-wide diff budget: once spent, later rows keep their summary line and counts only', async () => {
    const wide = (ch: string) =>
      `public class X {\n${Array.from({ length: 60 }, (_, i) => `// ${ch.repeat(230)} ${i}`).join('\n')}\n}\n`;
    const names = Array.from({ length: 12 }, (_, i) => `Big${i}`);
    const SAME = 'public class Same {\n}\n';
    liveFiles = {
      ...Object.fromEntries(names.map((n) => [`classes/${n}.cls`, wide('a')])),
      'classes/Same.cls': SAME,
    };
    listRows = {
      ApexClass: [...names, 'Same'].map((n) => ({ fullName: n, date: '2026-11-10T09:30:00.000Z', by: 'Bob' })),
    };
    await validate({
      components: [
        ...names.map((n) => ({ type: 'ApexClass', api_name: n, content: wide('b') })),
        { type: 'ApexClass', api_name: 'Same', content: SAME },
      ],
    });
    const view = notifier.calls[0]!.view;
    // A row identical to the live version has no body to omit: after the
    // budget is spent it is still "identical", never truncated or noted.
    expect(view.changes[12]!.diff).toEqual({
      format: 'text',
      identical: true,
      baseline_label: expect.stringMatching(/^diff vs live org/),
      summary: 'identical to the live version',
      truncated: false,
    });
    const diffs = view.changes.slice(0, 12).map((r) => r.diff!);
    expect(diffs[0]!.text_hunks!.length).toBeGreaterThan(0);
    const omitted = diffs.filter((d) => d.text_hunks === undefined);
    expect(omitted.length).toBeGreaterThan(0);
    for (const d of omitted) {
      expect(d.truncated).toBe(true);
      expect(d.summary).toMatch(/· \+60 \/ −60 lines$/);
      expect(d.note).toMatch(/150 KB diff budget/);
    }
    const bodies = diffs.reduce((n, d) => n + JSON.stringify(d.text_hunks ?? []).length, 0);
    expect(bodies).toBeLessThanOrEqual(150_000);
  });

  it('cancel: the retrieve polls WHILE checkOnly runs, and a validate that throws stops it (no checkRetrieveStatus after the rejection)', async () => {
    retrieveMode = 'never';
    deployMode = 'http500AfterPolls';
    const result = await validate({ components: [foo()] });
    expect(result.isError).toBe(true);
    // The deploy's own error — the retrieve path never rejects.
    expect(textOf(result)).toContain('Metadata API HTTP 500');
    expect(soapBodies.some((b) => b.includes('<met:retrieve>'))).toBe(true);
    const atRejection = statusCalls;
    // The retrieve was polling while the checkOnly deploy was in flight.
    expect(atRejection).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(statusCalls).toBe(atRejection);
    expect(presentedPages).toHaveLength(0);
  });
});

describe('S45 F1 review fixes: warnings follow the LIVE baseline, the Aura live checks, dates', () => {
  const fieldWith = (type: string, label?: string) =>
    `<fields>\n        <fullName>Status__c</fullName>\n` +
    (label ? `        <label>${label}</label>\n` : '') +
    `        <type>${type}</type>\n    </fields>`;
  const fieldComponent = (content: string) => ({
    type: 'CustomField',
    api_name: 'Invoice__c.Status__c',
    content,
  });
  const seedField = (type: string) =>
    seedSnapshot({ 'objects/Invoice__c.object': objectXml(type) }, [
      {
        type: 'CustomField',
        apiName: 'Invoice__c.Status__c',
        filePath: 'objects/Invoice__c.object',
        lastModifiedDate: '2026-11-10T09:30:00.000Z',
        lastModifiedBy: 'Bob',
      },
    ]);
  /** S46 D1: the field's stamp comes from its stamp query, never a CustomField listing. */
  const statusStamp = (date: string): Record<string, ProbeRow[]> => ({
    CustomField: [{ name: 'Status', parent: 'Invoice__c', date, by: 'Bob' }],
  });

  it('a MODIFY that stays MODIFY gains the FIELD TYPE CHANGE the LIVE type triggers (snapshot Text, live Number)', async () => {
    seedField('Text');
    liveFiles = { 'objects/Invoice__c.object': objectXml('Number') };
    probeRows = statusStamp('2026-11-12T09:30:00.000+0000');
    const parsed = jsonOf(await validate({ components: [fieldComponent(fieldWith('Text', 'New label'))] }));
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings[0]).toMatch(/^CHANGED IN TARGET SINCE YOUR SNAPSHOT/);
    expect(entry.warnings).toContain(
      'FIELD TYPE CHANGE Number → Text — possible irreversible data loss',
    );
  });

  it('…and loses the stale one the snapshot type triggered (snapshot Number, live Text)', async () => {
    seedField('Number');
    liveFiles = { 'objects/Invoice__c.object': objectXml('Text') };
    probeRows = statusStamp('2026-11-12T09:30:00.000+0000');
    const parsed = jsonOf(await validate({ components: [fieldComponent(fieldWith('Text', 'New label'))] }));
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings.join(' ')).not.toContain('FIELD TYPE CHANGE');
  });

  it('a bundle MODIFY: BUNDLE REPLACE lists the files the LIVE copy has (removed: helper.js), not the snapshot delta', async () => {
    const lwcSnap = Object.fromEntries(Object.entries(LWC_FILES).map(([k, v]) => [`lwc/myCmp/${k}`, v]));
    seedSnapshot(lwcSnap, [
      { type: 'LightningComponentBundle', apiName: 'myCmp', filePath: 'lwc/myCmp/myCmp.js', lastModifiedDate: '2026-11-03T10:00:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { ...lwcSnap, 'lwc/myCmp/helper.js': 'export const x = 1;\n' };
    listRows = { LightningComponentBundle: [{ fullName: 'myCmp', date: '2026-11-03T10:00:00.000Z', by: 'Bob' }] };
    const proposed = { ...LWC_FILES, 'myCmp.html': '<template>\n    <p>changed</p>\n</template>\n' };
    const parsed = jsonOf(
      await validate({
        components: [{ type: 'LightningComponentBundle', api_name: 'myCmp', content: envelope(proposed) }],
      }),
    );
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings).toContain(
      "BUNDLE REPLACE — this deploy replaces the org's whole LightningComponentBundle directory " +
        '(3 files; changed: myCmp.html; removed: helper.js).',
    );
  });

  it('live byte-equal to the snapshot: the warnings are exactly analyzeChanges’ (a no-op)', async () => {
    seedField('Number');
    liveFiles = { 'objects/Invoice__c.object': objectXml('Number') };
    probeRows = statusStamp('2026-11-10T09:30:00.000+0000');
    const component = fieldComponent(fieldWith('Text', 'New label'));
    const dry = jsonOf(await validate({ components: [component], dry_run: true }));
    const real = jsonOf(await validate({ components: [component] }));
    expect(real.changes[0]!.change).toBe('modify');
    expect(real.changes[0]!.warnings).toEqual(dry.changes[0]!.warnings);
    expect(real.changes[0]!.warnings).toContain(
      'FIELD TYPE CHANGE Number → Text — possible irreversible data loss',
    );
  });

  it('MODIFY → UNCHANGED_CONTENT drops the stale WHOLE-DOCUMENT REPLACE (Layout)', async () => {
    const layout = (v: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<Layout ${MD}>\n    <showRunAssignmentRulesCheckbox>${v}</showRunAssignmentRulesCheckbox>\n</Layout>\n`;
    seedSnapshot({ 'layouts/Account-Main.layout': layout('false') }, [
      { type: 'Layout', apiName: 'Account-Main', filePath: 'layouts/Account-Main.layout', lastModifiedDate: '2026-11-10T09:30:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'layouts/Account-Main.layout': layout('true') };
    listRows = { Layout: [{ fullName: 'Account-Main', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(
      await validate({ components: [{ type: 'Layout', api_name: 'Account-Main', content: layout('true') }] }),
    );
    expect(parsed.changes[0]!.change).toBe('unchanged_content');
    expect(parsed.changes[0]!.warnings).toEqual([]);
  });

  it('MODIFY → UNCHANGED_CONTENT drops BUNDLE REPLACE and the Aura compile advisory', async () => {
    const auraSnap = {
      'aura/myAura/myAura.cmp': '<aura:component>\n    <p>old</p>\n</aura:component>\n',
      'aura/myAura/myAura.cmp-meta.xml': AURA_META,
    };
    seedSnapshot(auraSnap, [
      { type: 'AuraDefinitionBundle', apiName: 'myAura', filePath: 'aura/myAura/myAura.cmp', lastModifiedDate: '2026-11-03T11:00:00.000Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = Object.fromEntries(Object.entries(AURA_FILES).map(([k, v]) => [`aura/myAura/${k}`, v]));
    listRows = { AuraDefinitionBundle: [{ fullName: 'myAura', date: '2026-11-03T11:00:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(
      await validate({
        components: [{ type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(AURA_FILES) }],
      }),
    );
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('unchanged_content');
    expect(entry.warnings.some((w) => w.startsWith('BUNDLE REPLACE'))).toBe(false);
    expect(entry.warnings.some((w) => w.startsWith('The deploy compiles markup and design'))).toBe(false);
  });

  it('Aura, Tooling down: a row the live retrieve classified never says its classification is from the snapshot only', async () => {
    toolingMode = 'fail';
    liveFiles = Object.fromEntries(Object.entries(AURA_FILES).map(([k, v]) => [`aura/myAura/${k}`, v]));
    listRows = { AuraDefinitionBundle: [{ fullName: 'myAura', date: '2026-11-03T11:00:00.000Z', by: 'Bob' }] };
    const changed = { ...AURA_FILES, 'myAura.cmp': '<aura:component>\n    <p>new</p>\n</aura:component>\n' };
    const parsed = jsonOf(
      await validate({
        components: [{ type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(changed) }],
      }),
    );
    const entry = parsed.changes[0]!;
    expect(entry.change).toBe('modify');
    expect(entry.warnings[0]).toMatch(/^EXISTS IN TARGET — this deploy OVERWRITES a live AuraDefinitionBundle myAura/);
    expect(entry.warnings.join(' ')).not.toContain('classification is from the local snapshot only');
    expect(entry.warnings).toContainEqual(
      expect.stringMatching(
        /^the Tooling live check for "myAura" could not complete \(.+\) — the LWC NAME COLLISION check may not have run; the ADD\/MODIFY classification above comes from the live Metadata API retrieve\.$/,
      ),
    );

    // The retrieve itself failing: the snapshot-only sentence stays true.
    retrieveMode = 'fault';
    const degraded = jsonOf(
      await validate({
        components: [{ type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(changed) }],
      }),
    );
    expect(degraded.changes[0]!.warnings.join(' ')).toContain(
      'classification is from the local snapshot only',
    );
  });

  it('Aura KIND CHANGE against the live retrieve: the org holds a .app, the envelope is a .cmp — refused, no code', async () => {
    toolingMode = 'fail';
    liveFiles = {
      'aura/myAura/myAura.app': '<aura:application>\n</aura:application>\n',
      'aura/myAura/myAura.app-meta.xml': AURA_META,
    };
    listRows = { AuraDefinitionBundle: [{ fullName: 'myAura', date: '2026-11-03T11:00:00.000Z', by: 'Bob' }] };
    const result = await validate({
      components: [{ type: 'AuraDefinitionBundle', api_name: 'myAura', content: envelope(AURA_FILES) }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "AuraDefinitionBundle myAura: the ORG's bundle is .app (live retrieve) and this envelope is " +
        ".cmp — changing a bundle's kind under the same name is untested platform behavior.",
    );
    expect(presentedPages).toHaveLength(0);
    expect(db.queryAuditEvents({}).some((e) => e.eventType === 'deploy.validated')).toBe(false);
  });

  it('the same instant written two ways is not a change (stamps compare as epoch ms)', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls', lastModifiedDate: '2026-11-10T09:30:00Z', lastModifiedBy: 'Bob' },
    ]);
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const result = await validate({ components: [foo()] });
    const parsed = jsonOf(result);
    expect(parsed.changes[0]!.change).toBe('modify');
    expect(textOf(result)).not.toContain('CHANGED IN TARGET');
    expect(textOf(result)).not.toContain('live bytes differ');
    expect(textOf(result)).not.toContain('since your snapshot');
    const page = presentedPages[0]!;
    expect(page).not.toContain('CHANGED IN TARGET');
    expect(page).not.toContain('live bytes differ');
    expect(page).not.toContain('since your snapshot');
  });

  it('the degrade banner names the RANGE of snapshot dates when the members were retrieved at different times', async () => {
    seedSnapshot({ 'classes/Foo.cls': FOO_OLD, 'classes/Bar.cls': FOO_OLD.replace('Foo', 'Bar') }, [
      { type: 'ApexClass', apiName: 'Foo', filePath: 'classes/Foo.cls' },
      { type: 'ApexClass', apiName: 'Bar', filePath: 'classes/Bar.cls' },
    ]);
    const LATER = '2026-11-08T12:00:00.000Z';
    db.replaceArtifactsForTypes(
      connId,
      ['ApexClass'],
      db
        .listArtifacts(connId, 'ApexClass')
        .map((r) => ({ ...r, content: '', retrievedAt: r.apiName === 'Bar' ? LATER : SNAP_AT })),
    );
    retrieveMode = 'fault';
    await validate({
      components: [foo(), { type: 'ApexClass', api_name: 'Bar', content: FOO_PROPOSED.replace('Foo', 'Bar') }],
    });
    expect(presentedPages[0]!).toMatch(
      new RegExp(
        String.raw`compared against your snapshot from ${SNAP_DAY} \d\d:\d\d to ${localDay(LATER)} \d\d:\d\d; the org was not re-read\.`,
      ),
    );
  });
});

describe('S46 D1: stamps from per-member queries — failures, the one dates line, the retrieve note', () => {
  const statusField = { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD };
  const industry = {
    type: 'CustomField',
    api_name: 'Account.Industry',
    content: fieldBlock('Industry', 'Picklist'),
  };
  const RULE_BLOCK =
    '<validationRules>\n        <fullName>Positive_Amount</fullName>\n        <active>true</active>\n' +
    '        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>\n' +
    '        <errorMessage>Amount must be positive</errorMessage>\n    </validationRules>';
  const rule = { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount', content: RULE_BLOCK };
  const RULE_STAMP_QUERY =
    'SELECT Id, ValidationName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
    "ValidationRule WHERE (ValidationName = 'Positive_Amount' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";
  const LIST_VIEW_BLOCK =
    '<listViews>\n        <fullName>Open_Invoices</fullName>\n        <filterScope>Everything</filterScope>\n' +
    '        <label>Open invoices</label>\n    </listViews>';
  const listView = { type: 'ListView', api_name: 'Invoice__c.Open_Invoices', content: LIST_VIEW_BLOCK };
  const STAMP_QUERY_DOWN =
    /^Salesforce API error 500 on \/services\/data\/v[\d.]+\/tooling\/query: stamp query down$/;
  /** The page-top dates-unavailable lines of the last validate (never more than one). */
  const datesLines = () => topWarnings().filter((w) => w.startsWith('Live diff is against the org'));
  const failureOf = (parsed: ReturnType<typeof jsonOf>, type: string) =>
    String((parsed.live_check!.probe_failures as Record<string, string>)[type]);

  it('a failed stamp query: the one dates line gives its reason, live_check.probe_failures names the type, and no listing is asked instead', async () => {
    liveFiles = { 'objects/Invoice__c.object': partialObject(STATUS_FIELD) };
    // The org has a row — the query that would return it fails.
    probeRows = { CustomField: [{ name: 'Status', parent: 'Invoice__c', date: '2026-11-12T08:00:00.000+0000', by: 'Bob' }] };
    probeMode = 'fault';
    const parsed = jsonOf(await validate({ components: [statusField] }));

    // The retrieve still decided presence and content: a live diff, no stamp.
    expect(parsed.live_check).toMatchObject({
      status: 'ok',
      stamp_scheme: 2,
      dates_unavailable_types: ['CustomField'],
    });
    expect(parsed.live_check!.dates_unavailable).toBeUndefined();
    const reason = failureOf(parsed, 'CustomField');
    expect(reason).toMatch(STAMP_QUERY_DOWN);
    expect(parsed.changes[0]!.pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
      last_modified_by: null,
      comparable: true,
    });

    expect(datesLines()).toEqual([
      datesLine(parsed.live_check!.at, `CustomField (the stamp query failed: ${reason})`),
    ]);
    const page = presentedPages[0]!;
    expect(page).toContain(
      'last-modified stamps were unavailable for CustomField (the stamp query failed: Salesforce API error 500 on',
    );
    // Not the listing's reason, and never "not re-read": the retrieve answered.
    expect(page).not.toContain('listMetadata reported INVALID_TYPE');
    expect(page).not.toContain('the org was not re-read');
    expect(page).not.toContain('Bob');

    // No fallback: the failed query is not replaced by the org-wide listing.
    expect(listedTypes()).not.toContain('CustomField');
    expect(restQueries).toEqual([STATUS_STAMP_QUERY]);
  });

  it('a standard field rides its parent document and no stamp query names it; the page says Contrail has no stamp query for it', async () => {
    liveFiles = {
      'objects/Account.object': partialObject(fieldBlock('Industry', 'Picklist'), fieldBlock('Rating', 'Picklist')),
    };
    const parsed = jsonOf(await validate({ components: [industry] }));

    expect(lastRetrieveBody()).toContain('<met:members>Account</met:members><met:name>CustomObject</met:name>');
    expect(lastRetrieveBody()).not.toContain('<met:name>CustomField</met:name>');
    expect(restQueries).toEqual([]);
    expect(listedTypes()).not.toContain('CustomField');
    expect(parsed.changes[0]!.pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
    });
    // Nothing failed — no query was issued — so the type is in neither list.
    expect(parsed.live_check!.dates_unavailable_types).toEqual([]);
    expect(parsed.live_check!.probe_failures).toBeUndefined();

    expect(datesLines()).toEqual([
      datesLine(
        parsed.live_check!.at,
        'CustomField Account.Industry (Contrail has no stamp query for them)',
      ),
    ]);
    const page = presentedPages[0]!;
    expect(page).toContain('for CustomField Account.Industry (Contrail has no stamp query for them)');
    // No query ran, so nothing may say one "returned no" stamp.
    expect(page).not.toContain('returned no');
    expect(page).not.toContain('stamp query failed');
  });

  it('a custom field the retrieve returned whose query gave it no stamp: "returned no usable stamp" — for zero rows and for a row under another namespace alike', async () => {
    liveFiles = { 'objects/Invoice__c.object': partialObject(STATUS_FIELD) };
    const expected = 'CustomField Invoice__c.Status__c (the stamp query returned no usable stamp for them)';

    // Zero rows.
    const zero = jsonOf(await validate({ components: [statusField] }));
    expect(restQueries).toEqual([STATUS_STAMP_QUERY]);
    expect(zero.changes[0]!.pre_image).toMatchObject({ present: true, last_modified_date: null });
    expect(zero.live_check!.dates_unavailable_types).toEqual([]);
    expect(zero.live_check!.probe_unmatched).toBeUndefined();
    expect(datesLines()).toEqual([datesLine(zero.live_check!.at, expected)]);
    expect(presentedPages[0]!).not.toContain('Contrail has no stamp query');

    // Only a same-name row under a namespace the package did not name: never
    // a stamp, never "absent" while the block is there — and recorded.
    probeRows = {
      CustomField: [{ name: 'Status', parent: 'Invoice__c', ns: 'ns', date: '2026-11-12T08:00:00.000+0000', by: 'Alice Example' }],
    };
    const unmatched = jsonOf(await validate({ components: [statusField] }));
    expect(unmatched.changes[0]!.pre_image).toMatchObject({
      present: true,
      last_modified_date: null,
      last_modified_by: null,
    });
    expect(unmatched.live_check!.probe_unmatched).toEqual(['CustomField:Invoice__c.Status__c']);
    expect(datesLines()).toEqual([datesLine(unmatched.live_check!.at, expected)]);
    expect(presentedPages[1]!).not.toContain('Alice Example');
  });

  it('ONE dates line however many reasons: an unlistable type, a failed stamp query and a standard field are three groups of one sentence', async () => {
    liveFiles = {
      'classes/Foo.cls': FOO_OLD,
      'classes/Foo.cls-meta.xml': APEX_META,
      'objects/Invoice__c.object': partialObject(RULE_BLOCK),
      'objects/Account.object': partialObject(fieldBlock('Industry', 'Picklist')),
    };
    invalidTypes = new Set(['ApexClass']);
    probeMode = 'fault';
    const parsed = jsonOf(await validate({ components: [foo(), rule, industry] }));

    expect(parsed.live_check).toMatchObject({
      status: 'ok',
      dates_unavailable_types: ['ApexClass', 'ValidationRule'],
    });
    const reason = failureOf(parsed, 'ValidationRule');
    expect(reason).toMatch(STAMP_QUERY_DOWN);
    expect(Object.keys(parsed.live_check!.probe_failures as object)).toEqual(['ValidationRule']);
    // Only the rule was queried; nothing names the standard field.
    expect(restQueries).toEqual([RULE_STAMP_QUERY]);

    expect(datesLines()).toEqual([
      datesLine(
        parsed.live_check!.at,
        'ApexClass (listMetadata reported INVALID_TYPE); ' +
          `ValidationRule (the stamp query failed: ${reason}); ` +
          'CustomField Account.Industry (Contrail has no stamp query for them)',
      ),
    ]);
    // The page-top list is the permission warning and that one line: three
    // reasons did not become three lines, so a row warning keeps its slot in
    // the phone push (which takes three warnings, page-top lines first).
    expect(topWarnings()).toHaveLength(2);
    expect(topWarnings()[0]).toBe(parsed.permission_warning);
    const page = presentedPages[0]!;
    expect(page.split('Live diff is against the org').length - 1).toBe(1);
  });

  it('a member no stamp query named is said so even when the query of its OWN type failed: a standard field is never put down to a failure that did not name it', async () => {
    liveFiles = {
      'objects/Invoice__c.object': partialObject(STATUS_FIELD),
      'objects/Account.object': partialObject(fieldBlock('Industry', 'Picklist')),
    };
    probeMode = 'fault';
    const parsed = jsonOf(await validate({ components: [statusField, industry] }));

    // One query was issued — for the custom field — and it failed; nothing
    // was asked about the standard field.
    expect(restQueries).toEqual([STATUS_STAMP_QUERY]);
    const reason = failureOf(parsed, 'CustomField');
    expect(reason).toMatch(STAMP_QUERY_DOWN);
    expect(parsed.live_check!.dates_unavailable_types).toEqual(['CustomField']);
    expect(parsed.changes.map((c) => c.pre_image)).toMatchObject([
      { present: true, stamp_source: 'tooling:CustomField', last_modified_date: null },
      { present: true, stamp_source: 'tooling:CustomField', last_modified_date: null },
    ]);

    // The type's group carries the failure; the standard field keeps its own
    // group and its own reason, and the custom field is not listed twice.
    expect(datesLines()).toEqual([
      datesLine(
        parsed.live_check!.at,
        `CustomField (the stamp query failed: ${reason}); ` +
          'CustomField Account.Industry (Contrail has no stamp query for them)',
      ),
    ]);
    expect(datesLines()[0]).not.toContain('Invoice__c.Status__c');
    expect(datesLines()[0]).not.toContain('returned no usable stamp');
  });

  it('a listing that threw says nothing about a stamp query: only the listing-sourced types carry its reason, and the field keeps its stamp', async () => {
    liveFiles = {
      'classes/Foo.cls': FOO_OLD,
      'classes/Foo.cls-meta.xml': APEX_META,
      'objects/Invoice__c.object': partialObject(STATUS_FIELD),
    };
    probeRows = { CustomField: [{ name: 'Status', parent: 'Invoice__c', date: '2026-11-12T08:00:00.000+0000', by: 'Bob' }] };
    listMode = 'fault';
    const parsed = jsonOf(await validate({ components: [foo(), statusField] }));

    const listingReason = String(parsed.live_check!.dates_unavailable);
    expect(listingReason).toContain('no metadata api for you');
    expect(parsed.live_check!.dates_unavailable_types).toEqual([]);
    expect(parsed.changes[0]!.pre_image).toMatchObject({ present: true, last_modified_date: null });
    expect(parsed.changes[1]!.pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: '2026-11-12T08:00:00.000Z',
      last_modified_by: 'Bob',
    });
    expect(datesLines()).toEqual([
      datesLine(parsed.live_check!.at, `ApexClass (${listingReason.slice(0, 160)})`),
    ]);
    expect(datesLines()[0]).not.toContain('CustomField');
  });

  it('stamp queries that failed for the same reason share one group; a different reason is its own group', async () => {
    liveFiles = { 'objects/Invoice__c.object': partialObject(STATUS_FIELD, RULE_BLOCK, LIST_VIEW_BLOCK) };
    probeMode = 'fault';
    const parsed = jsonOf(await validate({ components: [statusField, rule, listView] }));
    // The two Tooling queries failed alike; the ListView query is a Data API
    // call, so its reason names another path.
    const tooling = failureOf(parsed, 'CustomField');
    const data = failureOf(parsed, 'ListView');
    expect(tooling).toMatch(STAMP_QUERY_DOWN);
    expect(failureOf(parsed, 'ValidationRule')).toBe(tooling);
    expect(data).toMatch(/^Salesforce API error 500 on \/services\/data\/v[\d.]+\/query: stamp query down$/);
    expect(parsed.live_check!.dates_unavailable_types).toEqual(['CustomField', 'ListView', 'ValidationRule']);
    expect(datesLines()).toEqual([
      datesLine(
        parsed.live_check!.at,
        `CustomField, ValidationRule (the stamp query failed: ${tooling}); ` +
          `ListView (the stamp query failed: ${data})`,
      ),
    ]);
    // Members of a type whose query failed are covered by that type's group:
    // none is listed again as "returned no usable stamp".
    expect(datesLines()[0]).not.toContain('returned no usable stamp');
    expect(listedTypes()).toEqual([]);
  });

  it('a long member group names the first ten and counts the rest', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `Std${String(i + 1).padStart(2, '0')}`);
    liveFiles = { 'objects/Account.object': partialObject(...names.map((n) => fieldBlock(n))) };
    const parsed = jsonOf(
      await validate({
        components: names.map((n) => ({
          type: 'CustomField',
          api_name: `Account.${n}`,
          content: fieldBlock(n),
        })),
      }),
    );
    expect(restQueries).toEqual([]);
    expect(datesLines()).toEqual([
      datesLine(
        parsed.live_check!.at,
        `${names
          .slice(0, 10)
          .map((n) => `CustomField Account.${n}`)
          .join(', ')} and 2 more (Contrail has no stamp query for them)`,
      ),
    ]);
  });

  it('a ListView is stamped through the Data API and a rule and a label through Tooling — one query each, and no listing at all', async () => {
    const LABEL_BLOCK =
      '<labels>\n        <fullName>Greeting</fullName>\n        <language>en_US</language>\n' +
      '        <protected>false</protected>\n        <shortDescription>Greeting</shortDescription>\n' +
      '        <value>Hello</value>\n    </labels>';
    liveFiles = {
      'objects/Invoice__c.object': partialObject(LIST_VIEW_BLOCK, RULE_BLOCK),
      'labels/CustomLabels.labels': `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels ${MD}>\n    ${LABEL_BLOCK}\n</CustomLabels>\n`,
    };
    probeRows = {
      ListView: [{ name: 'Open_Invoices', parent: 'Invoice__c', date: '2026-11-11T08:00:00.000+0000', by: 'Bob' }],
      ValidationRule: [{ name: 'Positive_Amount', parent: 'Invoice__c', date: '2026-11-12T08:00:00.000+0000', by: 'Alice Example' }],
      // A row with no user: the stamp stands, the name is null.
      ExternalString: [{ name: 'Greeting', date: '2026-11-13T08:00:00.000+0000', by: null }],
    };
    const parsed = jsonOf(
      await validate({
        components: [listView, rule, { type: 'CustomLabel', api_name: 'Greeting', content: LABEL_BLOCK }],
      }),
    );
    expect(parsed.changes.map((c) => c.pre_image)).toMatchObject([
      { present: true, stamp_source: 'data:ListView', last_modified_date: '2026-11-11T08:00:00.000Z', last_modified_by: 'Bob' },
      { present: true, stamp_source: 'tooling:ValidationRule', last_modified_date: '2026-11-12T08:00:00.000Z', last_modified_by: 'Alice Example' },
      { present: true, stamp_source: 'tooling:ExternalString', last_modified_date: '2026-11-13T08:00:00.000Z', last_modified_by: null },
    ]);
    expect(parsed.live_check).toMatchObject({ status: 'ok', dates_unavailable_types: [] });
    expect(parsed.live_check!.probe_failures).toBeUndefined();
    expect([...restQueries].sort()).toEqual(
      [
        'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
          "ListView WHERE (SobjectType = 'Invoice__c' AND DeveloperName = 'Open_Invoices')",
        RULE_STAMP_QUERY,
        'SELECT Id, Name, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ' +
          "ExternalString WHERE Name = 'Greeting'",
      ].sort(),
    );
    // Every member is of a stamp-query type: listMetadata is never called.
    expect(listedTypes()).toEqual([]);
    expect(datesLines()).toEqual([]);
  });

  it('the retrieve’s own messages ride live_check.retrieve_note and reach neither the page nor the phone', async () => {
    const newField = { type: 'CustomField', api_name: 'Invoice__c.New__c', content: fieldBlock('New__c') };
    const problem = "Entity of type 'CustomField' named 'Invoice__c.New__c' cannot be found";
    retrieveProblems = [problem];
    // (liveFiles is empty: the zip holds only package.xml.)
    const result = await validate({ components: [newField] });
    const parsed = jsonOf(result);
    expect(parsed.live_check).toMatchObject({ status: 'ok', stamp_scheme: 2 });
    expect(parsed.live_check!.retrieve_note).toBe(
      "The org's retrieve returned 1 message(s) — reported as sent; Contrail does not decide " +
        `what exists from them: ${problem}`,
    );
    // The note decides nothing: the member is an ADD because the retrieve
    // returned no block and its stamp query no row.
    expect(parsed.changes[0]).toMatchObject({ change: 'add', pre_image: { present: false } });
    // An ADD of a member the org lacks is not a member with a missing stamp:
    // the dates line names only members the org holds, so none is printed.
    expect(datesLines()).toEqual([]);

    const page = presentedPages[0]!;
    expect(page).not.toContain('last-modified stamps were unavailable');
    expect(page).not.toContain('cannot be found');
    expect(page).not.toContain('retrieve returned');
    const view = notifier.calls[0]!.view;
    expect(JSON.stringify(view)).not.toContain('cannot be found');
    expect(composePushover(view, { includeCode: true, summary: 'full' }).message).not.toContain(
      'cannot be found',
    );
    // Persisted with the request, as the result carries it.
    const request = db.findRequestByCode(connId, 'deploy', codeFromPage(page))!;
    const summary = JSON.parse(request.summaryJson) as { live_check: Record<string, unknown> };
    expect(summary.live_check).toEqual(parsed.live_check);

    // A retrieve that FAILED and said why: the note rides the unavailable
    // live check too, and the banner does not quote it.
    retrieveMode = 'failed';
    const failed = jsonOf(await validate({ components: [newField] }));
    expect(failed.live_check).toMatchObject({
      status: 'unavailable',
      reason: 'retrieve_failed:boom',
      stamp_scheme: 2,
    });
    expect(String(failed.live_check!.retrieve_note)).toContain(problem);
    expect(presentedPages[1]!).toContain('LIVE COMPARISON UNAVAILABLE (retrieve_failed:boom)');
    expect(presentedPages[1]!).not.toContain('cannot be found');
  });
});

describe('S46 D3: permission_warning says what the live check knows', () => {
  const IN_ORG_FOO =
    'This package includes 1 component(s) that are already in the org and need permissions to ' +
    'be usable, and no permission set or profile for them — who can use them depends on the ' +
    'permissions already in the org, which Contrail did not check: ApexClass:Foo (Apex class access).';
  const NOT_CONFIRMED_FOO =
    'This package includes 1 component(s) that need permissions to be usable and no permission ' +
    'set or profile to grant them. Contrail did not confirm whether they already exist in the ' +
    'org — any that are new will deploy but stay invisible or inaccessible until you set ' +
    'permissions (deploy a permission set alongside, or grant FLS/access afterward): ' +
    'ApexClass:Foo (Apex class access).';

  it('a class the org already has is "already in the org", never "adds"; a new one is added; with no live check Contrail says it did not confirm', async () => {
    // The org has it and the snapshot does not: EXISTS IN TARGET.
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const existing = jsonOf(await validate({ components: [foo()] }));
    expect(existing.changes[0]!.warnings[0]).toMatch(/^EXISTS IN TARGET/);
    expect(existing.permission_warning).toBe(IN_ORG_FOO);
    expect(existing.permission_warning).not.toContain('adds');
    // The page-top line is that same sentence.
    expect(topWarnings()[0]).toBe(IN_ORG_FOO);
    expect(presentedPages[0]!).toContain('are already in the org and need permissions to be usable');
    expect(presentedPages[0]!).not.toContain('This package adds');

    // The org does not have it: the package adds it.
    liveFiles = {};
    listRows = { ApexClass: [] };
    const fresh = jsonOf(await validate({ components: [foo()] }));
    expect(fresh.changes[0]!.pre_image).toMatchObject({ present: false });
    expect(fresh.permission_warning).toBe(
      'This package adds 1 component(s) that need permissions but includes no permission set ' +
        'or profile to grant them — they will deploy but stay invisible or inaccessible until ' +
        'you set permissions (deploy a permission set alongside, or grant FLS/access ' +
        'afterward): ApexClass:Foo (Apex class access).',
    );

    // The live check was unavailable: nothing was placed.
    retrieveMode = 'fault';
    const degraded = jsonOf(await validate({ components: [foo()] }));
    expect(degraded.live_check).toMatchObject({ status: 'unavailable' });
    expect(degraded.permission_warning).toBe(NOT_CONFIRMED_FOO);

    // A dry run never re-reads the org — even with the class sitting there.
    retrieveMode = 'ok';
    liveFiles = { 'classes/Foo.cls': FOO_OLD, 'classes/Foo.cls-meta.xml': APEX_META };
    listRows = { ApexClass: [{ fullName: 'Foo', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const dry = jsonOf(await validate({ components: [foo()], dry_run: true }));
    expect(dry.live_check).toBeNull();
    expect(dry.permission_warning).toBe(NOT_CONFIRMED_FOO);
    expect(dry.permission_warning).not.toContain('adds');
  });

  it('fields authored inline in an object are placed by the object’s live document: in the org where it holds their block, new where it does not', async () => {
    const proposed =
      `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
      `    ${fieldBlock('Status__c')}\n    ${fieldBlock('New__c')}\n` +
      '    <label>Invoice</label>\n</CustomObject>\n';
    // The org's object holds Status__c only.
    liveFiles = { 'objects/Invoice__c.object': objectXml('Text') };
    listRows = { CustomObject: [{ fullName: 'Invoice__c', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
    const parsed = jsonOf(
      await validate({ components: [{ type: 'CustomObject', api_name: 'Invoice__c', content: proposed }] }),
    );
    expect(parsed.changes[0]!.pre_image).toMatchObject({ present: true });
    expect(parsed.permission_warning).toBe(
      'This package adds 1 component(s) that need permissions but includes no permission set ' +
        'or profile to grant them — they will deploy but stay invisible or inaccessible until ' +
        'you set permissions (deploy a permission set alongside, or grant FLS/access ' +
        'afterward): CustomField:Invoice__c.New__c (field-level security (FLS)). ' +
        'This package includes 2 component(s) that are already in the org and need permissions ' +
        'to be usable, and no permission set or profile for them — who can use them depends on ' +
        'the permissions already in the org, which Contrail did not check: ' +
        'CustomObject:Invoice__c (object permissions); ' +
        'CustomField:Invoice__c.Status__c (field-level security (FLS)).',
    );

    // The object itself is new: every inline field is new with it.
    liveFiles = {};
    listRows = { CustomObject: [] };
    const fresh = jsonOf(
      await validate({ components: [{ type: 'CustomObject', api_name: 'Invoice__c', content: proposed }] }),
    );
    expect(fresh.permission_warning).toMatch(/^This package adds 3 component\(s\) that need permissions/);
    expect(fresh.permission_warning).not.toContain('already in the org');
  });
});

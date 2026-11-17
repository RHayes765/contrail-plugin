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

interface ListRow {
  fullName: string;
  date: string;
  by: string;
}

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
let retrieveMode: 'ok' | 'fault' | 'never';
let deployMode: 'ok' | 'http500AfterPolls';
let toolingMode: 'ok' | 'fail';

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
 * The deploy.test.ts / preimage.test.ts stub idioms in one: the checkOnly
 * deploy (with org-side created/completed stamps), the pre-image retrieve
 * (ok / fault / never done), and listMetadata rows per queried type with an
 * sf:INVALID_TYPE fault for any type in invalidTypes.
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
      if (toolingMode === 'fail') return new Response('tooling down', { status: 500 });
      return new Response(JSON.stringify({ done: true, records: [], totalSize: 0 }));
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
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
              `<status>Succeeded</status><success>true</success>` +
              `<zipFile>${liveZipB64()}</zipFile></result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (body.includes('<met:listMetadata>')) {
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
  deployMode = 'ok';
  toolingMode = 'ok';

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
      /^live bytes differ from your snapshot \(retrieved \d\d:\d\d\) — last-modified stamps were unavailable for this type, so Contrail cannot say who or when\.$/,
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
    expect(b.changes[0]!.warnings[0]).toMatch(/^live bytes differ from your snapshot/);
    expect(b.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(presentedPages[1]!).not.toContain('Alice Example');

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
    liveFiles = { 'objects/Invoice__c.object': objectXml('Text') };
    // The field's own stamp predates the snapshot: unchanged since it.
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: '2026-10-25T08:00:00.000Z', by: 'Bob' }] };
    const field = { type: 'CustomField', api_name: 'Invoice__c.Status__c', content: STATUS_FIELD };
    const before = jsonOf(await validate({ components: [field] }));
    expect(before.changes[0]!.warnings.join(' ')).not.toContain('CHANGED IN TARGET');
    expect(before.changes[0]!.pre_image).toMatchObject({ present: true, last_modified_date: '2026-10-25T08:00:00.000Z' });

    // Its own stamp is after the snapshot was taken: changed since it.
    liveFiles = { 'objects/Invoice__c.object': objectXml('LongTextArea') };
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: '2026-11-12T08:00:00.000Z', by: 'Alice Example' }] };
    const after = jsonOf(await validate({ components: [field] }));
    expect(after.changes[0]!.change).toBe('modify');
    expect(after.changes[0]!.warnings[0]).toMatch(/^CHANGED IN TARGET SINCE YOUR SNAPSHOT/);
    expect(viewRow('CustomField:Invoice__c.Status__c').diff).toMatchObject({ format: 'xml', identical: false });
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

    // 61 s after the snapshot, bytes differ: attributed, who/when in the detail.
    liveFiles = { 'objects/Invoice__c.object': objectXml('LongTextArea') };
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: afterSnap(61), by: 'Alice Example' }] };
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
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: afterSnap(30), by: 'Alice Example' }] };
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
    liveFiles = { 'objects/Invoice__c.object': objectXml('Text') };
    const same = jsonOf(await validate({ components: [field] }));
    expect(same.changes[0]!.change).toBe('unchanged_content');
    expect(same.changes[0]!.warnings).toEqual([]);
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
    expect(parsed.live_check).toMatchObject({ status: 'unavailable' });
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

  it('a dry run issues no retrieve or listing and leaves a pre-seeded _reverts directory untouched', async () => {
    const orphan = path.join(tmp, 'staging', '_reverts', 'not-a-known-request');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'keep.txt'), 'untouched');
    liveFiles = { 'classes/Foo.cls': FOO_OLD };
    const result = await validate({ components: [foo()], dry_run: true });
    const parsed = jsonOf(result);
    expect(parsed.request_id).toBeNull();
    expect(parsed.live_check).toBeNull();
    expect(parsed.changes[0]!.pre_image).toBeUndefined();
    expect(soapBodies.some((b) => b.includes('<met:retrieve>'))).toBe(false);
    expect(soapBodies.some((b) => b.includes('<met:listMetadata>'))).toBe(false);
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
      members: 1,
    });
    expect(Date.parse(String(parsed.live_check!.started_at))).not.toBeNaN();
    expect(Date.parse(String(parsed.live_check!.at))).toBeGreaterThanOrEqual(
      Date.parse(String(parsed.live_check!.started_at)),
    );
    expect(parsed.changes[0]!.pre_image).toMatchObject({
      present: true,
      source: 'retrieve',
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

  it('a MODIFY that stays MODIFY gains the FIELD TYPE CHANGE the LIVE type triggers (snapshot Text, live Number)', async () => {
    seedField('Text');
    liveFiles = { 'objects/Invoice__c.object': objectXml('Number') };
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: '2026-11-12T09:30:00.000Z', by: 'Bob' }] };
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
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: '2026-11-12T09:30:00.000Z', by: 'Bob' }] };
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
    listRows = { CustomField: [{ fullName: 'Invoice__c.Status__c', date: '2026-11-10T09:30:00.000Z', by: 'Bob' }] };
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

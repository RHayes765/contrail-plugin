import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { AuditLog } from '../core/audit.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { freezeExecuteRefusalText, type PolicyConfig } from '../core/policy.js';
import { AccessTokenManager } from '../salesforce/tokens.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { DeployEngine } from '../deploy/engine.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { ToolDeps } from '../tools/register.js';
import type { ConnectionRecord } from '../core/types.js';
import { REBASELINE_PROGRESS, memberSkipText, partialWriteText } from '../snapshot/members.js';
import { SEND_INVOICE_FLOW_XML } from './fixtures.js';

/**
 * S46 Part C (C3): the automatic re-baseline after a successful
 * execute_deploy, through the real MCP surface (createDeps wires the hook).
 * The revert.test.ts deploy harness with the re-baseline ON, over the
 * memberrefresh.test.ts stateful stub org: token, listMetadata, retrieve and
 * checkRetrieveStatus answer from one in-memory component list, the stamp
 * queries (Part D) from the same list, and a real deploy hands the test a
 * moment to change "the org" as the deploy would have. A developer-org
 * fixture, so Part B's built-in rule (production and unknown orgs) never
 * refuses its proposals.
 *
 * The last block is the composed execute order of integration §2.4: policy
 * check → target guard → claim → deploy → revert finalize → re-baseline.
 */

const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const ORG_STAMP = '2026-11-01T08:00:00.000Z';
const CREATED = '2026-11-14T15:00:01.000Z';
const COMPLETED = '2026-11-14T15:00:09.000Z';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TYPES = ['ApexClass', 'CustomObject', 'Flow', 'Layout'];
const CHILD_TYPES = ['CustomField', 'ValidationRule', 'ListView', 'RecordType', 'CustomLabel', 'BotVersion'];

const CLS_META =
  `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass ${MD}>` +
  '<apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n';
const SERVICE_V1 =
  'public with sharing class InvoiceService {\n  public static void run() { InvoiceSelector.load(); }\n}\n';
const SERVICE_V2 =
  'public with sharing class InvoiceService {\n  public static void run() { System.debug(1); }\n}\n';
const SERVICE_V3 =
  'public with sharing class InvoiceService {\n  public static void run() { System.debug(2); }\n}\n';
const SELECTOR =
  'public with sharing class InvoiceSelector {\n' +
  '  public static List<Invoice__c> load() { return [SELECT Id FROM Invoice__c]; }\n}\n';
const LAYOUT_V1 =
  `<?xml version="1.0" encoding="UTF-8"?>\n<Layout ${MD}>\n    <layoutSections>\n` +
  '        <label>Information</label>\n    </layoutSections>\n</Layout>\n';
const LAYOUT_V2 = LAYOUT_V1.replace('Information', 'Details');

/** A field's block as retrieve_metadata returns it (and as validate_deploy takes it). */
function fieldBlock(name: string, label: string): string {
  return (
    `<fields>\n        <fullName>${name}</fullName>\n        <label>${label}</label>\n` +
    '        <type>Text</type>\n    </fields>'
  );
}

/** The whole object document the org returns for a retrieve that names the object. */
function objectXml(fields: Array<[string, string]>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
    fields.map(([name, label]) => `    ${fieldBlock(name, label)}\n`).join('') +
    '    <label>Invoice</label>\n</CustomObject>\n'
  );
}

/** The partial container a child-typed retrieve returns: only the named blocks. */
function partialObject(blocks: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n` +
    blocks.map((b) => `    ${b}\n`).join('') +
    '</CustomObject>\n'
  );
}

const INVOICE_FIELDS: Array<[string, string]> = [
  ['Amount__c', 'Amount'],
  ['Due__c', 'Due'],
  ['Status__c', 'Status'],
];

/** The execute result's snapshot.note for `complete`, `partial`, and `none` when a unit was written (members.ts, verbatim). */
const REREAD_NOTE =
  'Dependency edges extracted FROM the re-read components were rebuilt. References TO a new or ' +
  'deleted component from other components, and the org-computed dependency data ' +
  '(MetadataComponentDependency), were not rebuilt — a whole-type refresh_snapshot does that. ' +
  'Only the components in this deploy were re-read (a child re-reads its whole parent document); ' +
  'anything else the deploy caused the org to create or change is not in the snapshot until a ' +
  'whole-type refresh_snapshot.';
const PENDING_NOTE =
  "Deployed. Contrail had not finished re-reading this deploy's components into the local " +
  'snapshot when this result was stored. If snapshot.status still reads "pending", the snapshot ' +
  "may be stale for them — run refresh_snapshot with members set to this deploy's components.";
const REBASELINE_MESSAGE =
  'The deploy has completed in the org; Contrail is still re-reading the deployed components ' +
  'into the local snapshot. Call execute_deploy again with the same connection and code to ' +
  'collect the result.';
const NOT_UPDATED = (why: string) =>
  `Deployed. The local snapshot was NOT updated for this deploy (${why}). Run refresh_snapshot ` +
  "with members set to this deploy's components to bring it up to date.";
const PARTLY = (detail: string) =>
  'Deployed. The local snapshot may be only PARTLY updated for this deploy (the re-read stopped ' +
  `while writing: ${detail}) — its files and its index can disagree for these components. Run ` +
  "refresh_snapshot with members set to this deploy's components to repair it.";

interface OrgComp {
  type: string;
  fullName: string;
  files: Record<string, string>;
  /** listMetadata's lastModifiedDate; null leaves it out of the listing row. */
  listStamp?: string | null;
  /** The retrieve's fileProperties lastModifiedDate (default: the listing stamp). */
  retrieveStamp?: string;
  /** false: listMetadata does not name it. */
  listed?: boolean;
  /** false: a retrieve returns no file for it. */
  returned?: boolean;
}

class QuietNotifier implements ApprovalNotifier {
  async notify(): Promise<NotifyOutcome> {
    return { status: 'off' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: 'none' as const, when: 'always' as const, configured: false };
  }
  resetCircuit() {}
}

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let store: SnapshotStore;
let config: ContrailConfig;
let deps: ToolDeps;
let client: Client;
let connId: string;

let org: OrgComp[];
/** The stamp each field's stamp query answers, keyed `Object.Field` (default: the object's listing stamp). */
let fieldStamps: Record<string, string>;
/** The org-computed dependency rows (MetadataComponentDependency) a whole refresh reads (default: none). */
let orgDeps: Array<{
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
}>;
let calls: { list: string[]; retrieve: string[]; status: number; soap: number; stamp: number };
/** Every URL fetched, in order — "no org read" means this stays empty. */
let fetched: string[];
/** One label per org call and per tapped step, in order (the composed test reads it). */
let events: string[];
let realDeploys: number;
let realMode: 'ok' | 'fail' | 'never';
/** Called when a real (checkOnly=false) deploy is submitted: the test changes the org as it would. */
let onRealDeploy: (() => void) | null;
let beforeFinalStatus: (() => void) | null;
let gatePromise: Promise<void> | null;
let gateRelease: () => void;
const retrieves = new Map<string, OrgComp[]>();

function armGate(): void {
  gatePromise = new Promise((resolve) => {
    gateRelease = resolve;
  });
}
function releaseGate(): void {
  gateRelease();
  gatePromise = null;
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function propXml(tag: string, c: OrgComp, stamp: string | null): string {
  return (
    `<${tag}><fullName>${c.fullName}</fullName><type>${c.type}</type>` +
    `<fileName>${Object.keys(c.files)[0] ?? ''}</fileName><id>x</id>` +
    (stamp !== null ? `<lastModifiedDate>${stamp}</lastModifiedDate>` : '') +
    `<lastModifiedByName>Dev User</lastModifiedByName></${tag}>`
  );
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

/** One field's block inside a whole object document, or null when the document has none. */
function blockOf(doc: string, field: string): string | null {
  const m = new RegExp(`<fields>\\n {8}<fullName>${field}</fullName>[\\s\\S]*?</fields>`).exec(doc);
  return m ? m[0] : null;
}

/**
 * The CustomField stamp query (Part D): answered from the object documents
 * of the stub org — one row per named field the org's document holds.
 */
function stampQueryResponse(soql: string): Response | null {
  const m =
    /^SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy\.Name FROM CustomField WHERE (.+)$/.exec(
      soql,
    );
  if (!m) return null;
  calls.stamp += 1;
  events.push('stamp:CustomField');
  const valueOf = (clause: string, column: string) =>
    new RegExp(`${column.replace(/\./g, '\\.')} = '([^']*)'`).exec(clause)?.[1];
  const wanted = m[1]!.split(' OR ').map((clause) => ({
    name: valueOf(clause, 'DeveloperName')?.toLowerCase(),
    parent: valueOf(clause, 'EntityDefinition.QualifiedApiName'),
  }));
  const records: Array<Record<string, unknown>> = [];
  for (const c of org) {
    if (c.type !== 'CustomObject' || c.returned === false) continue;
    const doc = c.files[`objects/${c.fullName}.object`] ?? '';
    for (const f of doc.matchAll(/<fields>\s*<fullName>([^<]+)<\/fullName>/g)) {
      const field = f[1]!;
      const developerName = field.replace(/__c$/, '');
      if (!wanted.some((w) => w.name === developerName.toLowerCase() && w.parent === c.fullName)) continue;
      const date = fieldStamps[`${c.fullName}.${field}`] ?? c.listStamp ?? ORG_STAMP;
      records.push({
        attributes: { type: 'CustomField' },
        Id: `stub-field-${records.length}`,
        DeveloperName: developerName,
        NamespacePrefix: null,
        LastModifiedDate: date.replace('Z', '+0000'),
        LastModifiedBy: { Name: 'Dev User' },
      });
    }
  }
  return json({ done: true, totalSize: records.length, records });
}

function stubOrg(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/services/oauth2/token')) {
      return json({
        access_token: 'AT-stub',
        instance_url: 'https://acme-dev.example.invalid',
        id: 'https://login.example.invalid/id/00D000000000000/005000000000000',
        token_type: 'Bearer',
      });
    }
    if (url.includes('/tooling/query')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      const stamp = stampQueryResponse(q);
      if (stamp) return stamp;
      // The whole refresh's dependency query, per type.
      const dep = /FROM MetadataComponentDependency WHERE MetadataComponentType = '([^']+)'$/.exec(q);
      if (dep) {
        const records = orgDeps.filter((r) => r.MetadataComponentType === dep[1]);
        return json({ done: true, records, totalSize: records.length });
      }
      // The Aura live check's read.
      return json({ done: true, records: [], totalSize: 0 });
    }
    if (/\/services\/data\/v[\d.]+\/query\?q=/.test(url)) {
      return json({ done: true, records: [], totalSize: 0 });
    }
    if (!url.includes('/services/Soap/m/')) return new Response('not found', { status: 404 });
    calls.soap += 1;
    const body = String(init?.body ?? '');
    if (body.includes('<met:deploy>')) {
      const checkOnly = body.includes('<met:checkOnly>true</met:checkOnly>');
      if (!checkOnly) {
        realDeploys += 1;
        events.push('deploy:real');
        onRealDeploy?.();
      }
      const id = checkOnly ? '0Af-check' : `0Af-real-${realDeploys}`;
      return new Response(soapEnvelope(`<deployResponse ${MD}><result><id>${id}</id></result></deployResponse>`));
    }
    if (body.includes('<met:cancelDeploy>')) {
      return new Response(
        soapEnvelope(`<cancelDeployResponse ${MD}><result><done>false</done><id>x</id></result></cancelDeployResponse>`),
      );
    }
    if (body.includes('<met:checkDeployStatus>')) {
      const id = /<met:asyncProcessId>([^<]+)</.exec(body)?.[1] ?? '';
      if (!id.startsWith('0Af-real')) return deployStatus({ done: true, success: true, checkOnly: true });
      if (realMode === 'never') return deployStatus({ done: false, success: false, checkOnly: false });
      return deployStatus({ done: true, success: realMode === 'ok', checkOnly: false });
    }
    if (body.includes('<met:listMetadata>')) {
      calls.list.push(body);
      const rows: string[] = [];
      const types: string[] = [];
      for (const q of body.matchAll(
        /<met:queries>(?:<met:folder>([^<]+)<\/met:folder>)?<met:type>([^<]+)<\/met:type><\/met:queries>/g,
      )) {
        types.push(q[2]!);
        for (const c of org) {
          if (c.type !== q[2] || c.listed === false) continue;
          rows.push(propXml('result', c, c.listStamp === undefined ? ORG_STAMP : c.listStamp));
        }
      }
      events.push(`list:${types.join(',')}`);
      return new Response(
        soapEnvelope(`<listMetadataResponse ${MD}>${rows.join('')}</listMetadataResponse>`),
      );
    }
    if (body.includes('<met:retrieve>')) {
      calls.retrieve.push(body);
      events.push('retrieve');
      const picked: OrgComp[] = [];
      const partial = new Map<string, string[]>();
      for (const t of body.matchAll(/<met:types>([\s\S]*?)<\/met:types>/g)) {
        const name = /<met:name>([^<]+)<\/met:name>/.exec(t[1]!)![1]!;
        for (const m of t[1]!.matchAll(/<met:members>([^<]+)<\/met:members>/g)) {
          const member = m[1]!;
          if (name === 'CustomField') {
            // Part D's child-typed pre-image retrieve: a partial container.
            const [object, field] = member.split('.') as [string, string];
            const parent = org.find((c) => c.type === 'CustomObject' && c.fullName === object);
            const block =
              parent && parent.returned !== false
                ? blockOf(parent.files[`objects/${object}.object`] ?? '', field)
                : null;
            if (block) partial.set(object, [...(partial.get(object) ?? []), block]);
            continue;
          }
          for (const c of org) {
            if (c.type !== name || c.returned === false) continue;
            const hit = member === '*' || c.fullName.toLowerCase() === member.toLowerCase();
            if (hit && !picked.includes(c)) picked.push(c);
          }
        }
      }
      const id = `09S${String(retrieves.size).padStart(4, '0')}`;
      // What the org held when the retrieve was asked for.
      const held = picked.map((c) => ({ ...c, files: { ...c.files } }));
      for (const [object, blocks] of partial) {
        held.push({
          type: 'CustomField',
          fullName: `${object}.(partial)`,
          files: { [`objects/${object}.object`]: partialObject(blocks) },
          // A partial container carries no fileProperties row of its own.
          listed: false,
        });
      }
      retrieves.set(id, held);
      return new Response(
        soapEnvelope(
          `<retrieveResponse ${MD}><result><id>${id}</id><done>false</done><state>Queued</state></result></retrieveResponse>`,
        ),
      );
    }
    if (body.includes('<met:checkRetrieveStatus>')) {
      calls.status += 1;
      events.push('retrieve:status');
      if (gatePromise) await gatePromise;
      const id = /<met:asyncProcessId>([^<]+)<\/met:asyncProcessId>/.exec(body)![1]!;
      beforeFinalStatus?.();
      const comps = retrieves.get(id) ?? [];
      const entries: Record<string, Uint8Array> = {
        'unpackaged/package.xml': strToU8('<Package>org</Package>'),
      };
      for (const c of comps) {
        for (const [rel, text] of Object.entries(c.files)) entries[`unpackaged/${rel}`] = strToU8(text);
      }
      const zip = Buffer.from(zipSync(entries)).toString('base64');
      const props = comps
        .filter((c) => c.type !== 'CustomField')
        .map((c) =>
          propXml(
            'fileProperties',
            c,
            c.retrieveStamp ?? (c.listStamp === undefined || c.listStamp === null ? ORG_STAMP : c.listStamp),
          ),
        )
        .join('');
      return new Response(
        soapEnvelope(
          `<checkRetrieveStatusResponse ${MD}><result><done>true</done><status>Succeeded</status>` +
            `<success>true</success><id>${id}</id><zipFile>${zip}</zipFile>${props}</result>` +
            '</checkRetrieveStatusResponse>',
        ),
      );
    }
    return new Response('unexpected SOAP body', { status: 500 });
  });
}

function cls(name: string, body: string): OrgComp {
  return {
    type: 'ApexClass',
    fullName: name,
    files: { [`classes/${name}.cls`]: body, [`classes/${name}.cls-meta.xml`]: CLS_META },
  };
}

function baseOrg(): OrgComp[] {
  return [
    cls('InvoiceService', SERVICE_V1),
    cls('InvoiceSelector', SELECTOR),
    {
      type: 'CustomObject',
      fullName: 'Invoice__c',
      files: { 'objects/Invoice__c.object': objectXml(INVOICE_FIELDS) },
    },
    { type: 'Flow', fullName: 'Send_Invoice', files: { 'flows/Send_Invoice.flow': SEND_INVOICE_FLOW_XML } },
    {
      type: 'Layout',
      fullName: 'Invoice__c-Main',
      files: { 'layouts/Invoice__c-Main.layout': LAYOUT_V1 },
    },
  ];
}

function insertConnection(alias: string): string {
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias,
    instanceUrl: 'https://acme-dev.example.invalid',
    loginUrl: 'https://login.example.invalid',
    orgId: '00D000000000000',
    orgName: 'Acme Dev',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT-stub');
  return conn.id;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-rebaseline-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  connId = insertConnection('acme-dev');
  org = baseOrg();
  fieldStamps = {};
  orgDeps = [];
  calls = { list: [], retrieve: [], status: 0, soap: 0, stamp: 0 };
  fetched = [];
  events = [];
  realDeploys = 0;
  realMode = 'ok';
  onRealDeploy = null;
  beforeFinalStatus = null;
  gatePromise = null;
  gateRelease = () => {};
  retrieves.clear();
  stubOrg();

  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    // The re-baseline stays ON (the default) — this harness models the re-read.
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5, toolWaitMs: 10_000 },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5, toolWaitMs: 10_000 },
  };
  deps = createDeps({
    db,
    tokens,
    config,
    store,
    approvals: new ApprovalPageServer(async () => {}),
    notifier: new QuietNotifier(),
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
  client = new Client({ name: 'rebaseline-test', version: '0.0.0' });
  await client.connect(ct);
});

afterEach(async () => {
  gateRelease();
  gatePromise = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  delete process.env.CONTRAIL_LOG_LEVEL;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────

function conn(): ConnectionRecord {
  return db.getConnection(connId)!;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** The JSON body of a result whose text is `{json}` or `prefix\n{json}`. */
function bodyOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const text = textOf(result);
  return JSON.parse(text.startsWith('{') ? text : text.slice(text.indexOf('\n{') + 1));
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Wait (on real timers) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await settle(10);
  }
  throw new Error('condition never held');
}

/** The baseline: a whole-type refresh, then the call and event logs are cleared. */
async function wholeRefresh(): Promise<void> {
  const out = await deps.engine.refresh(conn(), TYPES);
  expect(out.status).toBe('complete');
  calls = { list: [], retrieve: [], status: 0, soap: 0, stamp: 0 };
  events = [];
}

/** A real validate through the tool; the code is read from the row (the human reads it from the page). */
async function validate(
  args: Record<string, unknown>,
): Promise<{ id: string; code: string; body: Record<string, any> }> {
  const res = await client.callTool({
    name: 'validate_deploy',
    arguments: { connection: 'acme-dev', ...args },
  });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  const body = bodyOf(res);
  const row = db.getDeployRequest(body.request_id as string)!;
  return { id: row.id, code: row.confirmationCode, body };
}

async function execute(code: string) {
  return client.callTool({
    name: 'execute_deploy',
    arguments: { connection: 'acme-dev', confirmation_code: code },
  });
}

async function executeOk(code: string): Promise<Record<string, any>> {
  const res = await execute(code);
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return bodyOf(res);
}

const service = (body: string) => ({ type: 'ApexClass', api_name: 'InvoiceService', content: body });
const due = (label: string) => ({
  type: 'CustomField',
  api_name: 'Invoice__c.Due__c',
  content: fieldBlock('Due__c', label),
});
const mem = (type: string, api_name: string) => ({ type, api_name });

/** A stamp a few seconds before now — what an org writes on the components a deploy changed. */
function justNow(): string {
  return new Date(Date.now() - 5_000).toISOString();
}

function setOrg(type: string, fullName: string, change: Partial<OrgComp> | null): void {
  const i = org.findIndex((c) => c.type === type && c.fullName === fullName);
  if (change === null) {
    if (i >= 0) org.splice(i, 1);
    return;
  }
  if (i < 0) org.push({ type, fullName, files: {}, ...change });
  else org[i] = { ...org[i]!, ...change };
}

/** The org after a deploy of InvoiceService: the new body, stamped now. */
function deployedService(body: string, over: Partial<OrgComp> = {}): void {
  setOrg('ApexClass', 'InvoiceService', {
    files: { 'classes/InvoiceService.cls': body, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    listStamp: justNow(),
    ...over,
  });
}

/** The org after a deploy that changed Invoice__c's fields. */
function deployedFields(fields: Array<[string, string]>, changed: string[]): void {
  const at = justNow();
  setOrg('CustomObject', 'Invoice__c', {
    files: { 'objects/Invoice__c.object': objectXml(fields) },
    listStamp: at,
  });
  for (const f of changed) fieldStamps[`Invoice__c.${f}`] = at;
}

function current(): string {
  return path.join(tmp, 'snapshots', connId, 'current');
}

function readSnap(rel: string): string | null {
  return store.readCurrentFile(connId, rel);
}

/** Every file under a directory as rel path → content, sorted. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else out[path.relative(dir, child).replaceAll(path.sep, '/')] = fs.readFileSync(child, 'utf8');
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Every index row, id included, as one comparable line each. */
function rows(): string[] {
  return db
    .listArtifacts(connId)
    .map(
      (r) =>
        `${r.id}|${r.type}|${r.apiName}|${r.filePath}|${r.contentHash}|${r.lastModifiedDate}|${r.retrievedAt}`,
    );
}

function row(type: string, apiName: string) {
  return db.getArtifact(connId, type, apiName);
}

function audits(eventType: string) {
  return db.queryAuditEvents({ limit: 500 }).filter((e) => e.eventType === eventType);
}

function storedResult(id: string): Record<string, any> {
  return JSON.parse(db.getDeployRequest(id)!.resultJson ?? '{}');
}

/** Every warning on every change row of a validate result, joined. */
function warningsOf(body: Record<string, any>): string {
  return (body.changes as Array<{ warnings: string[] }>).flatMap((c) => c.warnings).join('\n');
}

const NOISE = /CHANGED IN TARGET|EXISTS IN TARGET|NOT IN TARGET|live bytes differ/;

function childListings(): string[] {
  return calls.list.filter((b) => CHILD_TYPES.some((t) => b.includes(`<met:type>${t}</met:type>`)));
}

/** The re-baseline's own unit-level retrieves: those naming a child type are Part D's pre-images, never the hook's. */
function wholeDocumentRetrieves(): string[] {
  return calls.retrieve.filter((b) => !CHILD_TYPES.some((t) => b.includes(`<met:name>${t}</met:name>`)));
}

/** Poll execute_deploy with a short soft wait until the deploy job reports the re-read. */
async function executeUntilRebaselining(code: string) {
  const wait = config.deploy.toolWaitMs;
  config.deploy.toolWaitMs = 40;
  try {
    for (let i = 0; i < 200; i++) {
      const res = await execute(code);
      expect(res.isError ?? false, textOf(res)).toBe(false);
      if (textOf(res).startsWith(REBASELINE_MESSAGE)) return res;
      expect(textOf(res)).toMatch(/^Deploy is still running/);
    }
    throw new Error('the deploy never reached its re-read');
  } finally {
    config.deploy.toolWaitMs = wait;
  }
}

// ── the re-baseline ──────────────────────────────────────────────────────

describe('S46 C3: the re-baseline after a successful execute_deploy', () => {
  it('complete: the deployed class re-read, the stored result equals the returned one, and a re-sent code replays it', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const retrievesBefore = calls.retrieve.length;
    events = [];
    const result = await executeOk(code);

    expect(result.deployed).toBe(true);
    expect(result.note).toBe(
      'Deployed. Contrail re-read the 1 component(s) in this deploy from the org into the local ' +
        'snapshot — no refresh_snapshot is needed for them.',
    );
    expect(result.snapshot).toEqual({
      status: 'complete',
      rebaselined: [mem('ApexClass', 'InvoiceService')],
      removed: [],
      skipped: [],
      retrieved_at: expect.stringMatching(ISO_RE),
      note: REREAD_NOTE,
    });
    // The snapshot holds the deployed bytes, stamped from the org's listing.
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
    const service2 = row('ApexClass', 'InvoiceService')!;
    expect(service2.retrievedAt).toBe(result.snapshot.retrieved_at);
    expect(service2.lastModifiedDate).toBe(org.find((c) => c.fullName === 'InvoiceService')!.listStamp);

    // The stored row is the returned result; a re-sent code replays it.
    expect(db.getDeployRequest(id)!.status).toBe('executed');
    expect(storedResult(id)).toEqual(result);
    const replay = await executeOk(code);
    expect(replay).toEqual({ ...result, already_completed: true });

    // After the deploy: one unit-level listing and one retrieve, neither naming a child type
    // (the listing before the deploy is the target guard's).
    expect(calls.retrieve.length).toBe(retrievesBefore + 1);
    expect(calls.retrieve.at(-1)).toContain('<met:name>ApexClass</met:name>');
    expect(events.slice(events.indexOf('deploy:real'))).toEqual([
      'deploy:real',
      'list:ApexClass',
      'retrieve',
      'retrieve:status',
    ]);
    expect(childListings()).toEqual([]);
    const [refreshed] = audits('snapshot.members_refreshed');
    expect(refreshed!.tool).toBe('execute_deploy');
    expect(refreshed!.detail).toEqual({
      origin: 'execute_deploy',
      requestId: id,
      refreshed: 1,
      removed: 0,
      skipped: 0,
      units: ['ApexClass:InvoiceService'],
      duration_ms: expect.any(Number),
    });
    expect(audits('deploy.snapshot_rebaseline_unavailable')).toEqual([]);
  });

  it('the confirmation code appears in no result, stored row, audit detail or log line', async () => {
    process.env.CONTRAIL_LOG_LEVEL = 'debug';
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const res = await execute(code);
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(bodyOf(res).snapshot.status).toBe('complete');
    expect(textOf(res)).not.toContain(code);
    expect(db.getDeployRequest(id)!.resultJson ?? '').not.toContain(code);
    expect(JSON.stringify(db.queryAuditEvents({ limit: 1000 }))).not.toContain(code);
    expect(logged.join('')).toContain('snapshot members refreshed');
    expect(logged.join('')).not.toContain(code);
  });

  it('ordering: the execution observer reads the pre-deploy snapshot and a pending row; the file holds the new bytes once the call resolves', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    let observed: { file: string | null; returned: unknown; stored: unknown } | null = null;
    deps.deploys.setExecutionObserver(({ payload }) => {
      observed = {
        file: readSnap('classes/InvoiceService.cls'),
        returned: (payload.snapshot as { status: string }).status,
        stored: storedResult(id).snapshot.status,
      };
    });
    const result = await executeOk(code);
    expect(observed).toEqual({ file: SERVICE_V1, returned: 'pending', stored: 'pending' });
    expect(result.snapshot.status).toBe('complete');
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
  });

  it('the promise: the next validate of the same class and the same field shows no CHANGED IN TARGET, EXISTS IN TARGET or live-bytes line', async () => {
    await wholeRefresh();
    const first = await validate({ components: [service(SERVICE_V2), due('Due Date')] });
    expect(warningsOf(first.body)).not.toMatch(NOISE);
    onRealDeploy = () => {
      deployedService(SERVICE_V2);
      deployedFields(
        [
          ['Amount__c', 'Amount'],
          ['Due__c', 'Due Date'],
          ['Status__c', 'Status'],
        ],
        ['Due__c'],
      );
    };
    const result = await executeOk(first.code);
    expect(result.snapshot).toMatchObject({
      status: 'complete',
      rebaselined: [mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Due__c')],
    });
    // The field's re-read wrote the WHOLE object document: every sibling is still there.
    expect(readSnap('objects/Invoice__c.object')).toBe(
      org.find((c) => c.fullName === 'Invoice__c')!.files['objects/Invoice__c.object'],
    );
    expect(row('CustomField', 'Invoice__c.Amount__c')).not.toBeNull();
    expect(row('CustomField', 'Invoice__c.Status__c')).not.toBeNull();
    const hookRetrieve = wholeDocumentRetrieves().at(-1)!;
    expect(hookRetrieve).toContain('<met:name>CustomObject</met:name>');
    expect(hookRetrieve).not.toContain('<met:name>CustomField</met:name>');
    expect(childListings()).toEqual([]);

    // A further edit of both: the live side is Part D's child-typed retrieve
    // and stamp query for the field, the snapshot side what the hook wrote.
    const second = await validate({ components: [service(SERVICE_V3), due('Due On')] });
    expect(second.body.changes.map((c: { change: string }) => c.change)).toEqual(['modify', 'modify']);
    expect(warningsOf(second.body)).not.toMatch(NOISE);
    expect(second.body.changes[1].pre_image).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
    });
    expect(calls.retrieve.at(-1)).toContain('<met:members>Invoice__c.Due__c</met:members><met:name>CustomField</met:name>');
  });

  it('the promise holds when the org lists a class with one stamp and its retrieve carries another: the row keeps the listing stamp', async () => {
    await wholeRefresh();
    const first = await validate({ components: [service(SERVICE_V2)] });
    let listed = '';
    onRealDeploy = () => {
      listed = justNow();
      deployedService(SERVICE_V2, {
        listStamp: listed,
        retrieveStamp: new Date(Date.parse(listed) + 2_000).toISOString(),
      });
    };
    expect((await executeOk(first.code)).snapshot.status).toBe('complete');
    expect(row('ApexClass', 'InvoiceService')!.lastModifiedDate).toBe(listed);
    const second = await validate({ components: [service(SERVICE_V3)] });
    expect(second.body.changes[0].change).toBe('modify');
    expect(warningsOf(second.body)).not.toMatch(NOISE);
  });

  it("removal only for the deploy's own deletions: a destructive class and a destructive field come back removed", async () => {
    await wholeRefresh();
    const { id, code } = await validate({
      components: [service(SERVICE_V2)],
      destructive: [mem('ApexClass', 'InvoiceSelector'), mem('CustomField', 'Invoice__c.Status__c')],
    });
    onRealDeploy = () => {
      deployedService(SERVICE_V2);
      setOrg('ApexClass', 'InvoiceSelector', null);
      deployedFields(
        [
          ['Amount__c', 'Amount'],
          ['Due__c', 'Due'],
        ],
        [],
      );
    };
    const result = await executeOk(code);
    expect(result.snapshot).toEqual({
      status: 'complete',
      rebaselined: [mem('ApexClass', 'InvoiceService')],
      removed: [mem('ApexClass', 'InvoiceSelector'), mem('CustomField', 'Invoice__c.Status__c')],
      skipped: [],
      retrieved_at: expect.stringMatching(ISO_RE),
      note: REREAD_NOTE,
    });
    expect(result.note).toContain('re-read the 3 component(s)');
    expect(readSnap('classes/InvoiceSelector.cls')).toBeNull();
    expect(row('ApexClass', 'InvoiceSelector')).toBeNull();
    expect(row('CustomField', 'Invoice__c.Status__c')).toBeNull();
    expect(readSnap('objects/Invoice__c.object')).not.toContain('Status__c');
    expect(row('CustomField', 'Invoice__c.Due__c')).not.toBeNull();
    expect(audits('snapshot.members_refreshed')[0]!.detail).toMatchObject({
      requestId: id,
      refreshed: 1,
      removed: 2,
      skipped: 0,
    });
  });

  it('a changed child missing from the re-read parent is child_not_in_parent and a Layout the org neither lists nor returns is not_confirmed: partial, the layout kept intact', async () => {
    // The layout has no extractor edges, so the whole refresh gives it an org-computed one to keep.
    orgDeps = [
      {
        MetadataComponentName: 'Invoice__c-Main',
        MetadataComponentType: 'Layout',
        RefMetadataComponentName: 'Invoice__c',
        RefMetadataComponentType: 'CustomObject',
      },
    ];
    await wholeRefresh();
    const layoutRows = db
      .listArtifactsByFilePath(connId, 'layouts/Invoice__c-Main.layout')
      .map((r) => `${r.id}|${r.contentHash}|${r.lastModifiedDate}|${r.retrievedAt}`);
    expect(layoutRows).toHaveLength(1);
    const layoutEdges = db.edgesFrom(connId, 'Layout', 'Invoice__c-Main');
    expect(layoutEdges).toEqual([
      {
        connectionId: connId,
        fromType: 'Layout',
        fromName: 'Invoice__c-Main',
        toType: 'CustomObject',
        toName: 'Invoice__c',
        source: 'org',
      },
    ]);
    const { code } = await validate({
      components: [
        service(SERVICE_V2),
        due('Due Date'),
        { type: 'Layout', api_name: 'Invoice__c-Main', content: LAYOUT_V2 },
      ],
    });
    onRealDeploy = () => {
      deployedService(SERVICE_V2);
      // The re-read object document does not hold the field the deploy changed.
      deployedFields(
        [
          ['Amount__c', 'Amount'],
          ['Status__c', 'Status'],
        ],
        [],
      );
      setOrg('Layout', 'Invoice__c-Main', { listed: false, returned: false });
    };
    const result = await executeOk(code);
    expect(result.note).toBe(
      'Deployed. Contrail re-read 1 of 3 component(s) in this deploy into the local snapshot; 2 ' +
        'were not re-baselined — snapshot.skipped gives the reason for each. Run refresh_snapshot ' +
        'for those you need current.',
    );
    expect(result.snapshot).toEqual({
      status: 'partial',
      rebaselined: [mem('ApexClass', 'InvoiceService')],
      removed: [],
      skipped: [
        {
          ...mem('CustomField', 'Invoice__c.Due__c'),
          code: 'child_not_in_parent',
          reason: memberSkipText('child_not_in_parent', { type: 'CustomField', unitType: 'CustomObject' }),
        },
        {
          ...mem('Layout', 'Invoice__c-Main'),
          code: 'not_confirmed',
          reason:
            "This deploy changed it, but the org's listing did not name it and the retrieve " +
            'returned no file for it under this name — the snapshot copy was left as it was.',
        },
      ],
      retrieved_at: expect.stringMatching(ISO_RE),
      note: REREAD_NOTE,
    });
    // Never removed on a re-read: the layout's file, rows and edges are as they were.
    expect(readSnap('layouts/Invoice__c-Main.layout')).toBe(LAYOUT_V1);
    expect(
      db
        .listArtifactsByFilePath(connId, 'layouts/Invoice__c-Main.layout')
        .map((r) => `${r.id}|${r.contentHash}|${r.lastModifiedDate}|${r.retrievedAt}`),
    ).toEqual(layoutRows);
    expect(db.edgesFrom(connId, 'Layout', 'Invoice__c-Main')).toEqual(layoutEdges);
    // The child is gone from the snapshot with its parent replaced whole.
    expect(row('CustomField', 'Invoice__c.Due__c')).toBeNull();
  });

  it('a deploy of one child the re-read parent lacks is none, yet says the parent was written and its edges rebuilt', async () => {
    await wholeRefresh();
    const { code } = await validate({ components: [due('Due Date')] });
    const reread = objectXml([
      ['Amount__c', 'Amount'],
      ['Status__c', 'Status'],
    ]);
    // The re-read object document does not hold the field the deploy changed.
    onRealDeploy = () =>
      deployedFields(
        [
          ['Amount__c', 'Amount'],
          ['Status__c', 'Status'],
        ],
        [],
      );
    const result = await executeOk(code);
    expect(result.note).toBe(
      'Deployed. None of the components in this deploy was re-baselined — snapshot.skipped gives ' +
        'the reason for each. Contrail did write to the local snapshot one or more documents it ' +
        're-read for them (a parent document or a folder). Run refresh_snapshot for those you need ' +
        'current.',
    );
    expect(result.snapshot).toEqual({
      status: 'none',
      rebaselined: [],
      removed: [],
      skipped: [
        {
          ...mem('CustomField', 'Invoice__c.Due__c'),
          code: 'child_not_in_parent',
          reason: memberSkipText('child_not_in_parent', { type: 'CustomField', unitType: 'CustomObject' }),
        },
      ],
      retrieved_at: expect.stringMatching(ISO_RE),
      note: REREAD_NOTE,
    });
    // What the note says happened did happen: the parent written whole, the child's copy gone.
    expect(readSnap('objects/Invoice__c.object')).toBe(reread);
    expect(row('CustomField', 'Invoice__c.Due__c')).toBeNull();
    expect(row('CustomField', 'Invoice__c.Status__c')).not.toBeNull();
  });

  it('deactivate_flow: the FlowDefinition member re-reads its Flow', async () => {
    await wholeRefresh();
    const res = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'acme-dev', flow: 'Send_Invoice' },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const code = db.getDeployRequest(bodyOf(res).request_id)!.confirmationCode;
    const deactivated = SEND_INVOICE_FLOW_XML.replace(
      '    <label>Send Invoice</label>\n',
      '    <label>Send Invoice</label>\n    <status>Obsolete</status>\n',
    );
    onRealDeploy = () =>
      setOrg('Flow', 'Send_Invoice', {
        files: { 'flows/Send_Invoice.flow': deactivated },
        listStamp: justNow(),
      });
    const result = await executeOk(code);
    expect(result.snapshot).toMatchObject({
      status: 'complete',
      rebaselined: [mem('FlowDefinition', 'Send_Invoice')],
      skipped: [],
    });
    expect(readSnap('flows/Send_Invoice.flow')).toBe(deactivated);
    expect(wholeDocumentRetrieves().at(-1)).toContain('<met:name>Flow</met:name>');
  });
});

describe('S46 C3: when the re-baseline does not run or does not finish, the deploy still stands and the result says so', () => {
  it('timeout: nothing written even when the org answers later; the row is executed and the miss audited', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const before = rows();
    const filesBefore = tree(current());
    const lease = vi.spyOn(db, 'releaseAppLock');
    config.snapshot.rebaselineTimeoutMs = 150;
    armGate();
    const result = await executeOk(code);
    expect(result.deployed).toBe(true);
    expect(result.note).toBe(NOT_UPDATED('the re-read did not finish within 0.15 s'));
    expect(result.snapshot).toEqual({
      status: 'unavailable',
      reason: 'timeout',
      rebaselined: [],
      removed: [],
      skipped: [],
      note: NOT_UPDATED('the re-read did not finish within 0.15 s').replace(/^Deployed\. /, ''),
    });
    expect(db.getDeployRequest(id)!.status).toBe('executed');
    expect(storedResult(id)).toEqual(result);
    expect(audits('deploy.snapshot_rebaseline_unavailable').map((e) => [e.tool, e.outcome, e.detail])).toEqual([
      ['execute_deploy', 'error', { requestId: id, reason: 'timeout' }],
    ]);
    // The org answers; the aborted run stops at its last checkpoint and lets the lease go.
    releaseGate();
    await until(() => lease.mock.calls.length >= 1);
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it("locked: another process holds the connection's snapshot lease", async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const raw = new Database(path.join(tmp, 'test.db'));
    try {
      raw.exec(
        `CREATE TABLE app_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL,
           pid INTEGER, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
      );
      raw
        .prepare(`INSERT INTO app_locks (name, holder, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(`snapshot:${connId}`, 'desktop:4242', 4242, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
    } finally {
      raw.close();
    }
    const retrievesBefore = calls.retrieve.length;
    const result = await executeOk(code);
    expect(result.note).toBe(NOT_UPDATED("another Contrail process is refreshing this connection's snapshot"));
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'locked' });
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V1);
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({ requestId: id, reason: 'locked' });
  });

  it('refresh_running (fake timers): a whole refresh ahead holds the re-read only 10 s of a 60 s budget, and the aborted run writes nothing when its turn comes', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    expect(config.snapshot.rebaselineTimeoutMs).toBe(60_000);
    config.snapshot.toolWaitMs = 20;
    // The deploy call itself waits for the whole hook.
    config.deploy.toolWaitMs = 120_000;
    armGate();
    const whole = await deps.engine.refresh(conn(), ['ApexClass']);
    expect(whole.status).toBe('in_progress');
    // The whole refresh is held at the org's answer, so the re-read can only queue behind it.
    await until(() => calls.status >= 1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let out: Awaited<ReturnType<DeployEngine['executeDeploy']>> | undefined;
    const pending = deps.deploys.executeDeploy(conn(), code).then((o) => {
      out = o;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    // The deploy has committed; only its re-read is waiting for its turn.
    expect(realDeploys).toBe(1);
    expect(db.getDeployRequest(id)!.status).toBe('executed');
    expect(out).toBeUndefined();
    // REBASELINE_QUEUE_WAIT_MS, not the 60 s budget, ends the wait.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(out?.status).toBe('complete');
    await pending;
    vi.useRealTimers();
    const result = (out as { status: 'complete'; result: Record<string, any> }).result;
    expect(result.note).toBe(NOT_UPDATED('a snapshot refresh was already running on this connection'));
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'refresh_running' });
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({
      requestId: id,
      reason: 'refresh_running',
    });

    const lists = calls.list.length;
    const retrieves = calls.retrieve.length;
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const done = await deps.engine.refresh(conn(), ['ApexClass']);
    expect(done.status).toBe('complete');
    await settle();
    // The aborted run returned before taking the lease: no member listing or retrieve, no member audit.
    expect(calls.list.length).toBe(lists);
    expect(calls.retrieve.length).toBe(retrieves);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('a rejecting re-baseliner is failed_after_write — never "not updated"', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    deps.deploys.setSnapshotRebaseliner(async () => {
      throw new Error('the snapshot worker exited (code 1)');
    });
    const result = await executeOk(code);
    expect(result.deployed).toBe(true);
    expect(result.note).toBe(PARTLY('the snapshot worker exited (code 1)'));
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'failed_after_write' });
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({
      requestId: id,
      reason: 'failed_after_write',
      detail: 'the snapshot worker exited (code 1)',
    });
  });

  it('a failure after the commit point (replaceArtifactRows) is failed_after_write, the note pinned verbatim', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    vi.spyOn(db, 'replaceArtifactRows').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const result = await executeOk(code);
    const detail = partialWriteText('SQLITE_BUSY: database is locked').slice(0, 200);
    expect(result.note).toBe(
      'Deployed. The local snapshot may be only PARTLY updated for this deploy (the re-read stopped ' +
        'while writing: the snapshot may be only partly updated for these components (SQLITE_BUSY: ' +
        'database is locked) — its files and its index can disagree until they are re-read) — its ' +
        'files and its index can disagree for these components. Run refresh_snapshot with members ' +
        "set to this deploy's components to repair it.",
    );
    expect(result.snapshot).toEqual({
      status: 'unavailable',
      reason: 'failed_after_write',
      rebaselined: [],
      removed: [],
      skipped: [],
      note: result.note.replace(/^Deployed\. /, ''),
    });
    expect(storedResult(id)).toEqual(result);
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({
      requestId: id,
      reason: 'failed_after_write',
      detail,
    });
  });

  it('metadata_read revoked before the hook starts: no_metadata_read, zero SOAP calls', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    let soapAtObserver = -1;
    deps.deploys.setExecutionObserver(() => {
      db.updateGrants(connId, emptyGrantSet());
      soapAtObserver = calls.soap;
    });
    const result = await executeOk(code);
    expect(soapAtObserver).toBeGreaterThan(0);
    expect(calls.soap).toBe(soapAtObserver);
    expect(result.note).toBe(
      'Deployed. The local snapshot was NOT updated: this connection no longer grants ' +
        'metadata_read, so Contrail did not copy org metadata into the snapshot.',
    );
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'no_metadata_read' });
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({
      requestId: id,
      reason: 'no_metadata_read',
    });
  });

  it('the connection removed before the hook starts: connection_removed, zero SOAP calls, no snapshot recreated', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    let soapAtObserver = -1;
    deps.deploys.setExecutionObserver(() => {
      db.deleteConnection(connId);
      store.removeConnection(connId);
      soapAtObserver = calls.soap;
    });
    const result = await executeOk(code);
    expect(calls.soap).toBe(soapAtObserver);
    expect(result.note).toBe(
      'Deployed. The local snapshot was NOT updated: this connection was removed before Contrail ' +
        'finished re-reading the deployed components.',
    );
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'connection_removed' });
    expect(fs.existsSync(path.join(tmp, 'snapshots', connId))).toBe(false);
    // The request row outlives the connection, and carries the outcome.
    expect(storedResult(id)).toEqual(result);
    // The miss is audited too, under the removed connection's id.
    expect(
      audits('deploy.snapshot_rebaseline_unavailable').map((e) => [e.connectionId, e.tool, e.outcome, e.detail]),
    ).toEqual([[connId, 'execute_deploy', 'error', { requestId: id, reason: 'connection_removed' }]]);
  });

  it('metadata_read revoked, and the connection deleted, between the re-read\'s last poll and its commit: nothing written', async () => {
    await wholeRefresh();
    const first = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const before = rows();
    const filesBefore = tree(current());
    beforeFinalStatus = () => db.updateGrants(connId, emptyGrantSet());
    const revoked = await executeOk(first.code);
    expect(wholeDocumentRetrieves()).toHaveLength(2); // the validate's pre-image, then the re-read
    expect(revoked.snapshot).toMatchObject({ status: 'unavailable', reason: 'no_metadata_read' });
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    expect(audits('deploy.snapshot_rebaseline_unavailable').map((e) => [e.tool, e.outcome, e.detail])).toEqual([
      ['execute_deploy', 'error', { requestId: first.id, reason: 'no_metadata_read' }],
    ]);

    beforeFinalStatus = null;
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    grants.metadata_write = true;
    db.updateGrants(connId, grants);
    const second = await validate({ components: [service(SERVICE_V3)] });
    onRealDeploy = () => deployedService(SERVICE_V3);
    beforeFinalStatus = () => {
      db.deleteConnection(connId);
      store.removeConnection(connId);
    };
    const removed = await executeOk(second.code);
    expect(removed.snapshot).toMatchObject({ status: 'unavailable', reason: 'connection_removed' });
    expect(db.listArtifacts(connId)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'snapshots', connId))).toBe(false);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    const misses = audits('deploy.snapshot_rebaseline_unavailable');
    expect(misses).toHaveLength(2);
    expect(
      misses.filter((e) => e.detail?.requestId === second.id).map((e) => [e.tool, e.outcome, e.detail]),
    ).toEqual([['execute_deploy', 'error', { requestId: second.id, reason: 'connection_removed' }]]);
  });

  it('no snapshot on the connection: nothing to re-baseline, nothing listed or retrieved', async () => {
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    const retrievesBefore = calls.retrieve.length;
    const result = await executeOk(code);
    expect(result.note).toBe(
      'Deployed. This connection has no local snapshot, so there was nothing to re-baseline. Run ' +
        'refresh_snapshot when you need one.',
    );
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'no_snapshot' });
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({ requestId: id, reason: 'no_snapshot' });
  });

  it('too_many_members: a deploy of 101 components is not re-read, and the note names the types to refresh', async () => {
    const components = Array.from({ length: 101 }, (_, i) => ({
      type: 'ApexClass',
      api_name: `Cls${i}`,
      content: `public class Cls${i} {}`,
    }));
    // The tool takes at most 50 components; a host calling the engine has no such cap.
    const validated = await deps.deploys.validateDeploy(conn(), { components, destructive: [], runTests: [] });
    expect(validated.status).toBe('complete');
    const request = db.queryDeployRequests({ connectionId: connId, limit: 1 })[0]!;
    const retrievesBefore = calls.retrieve.length;
    const result = await executeOk(request.confirmationCode);
    expect(result.note).toBe(
      'Deployed. The local snapshot was NOT updated: this deploy has 101 components, more than the ' +
        '100 a member-scoped re-read takes. Run refresh_snapshot with types: ["ApexClass"] to bring ' +
        'it up to date.',
    );
    expect(result.snapshot).toMatchObject({ status: 'unavailable', reason: 'too_many_members' });
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(audits('deploy.snapshot_rebaseline_unavailable')[0]!.detail).toEqual({
      requestId: request.id,
      reason: 'too_many_members',
      detail: 'ApexClass',
    });
  });

  it('turned off (snapshot.rebaselineAfterDeploy: false): disabled, no re-read — and the next validate then shows the noise the hook removes', async () => {
    await wholeRefresh();
    config.snapshot.rebaselineAfterDeploy = false;
    const { code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    const retrievesBefore = calls.retrieve.length;
    const result = await executeOk(code);
    expect(result.note).toBe(
      'Deployed. Automatic snapshot re-baseline is turned off (snapshot.rebaselineAfterDeploy) — ' +
        'run refresh_snapshot to bring the local snapshot up to date.',
    );
    expect(result.snapshot).toEqual({
      status: 'disabled',
      rebaselined: [],
      removed: [],
      skipped: [],
      note:
        'Automatic snapshot re-baseline is turned off (snapshot.rebaselineAfterDeploy) — run ' +
        'refresh_snapshot to bring the local snapshot up to date.',
    });
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(audits('deploy.snapshot_rebaseline_unavailable')).toEqual([]);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    const next = await validate({ components: [service(SERVICE_V3)] });
    expect(warningsOf(next.body)).toMatch(/CHANGED IN TARGET/);
  });

  it('a bare DeployEngine (no re-baseliner set) keeps the legacy note and no snapshot key', async () => {
    await wholeRefresh();
    const bare = new DeployEngine(
      db,
      store,
      new AccessTokenManager(db, tokens, config),
      config,
      new AuditLog(db),
      new ApprovalPageServer(async () => {}),
    );
    const validated = await bare.validateDeploy(conn(), {
      components: [service(SERVICE_V2)],
      destructive: [],
      runTests: [],
    });
    expect(validated.status).toBe('complete');
    const request = db.queryDeployRequests({ connectionId: connId, limit: 1 })[0]!;
    onRealDeploy = () => deployedService(SERVICE_V2);
    const retrievesBefore = calls.retrieve.length;
    const outcome = await bare.executeDeploy(conn(), request.confirmationCode);
    expect(outcome.status).toBe('complete');
    const result = (outcome as { result: Record<string, unknown> }).result;
    expect(result.note).toBe('Deployed. Run refresh_snapshot to bring the local snapshot up to date.');
    expect('snapshot' in result).toBe(false);
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V1);
  });

  it('a failed deploy and an outcome-unknown deploy never call the hook', async () => {
    await wholeRefresh();
    let hookCalls = 0;
    deps.deploys.setSnapshotRebaseliner(async (i) => {
      hookCalls += 1;
      return deps.engine.rebaselineMembers(i.conn, i.members, {
        timeoutMs: i.timeoutMs,
        requestId: i.requestId,
        deleted: i.deleted,
      });
    });
    const failing = await validate({ components: [service(SERVICE_V2)] });
    realMode = 'fail';
    const failed = await executeOk(failing.code);
    expect(failed.deployed).toBe(false);
    expect(failed.note).toBe('Deploy failed and rolled back (rollbackOnError).');
    expect('snapshot' in failed).toBe(false);

    config.deploy.deployTimeoutMs = 40;
    realMode = 'never';
    const unknown = await validate({ components: [service(SERVICE_V3)] });
    const lost = await executeOk(unknown.code);
    expect(lost.deployed).toBe(false);
    expect(lost.error_message).toContain('did not complete');
    expect('snapshot' in lost).toBe(false);
    expect(hookCalls).toBe(0);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    expect(audits('deploy.snapshot_rebaseline_unavailable')).toEqual([]);
  });

  it('a slow re-read: the call returns in progress with REBASELINE_PROGRESS and its own message, the row says pending, and a poll re-attaches to the final block', async () => {
    await wholeRefresh();
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });
    onRealDeploy = () => deployedService(SERVICE_V2);
    armGate();
    const first = await executeUntilRebaselining(code);
    expect(textOf(first)).toBe(`${REBASELINE_MESSAGE}\n${JSON.stringify(bodyOf(first), null, 2)}`);
    expect(bodyOf(first).progress).toBe(REBASELINE_PROGRESS);
    // The deploy is stored, honestly: the re-read had not finished.
    expect(db.getDeployRequest(id)!.status).toBe('executed');
    expect(storedResult(id).note).toBe(PENDING_NOTE);
    expect(storedResult(id).snapshot).toEqual({
      status: 'pending',
      rebaselined: [],
      removed: [],
      skipped: [],
      note: PENDING_NOTE.replace(/^Deployed\. /, ''),
    });
    // A poll while the re-read runs re-attaches to the job (never a replay of the pending row).
    setTimeout(releaseGate, 50);
    const final = await executeOk(code);
    expect(final.already_completed).toBeUndefined();
    expect(final.snapshot.status).toBe('complete');
    expect(storedResult(id)).toEqual(final);
    expect(realDeploys).toBe(1);
    expect(audits('deploy.refused')).toEqual([]);
  });
});

// ── the composed execute order (integration §2.4) ────────────────────────

describe('S46: the composed execute order — policy check, target guard, claim, deploy, revert, re-baseline', () => {
  const FREEZE_RULE = 'acme freeze';
  const FREEZE_POLICIES: PolicyConfig = {
    rules: [
      {
        name: FREEZE_RULE,
        match: { connections: ['acme-*'] },
        freezeWindows: [
          { name: 'always', range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' }, timeZone: 'UTC' },
        ],
      },
    ],
  };

  /** Record a db method's calls in the event log, calling through. */
  function tap(method: 'patchDeployRequestSummary' | 'claimRequestForExecution' | 'finishDeployRequest' | 'amendDeployRequestResult', label: string): void {
    const original = (db[method] as (...a: unknown[]) => unknown).bind(db);
    vi.spyOn(db, method).mockImplementation(((...args: unknown[]) => {
      events.push(label);
      return original(...args);
    }) as never);
  }

  function expectInOrder(log: string[], labels: string[]): void {
    let from = 0;
    for (const label of labels) {
      const at = log.indexOf(label, from);
      expect(at, `"${label}" at or after position ${from} in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
  }

  it('a frozen request is refused with no org read and no attempt counted; once the freeze lifts the same code runs every step in order, and a poll during the re-read re-attaches', async () => {
    await wholeRefresh();
    let policies: PolicyConfig = { rules: [] };
    deps.deploys.setPolicySource(() => {
      events.push('policy');
      return { ok: true, policies, source: 'config' };
    });
    const { id, code } = await validate({ components: [service(SERVICE_V2)] });

    // A freeze begins after the code was issued.
    policies = FREEZE_POLICIES;
    fetched = [];
    const refused = await execute(code);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      freezeExecuteRefusalText('acme-dev', { rule: FREEZE_RULE, window: 'always', until: '2999-01-01 00:00 UTC' }, 'page'),
    );
    expect(fetched).toEqual([]);
    expect(realDeploys).toBe(0);
    expect(db.getDeployRequest(id)!.status).toBe('validated');
    expect(audits('deploy.refused')).toEqual([]);
    expect(audits('policy.refused').map((e) => e.detail)).toEqual([
      { phase: 'execute', requestId: id, kind: 'deploy', reason: 'freeze', rule: FREEZE_RULE, window: 'always' },
    ]);

    // The freeze lifts: the same code runs, every part in its place.
    policies = { rules: [] };
    onRealDeploy = () => deployedService(SERVICE_V2);
    tap('patchDeployRequestSummary', 'patch');
    tap('claimRequestForExecution', 'claim');
    tap('finishDeployRequest', 'finish');
    tap('amendDeployRequestResult', 'amend');
    const insertAudit = db.insertAuditEvent.bind(db);
    vi.spyOn(db, 'insertAuditEvent').mockImplementation((input) => {
      events.push(`audit:${input.eventType}`);
      return insertAudit(input);
    });
    armGate();
    events = [];
    const first = await executeUntilRebaselining(code);
    expect(bodyOf(first).progress).toBe(REBASELINE_PROGRESS);
    expect(storedResult(id).snapshot.status).toBe('pending');
    setTimeout(releaseGate, 50);
    const result = await executeOk(code);

    // Re-attached to the job, not replayed from the row.
    expect(result.already_completed).toBeUndefined();
    expect(realDeploys).toBe(1);
    expectInOrder(events, [
      'policy', // B1: the peek's check, before the job
      'list:ApexClass', // B2: the target guard's org read
      'policy', // B3: the claim's own check
      'patch', // B3: governance.execute_check recorded
      'claim', // B3: the atomic claim
      'deploy:real', // B4: the org deploy
      'audit:deploy.executed',
      'audit:deploy.revert_written', // S45: the revert package finalized
      'finish', // the row stored 'executed' (snapshot "pending")
      'list:ApexClass', // C: the unit-level listing
      'retrieve', // C: the whole-document retrieve
      'audit:snapshot.members_refreshed',
      'amend', // C: the stored result amended
    ]);
    // Strictly after: nothing is deployed before the claim, nothing re-read before the row is stored.
    expect(events.indexOf('deploy:real')).toBeGreaterThan(events.indexOf('claim'));
    expect(events.indexOf('retrieve')).toBeGreaterThan(events.indexOf('finish'));
    expect(events.indexOf('list:ApexClass')).toBeLessThan(events.indexOf('claim'));

    // The result fields of every part.
    expect(result.deployed).toBe(true);
    expect(result.target_check).toMatchObject({ status: 'ok', checked: [expect.objectContaining({ type: 'ApexClass', api_name: 'InvoiceService' })] });
    expect(result.revert_package).toMatchObject({ dir: expect.stringContaining(id) });
    expect(result.snapshot).toMatchObject({ status: 'complete', rebaselined: [mem('ApexClass', 'InvoiceService')] });
    const summary = JSON.parse(db.getDeployRequest(id)!.summaryJson);
    expect(summary.governance.execute_check).toMatchObject({ freeze_active: false, overridden: false });
    expect(storedResult(id)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(summary)).not.toContain(code);
    expect(audits('deploy.refused')).toEqual([]);
  });
});

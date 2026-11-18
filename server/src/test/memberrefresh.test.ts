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
import { AccessTokenManager } from '../salesforce/tokens.js';
import { SnapshotStore } from '../snapshot/store.js';
import { SnapshotEngine } from '../snapshot/engine.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import type { ConnectionRecord } from '../core/types.js';
import {
  CONNECTION_REMOVED_TEXT,
  MEMBER_REFRESH_NOTES,
  invalidMemberText,
  noMetadataReadText,
  noSnapshotText,
  partialWriteText,
  type MemberRefreshSummary,
  type RebaselineOutcome,
  type SnapshotMember,
} from '../snapshot/members.js';
import { SEND_INVOICE_FLOW_XML } from './fixtures.js';

/**
 * S46 Part C (C1): member-scoped refresh through the real engine, with a
 * stateful stub org below `fetch` — token, listMetadata, retrieve and
 * checkRetrieveStatus answer from one in-memory component list, so a test
 * changes "the org" and re-reads it. The engine.test.ts harness, adapted.
 * (C2) refresh_snapshot's `members` argument through the real MCP surface
 * (createDeps/createServer over the same database, store and config).
 */

const ORG_STAMP = '2026-11-01T08:00:00.000Z';
const T0 = '2026-11-17T10:00:00.000Z';
const T1 = '2026-11-17T10:05:00.000Z';
const TYPES = ['ApexClass', 'CustomObject', 'Flow', 'LightningComponentBundle'];
const CHILD_TYPES = ['CustomField', 'ValidationRule', 'ListView', 'RecordType', 'CustomLabel', 'BotVersion'];

interface OrgComp {
  type: string;
  fullName: string;
  files: Record<string, string>;
  /** listMetadata's lastModifiedDate; null leaves it out of the listing row. */
  listStamp?: string | null;
  /** The retrieve's fileProperties lastModifiedDate (default: the listing stamp). */
  retrieveStamp?: string;
  manageableState?: string;
  namespacePrefix?: string;
  /** false: listMetadata does not name it. */
  listed?: boolean;
  /** false: a retrieve returns no file for it. */
  returned?: boolean;
}

const CLS_META =
  '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">' +
  '<apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n';
const SERVICE_V1 =
  'public with sharing class InvoiceService {\n  public static void run() { InvoiceSelector.load(); }\n}\n';
const SERVICE_V2 =
  'public with sharing class InvoiceService {\n' +
  '  public static void run() { List<Payment__c> rows = [SELECT Id FROM Payment__c]; }\n}\n';
const SELECTOR =
  'public with sharing class InvoiceSelector {\n  // selectorMarkerToken\n' +
  '  public static List<Invoice__c> load() { return [SELECT Id FROM Invoice__c]; }\n}\n';

function objectXml(fields: Array<[string, string]>, listViews: string[] = ['All']): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    fields
      .map(
        ([name, label]) =>
          `    <fields>\n        <fullName>${name}</fullName>\n        <label>${label}</label>\n` +
          '        <type>Text</type>\n    </fields>\n',
      )
      .join('') +
    listViews
      .map((v) => `    <listViews>\n        <fullName>${v}</fullName>\n        <label>${v}</label>\n    </listViews>\n`)
      .join('') +
    '</CustomObject>\n'
  );
}

const INVOICE_V1 = objectXml([
  ['Amount__c', 'Amount'],
  ['Due__c', 'Due'],
  ['Status__c', 'Status'],
]);

function cls(name: string, body: string, over: Partial<OrgComp> = {}): OrgComp {
  return {
    type: 'ApexClass',
    fullName: name,
    files: { [`classes/${name}.cls`]: body, [`classes/${name}.cls-meta.xml`]: CLS_META },
    ...over,
  };
}

function lwc(name: string, js: string, over: Partial<OrgComp> = {}): OrgComp {
  return {
    type: 'LightningComponentBundle',
    fullName: name,
    files: {
      [`lwc/${name}/${name}.js`]: js,
      [`lwc/${name}/${name}.html`]: '<template></template>',
      [`lwc/${name}/${name}.js-meta.xml`]: '<LightningComponentBundle/>',
    },
    ...over,
  };
}

function baseOrg(): OrgComp[] {
  return [
    cls('InvoiceService', SERVICE_V1),
    cls('InvoiceSelector', SELECTOR),
    { type: 'CustomObject', fullName: 'Invoice__c', files: { 'objects/Invoice__c.object': INVOICE_V1 } },
    { type: 'Flow', fullName: 'Send_Invoice', files: { 'flows/Send_Invoice.flow': SEND_INVOICE_FLOW_XML } },
    lwc('invoiceCard', 'export default class InvoiceCard {}'),
  ];
}

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let config: ContrailConfig;
let store: SnapshotStore;
let engine: SnapshotEngine;
let conn: ConnectionRecord;
let connId: string;

let org: OrgComp[];
let calls: { list: string[]; retrieve: string[]; tooling: string[]; status: number; soap: number };
let listFault: string | null;
let retrieveFailure: string | null;
let beforeFinalStatus: (() => void) | null;
let gatePromise: Promise<void> | null;
let gateRelease: () => void;
const retrieves = new Map<string, OrgComp[]>();
/** A retrieve whose manifest this matches never finishes: every status poll answers "in progress". */
let slowRetrieve: ((body: string) => boolean) | null;
/** Called at each status poll of a slow retrieve, before it answers. */
let onSlowPoll: (() => void) | null;
const slowIds = new Set<string>();
let slowPolls: number;

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

function manifestTypeOf(type: string): string {
  if (type === 'ReportFolder') return 'Report';
  if (type === 'DashboardFolder') return 'Dashboard';
  return type;
}

function packageOwned(c: OrgComp): boolean {
  return ['installed', 'installedEditable', 'released'].includes(c.manageableState ?? '');
}

function propXml(tag: string, c: OrgComp, stamp: string | null): string {
  return (
    `<${tag}><fullName>${c.fullName}</fullName><type>${c.type}</type>` +
    `<fileName>${Object.keys(c.files)[0] ?? ''}</fileName><id>x</id>` +
    (stamp !== null ? `<lastModifiedDate>${stamp}</lastModifiedDate>` : '') +
    '<lastModifiedByName>Dev User</lastModifiedByName>' +
    (c.manageableState ? `<manageableState>${c.manageableState}</manageableState>` : '') +
    (c.namespacePrefix ? `<namespacePrefix>${c.namespacePrefix}</namespacePrefix>` : '') +
    `</${tag}>`
  );
}

function stubOrg(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT-stub',
          instance_url: 'https://acme-uat.example.invalid',
          id: 'https://login.example.invalid/id/00D000000000000/005000000000000',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      calls.soap += 1;
      const body = String(init?.body ?? '');
      if (body.includes('<met:listMetadata>')) {
        calls.list.push(body);
        if (listFault) {
          return new Response(
            soapEnvelope(
              `<soapenv:Fault><faultcode>sf:REQUEST_LIMIT_EXCEEDED</faultcode><faultstring>${listFault}</faultstring></soapenv:Fault>`,
            ),
            { status: 500 },
          );
        }
        const rows: string[] = [];
        for (const q of body.matchAll(
          /<met:queries>(?:<met:folder>([^<]+)<\/met:folder>)?<met:type>([^<]+)<\/met:type><\/met:queries>/g,
        )) {
          const folder = q[1];
          for (const c of org) {
            if (c.type !== q[2] || c.listed === false) continue;
            if (folder !== undefined && !c.fullName.startsWith(`${folder}/`)) continue;
            rows.push(propXml('result', c, c.listStamp === undefined ? ORG_STAMP : c.listStamp));
          }
        }
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">${rows.join('')}</listMetadataResponse>`,
          ),
        );
      }
      if (body.includes('<met:retrieve>')) {
        calls.retrieve.push(body);
        const picked: OrgComp[] = [];
        for (const t of body.matchAll(/<met:types>([\s\S]*?)<\/met:types>/g)) {
          const name = /<met:name>([^<]+)<\/met:name>/.exec(t[1]!)![1]!;
          for (const m of t[1]!.matchAll(/<met:members>([^<]+)<\/met:members>/g)) {
            const member = m[1]!;
            for (const c of org) {
              if (manifestTypeOf(c.type) !== name || c.returned === false) continue;
              const hit =
                member === '*' ? !packageOwned(c) : c.fullName.toLowerCase() === member.toLowerCase();
              if (hit && !picked.includes(c)) picked.push(c);
            }
          }
        }
        const id = `09S${String(retrieves.size).padStart(4, '0')}`;
        // A snapshot of what the org held when the retrieve was asked for.
        retrieves.set(id, picked.map((c) => ({ ...c, files: { ...c.files } })));
        if (slowRetrieve?.(body)) slowIds.add(id);
        return new Response(
          soapEnvelope(
            `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result><id>${id}</id><done>false</done><state>Queued</state></result></retrieveResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkRetrieveStatus>')) {
        calls.status += 1;
        if (gatePromise) await gatePromise;
        const id = /<met:asyncProcessId>([^<]+)<\/met:asyncProcessId>/.exec(body)![1]!;
        if (slowIds.has(id)) {
          slowPolls += 1;
          onSlowPoll?.();
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result><done>false</done><status>InProgress</status><success>false</success><id>${id}</id></result></checkRetrieveStatusResponse>`,
            ),
          );
        }
        beforeFinalStatus?.();
        if (retrieveFailure) {
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result><done>true</done><status>Failed</status><success>false</success><id>${id}</id><errorMessage>${retrieveFailure}</errorMessage></result></checkRetrieveStatusResponse>`,
            ),
          );
        }
        const comps = retrieves.get(id) ?? [];
        const entries: Record<string, Uint8Array> = {
          'unpackaged/package.xml': strToU8('<Package>org</Package>'),
        };
        for (const c of comps) {
          for (const [rel, text] of Object.entries(c.files)) entries[`unpackaged/${rel}`] = strToU8(text);
        }
        const zip = Buffer.from(zipSync(entries)).toString('base64');
        const props = comps
          .map((c) =>
            propXml('fileProperties', c, c.retrieveStamp ?? (c.listStamp === undefined || c.listStamp === null ? ORG_STAMP : c.listStamp)),
          )
          .join('');
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result><done>true</done><status>Succeeded</status><success>true</success><id>${id}</id><zipFile>${zip}</zipFile>${props}</result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    if (url.includes('/tooling/query')) {
      calls.tooling.push(url);
      const q = decodeURIComponent(url);
      // Org-computed dependency data (MetadataComponentDependency) for the whole refresh.
      if (q.includes("MetadataComponentType = 'ApexClass'")) {
        return new Response(
          JSON.stringify({
            done: true,
            records: [
              {
                MetadataComponentName: 'InvoiceSelector',
                MetadataComponentType: 'ApexClass',
                RefMetadataComponentName: 'Invoice__c',
                RefMetadataComponentType: 'CustomObject',
              },
              {
                MetadataComponentName: 'InvoiceService',
                MetadataComponentType: 'ApexClass',
                RefMetadataComponentName: 'InvoiceSelector',
                RefMetadataComponentType: 'ApexClass',
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ done: true, records: [] }));
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-memberrefresh-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5, toolWaitMs: 10_000 },
    deploy: { ...DEFAULT_CONFIG.deploy },
  };
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  conn = db.insertConnection({
    alias: 'acme-uat',
    instanceUrl: 'https://acme-uat.example.invalid',
    loginUrl: 'https://login.example.invalid',
    orgId: '00D000000000000',
    orgName: 'Acme UAT',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT-stub');
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  engine = new SnapshotEngine(db, store, new AccessTokenManager(db, tokens, config), config, new AuditLog(db));
  org = baseOrg();
  calls = { list: [], retrieve: [], tooling: [], status: 0, soap: 0 };
  listFault = null;
  retrieveFailure = null;
  beforeFinalStatus = null;
  gatePromise = null;
  gateRelease = () => {};
  retrieves.clear();
  slowRetrieve = null;
  onSlowPoll = null;
  slowIds.clear();
  slowPolls = 0;
  stubOrg();
});

afterEach(() => {
  gateRelease();
  gatePromise = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────

const mem = (type: string, api_name: string): SnapshotMember => ({ type, api_name });

/** The baseline: a whole-type refresh, then the call log is cleared. */
async function wholeRefresh(types = TYPES): Promise<void> {
  const out = await engine.refresh(conn, types);
  expect(out.status).toBe('complete');
  calls = { list: [], retrieve: [], tooling: [], status: 0, soap: 0 };
}

async function members(list: SnapshotMember[]): Promise<MemberRefreshSummary> {
  const out = await engine.refreshMembers(conn, list);
  if (out.status !== 'complete') throw new Error(`member refresh did not complete: ${JSON.stringify(out)}`);
  expect(out.kind).toBe('members');
  return out.summary;
}

async function memberFailure(list: SnapshotMember[]): Promise<string> {
  const out = await engine.refreshMembers(conn, list);
  if (out.status !== 'failed') throw new Error(`expected a failed member refresh: ${JSON.stringify(out)}`);
  return out.error;
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

function setOrg(type: string, fullName: string, change: Partial<OrgComp> | null): void {
  const i = org.findIndex((c) => c.type === type && c.fullName === fullName);
  if (change === null) {
    org.splice(i, 1);
    return;
  }
  if (i < 0) org.push({ type, fullName, files: {}, ...change });
  else org[i] = { ...org[i]!, ...change };
}

function childListings(): string[] {
  return calls.list.filter((b) => CHILD_TYPES.some((t) => b.includes(`<met:type>${t}</met:type>`)));
}

function retrieveNamesChild(): boolean {
  return calls.retrieve.some((b) => CHILD_TYPES.some((t) => b.includes(`<met:name>${t}</met:name>`)));
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait (on real timers) until `cond` holds. Not vi.waitFor: with a faked
 * Date that one advances the fake clock, and these tests pin exact stamps.
 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await settle(10);
  }
  throw new Error('condition never held');
}

interface ToolHarness {
  client: Client;
  /** Call a tool; `text` is its text content joined, `isError` its error flag. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/**
 * The real MCP tool surface over the test's database, store, token store and
 * config. Its SnapshotEngine is its own (createDeps builds one), so its job
 * map is separate from `engine`'s; the snapshot both read and write is one.
 */
async function openTools(): Promise<ToolHarness> {
  const deps = createDeps({
    db,
    tokens,
    config,
    store,
    approvals: new ApprovalPageServer(async () => {}),
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
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  return {
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return { text, isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

/** An ok() result's leading message line and its JSON payload. */
function splitResult(text: string): { message: string; body: Record<string, unknown> } {
  const nl = text.indexOf('\n');
  return { message: text.slice(0, nl), body: JSON.parse(text.slice(nl + 1)) as Record<string, unknown> };
}

// ── the tool path ────────────────────────────────────────────────────────

describe('refreshMembers — only the named units change', () => {
  it('re-reads a changed class and a changed field: only those units, whole documents, listing-first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    await wholeRefresh();
    const archiveBefore = fs.readdirSync(path.join(tmp, 'snapshots', connId, 'archive'));
    const filesBefore = tree(current());
    const selectorBefore = row('ApexClass', 'InvoiceSelector')!;
    const flowBefore = row('Flow', 'Send_Invoice')!;
    const lwcBefore = row('LightningComponentBundle', 'invoiceCard')!;
    expect(
      db.edgesFrom(connId, 'ApexClass', 'InvoiceService').some((e) => e.toName === 'InvoiceSelector' && e.source === 'extractor'),
    ).toBe(true);
    const orgEdgesBefore = db
      .edgesFrom(connId, 'ApexClass', 'InvoiceService')
      .filter((e) => e.source === 'org');
    expect(orgEdgesBefore).toHaveLength(1);

    // The org moves on: the class changes, and one field's label.
    const INVOICE_V2 = objectXml([
      ['Amount__c', 'Amount'],
      ['Due__c', 'Due Date'],
      ['Status__c', 'Status'],
    ]);
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
      listStamp: '2026-11-17T09:58:00.000Z',
    });
    setOrg('CustomObject', 'Invoice__c', {
      files: { 'objects/Invoice__c.object': INVOICE_V2 },
      listStamp: '2026-11-17T09:59:00.000Z',
    });
    vi.setSystemTime(new Date(T1));

    const summary = await members([mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Due__c')]);
    expect(summary.members).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
      { type: 'CustomField', api_name: 'Invoice__c.Due__c', unit: 'CustomObject:Invoice__c', outcome: 'refreshed' },
    ]);
    expect(summary.counts).toEqual({ refreshed: 2, removed: 0, skipped: 0 });
    expect(summary.units).toEqual(['ApexClass:InvoiceService', 'CustomObject:Invoice__c']);
    expect(summary.retrieved_at).toBe(T1);
    expect(summary.notes).toEqual([...MEMBER_REFRESH_NOTES]);
    expect(summary.artifact_counts).toEqual({ ApexClass: 1, CustomObject: 1, CustomField: 3, ListView: 1 });

    // Files: the two units changed; everything else is byte-identical.
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
    // The object file is the org's WHOLE document — every sibling field included.
    expect(readSnap('objects/Invoice__c.object')).toBe(INVOICE_V2);
    const filesAfter = tree(current());
    expect(Object.keys(filesAfter)).toEqual(Object.keys(filesBefore));
    for (const rel of Object.keys(filesBefore)) {
      if (rel === 'classes/InvoiceService.cls' || rel === 'objects/Invoice__c.object') continue;
      expect(filesAfter[rel]).toBe(filesBefore[rel]);
    }
    // No archive zip for a member run.
    expect(fs.readdirSync(path.join(tmp, 'snapshots', connId, 'archive'))).toEqual(archiveBefore);

    // Rows: untouched rows keep their id and retrievedAt; touched rows carry the new one.
    expect(row('ApexClass', 'InvoiceSelector')).toEqual(selectorBefore);
    expect(row('Flow', 'Send_Invoice')).toEqual(flowBefore);
    expect(row('LightningComponentBundle', 'invoiceCard')).toEqual(lwcBefore);
    expect(row('ApexClass', 'InvoiceService')!.retrievedAt).toBe(T1);
    const objectRow = row('CustomObject', 'Invoice__c')!;
    expect(objectRow.retrievedAt).toBe(T1);
    expect(objectRow.lastModifiedDate).toBe('2026-11-17T09:59:00.000Z');
    // Children carry their parent document's stamp.
    for (const child of ['Invoice__c.Amount__c', 'Invoice__c.Due__c', 'Invoice__c.Status__c']) {
      const r = row('CustomField', child)!;
      expect(r.retrievedAt).toBe(T1);
      expect(r.lastModifiedDate).toBe(objectRow.lastModifiedDate);
    }
    expect(row('ListView', 'Invoice__c.All')!.lastModifiedDate).toBe(objectRow.lastModifiedDate);

    // The listing named unit types only — never a child type — and the retrieve whole documents.
    expect(childListings()).toEqual([]);
    expect(calls.list.some((b) => b.includes('<met:type>CustomObject</met:type>'))).toBe(true);
    expect(calls.list.some((b) => b.includes('<met:type>ApexClass</met:type>'))).toBe(true);
    expect(calls.retrieve).toHaveLength(1);
    expect(calls.retrieve[0]).toContain('<met:members>Invoice__c</met:members><met:name>CustomObject</met:name>');
    expect(calls.retrieve[0]).toContain('<met:members>InvoiceService</met:members><met:name>ApexClass</met:name>');
    expect(retrieveNamesChild()).toBe(false);
    expect(calls.retrieve[0]).not.toContain('<met:name>CustomField</met:name>');
    // No Tooling call at all: no dependency query, no stamp query.
    expect(calls.tooling).toEqual([]);

    // Extractor edges FROM the re-read class were rebuilt; org edges untouched.
    const from = db.edgesFrom(connId, 'ApexClass', 'InvoiceService');
    expect(from.some((e) => e.source === 'extractor' && e.toName === 'InvoiceSelector')).toBe(false);
    expect(from.some((e) => e.source === 'extractor' && e.toType === 'CustomObject' && e.toName === 'Payment__c')).toBe(true);
    expect(from.filter((e) => e.source === 'org')).toEqual(orgEdgesBefore);
    // Edges FROM other components — the flow's call to the class — are untouched.
    expect(
      db.edgesFrom(connId, 'Flow', 'Send_Invoice').some((e) => e.toType === 'ApexClass' && e.toName === 'InvoiceService'),
    ).toBe(true);
    expect(
      db.edgesFrom(connId, 'ApexClass', 'InvoiceSelector').some((e) => e.source === 'org' && e.toName === 'Invoice__c'),
    ).toBe(true);

    // The audit row: exactly the six keys (no requestId on the tool path).
    const [audit] = audits('snapshot.members_refreshed');
    expect(audit!.tool).toBe('refresh_snapshot');
    expect(audit!.outcome).toBe('success');
    expect(Object.keys(audit!.detail!).sort()).toEqual(
      ['duration_ms', 'origin', 'refreshed', 'removed', 'skipped', 'units'].sort(),
    );
    expect(audit!.detail).toMatchObject({
      origin: 'refresh_snapshot',
      refreshed: 2,
      removed: 0,
      skipped: 0,
      units: ['ApexClass:InvoiceService', 'CustomObject:Invoice__c'],
    });
  });

  it('a component gone from the org is removed: files, rows, FTS hit and its outgoing edges of both sources', async () => {
    await wholeRefresh();
    expect(db.searchArtifacts(connId, 'selectorMarkerToken', undefined, 10).map((h) => h.apiName)).toEqual([
      'InvoiceSelector',
    ]);
    expect(db.edgesFrom(connId, 'ApexClass', 'InvoiceSelector').map((e) => e.source).sort()).toEqual([
      'extractor',
      'org',
    ]);
    setOrg('ApexClass', 'InvoiceSelector', null);

    const summary = await members([mem('ApexClass', 'InvoiceSelector')]);
    expect(summary.members).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceSelector', unit: 'ApexClass:InvoiceSelector', outcome: 'removed' },
    ]);
    expect(readSnap('classes/InvoiceSelector.cls')).toBeNull();
    expect(readSnap('classes/InvoiceSelector.cls-meta.xml')).toBeNull();
    expect(row('ApexClass', 'InvoiceSelector')).toBeNull();
    expect(db.searchArtifacts(connId, 'selectorMarkerToken', undefined, 10)).toEqual([]);
    expect(db.edgesFrom(connId, 'ApexClass', 'InvoiceSelector')).toEqual([]);
    // An edge TO it from another component remains (a whole-type refresh rebuilds those).
    expect(
      db.edgesFrom(connId, 'ApexClass', 'InvoiceService').some((e) => e.toName === 'InvoiceSelector'),
    ).toBe(true);
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V1);
    expect(summary.notes).toEqual([...MEMBER_REFRESH_NOTES]);
  });

  it('on the tool path a child missing from the re-read parent document is removed', async () => {
    await wholeRefresh();
    setOrg('CustomObject', 'Invoice__c', {
      files: { 'objects/Invoice__c.object': objectXml([['Amount__c', 'Amount'], ['Due__c', 'Due']]) },
    });
    const summary = await members([mem('CustomField', 'Invoice__c.Status__c')]);
    expect(summary.members).toEqual([
      {
        type: 'CustomField',
        api_name: 'Invoice__c.Status__c',
        unit: 'CustomObject:Invoice__c',
        outcome: 'removed',
        detail: 'not in the parent document the org returned',
      },
    ]);
    expect(row('CustomField', 'Invoice__c.Status__c')).toBeNull();
    expect(row('CustomField', 'Invoice__c.Amount__c')).not.toBeNull();
    expect(readSnap('objects/Invoice__c.object')).not.toContain('Status__c');
  });

  it('not_returned: the org lists it but the retrieve returns no file — the copy is left as it was', async () => {
    await wholeRefresh();
    const before = rows();
    const filesBefore = tree(current());
    setOrg('ApexClass', 'InvoiceSelector', { returned: false });
    const summary = await members([mem('ApexClass', 'InvoiceSelector')]);
    expect(summary.members).toEqual([
      {
        type: 'ApexClass',
        api_name: 'InvoiceSelector',
        unit: 'ApexClass:InvoiceSelector',
        outcome: 'skipped',
        reason: 'not_returned',
      },
    ]);
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
    expect(summary.notes).toEqual([]);
    expect(summary.units).toEqual([]);
  });

  it('presence_unknown: the listing could not be read and the retrieve returned no file', async () => {
    await wholeRefresh();
    const before = rows();
    listFault = 'REQUEST_LIMIT_EXCEEDED: too many listMetadata calls';
    setOrg('ApexClass', 'InvoiceSelector', { returned: false });
    const summary = await members([mem('ApexClass', 'InvoiceSelector')]);
    expect(summary.members).toEqual([
      {
        type: 'ApexClass',
        api_name: 'InvoiceSelector',
        unit: 'ApexClass:InvoiceSelector',
        outcome: 'skipped',
        reason: 'presence_unknown',
        detail: 'Metadata API fault: REQUEST_LIMIT_EXCEEDED: too many listMetadata calls',
      },
    ]);
    expect(rows()).toEqual(before);
  });

  it('type_not_in_snapshot for a Report: nothing retrieved, no reports/ directory, the index keys unchanged', async () => {
    await wholeRefresh();
    org.push(
      { type: 'ReportFolder', fullName: 'Sales', files: { 'reports/Sales-meta.xml': '<ReportFolder/>' } },
      { type: 'Report', fullName: 'Sales/Pipeline', files: { 'reports/Sales/Pipeline.report': '<Report/>' } },
    );
    const keysBefore = Object.keys(db.countArtifactsByType(connId));
    const summary = await members([mem('Report', 'Sales/Pipeline')]);
    expect(summary.members).toEqual([
      {
        type: 'Report',
        api_name: 'Sales/Pipeline',
        unit: 'Report:Sales/Pipeline',
        outcome: 'skipped',
        reason: 'type_not_in_snapshot',
      },
    ]);
    expect(calls.retrieve).toEqual([]);
    expect(summary.retrieved_at).toBeNull();
    expect(fs.existsSync(path.join(current(), 'reports'))).toBe(false);
    expect(Object.keys(db.countArtifactsByType(connId))).toEqual(keysBefore);
  });

  it('the first ApexTrigger is written when the listing shows it is the only one; two negatives are not', async () => {
    await wholeRefresh();
    const trigger: OrgComp = {
      type: 'ApexTrigger',
      fullName: 'InvoiceTrigger',
      files: {
        'triggers/InvoiceTrigger.trigger': 'trigger InvoiceTrigger on Invoice__c (before insert) {}',
        'triggers/InvoiceTrigger.trigger-meta.xml': '<ApexTrigger/>',
      },
    };
    // Negative 1: another trigger is listed — the type stays uncovered.
    org.push(trigger, {
      type: 'ApexTrigger',
      fullName: 'PaymentTrigger',
      files: { 'triggers/PaymentTrigger.trigger': 'trigger PaymentTrigger on Payment__c (before insert) {}' },
    });
    const other = await members([mem('ApexTrigger', 'InvoiceTrigger')]);
    expect(other.members[0]).toMatchObject({ outcome: 'skipped', reason: 'type_not_in_snapshot' });
    expect(readSnap('triggers/InvoiceTrigger.trigger')).toBeNull();
    expect(db.countArtifactsByType(connId).ApexTrigger).toBeUndefined();

    // Negative 2: a listing that names no trigger at all proves nothing.
    org = org.filter((c) => c.type !== 'ApexTrigger');
    org.push({ ...trigger, listed: false });
    const vacuous = await members([mem('ApexTrigger', 'InvoiceTrigger')]);
    expect(vacuous.members[0]).toMatchObject({ outcome: 'skipped', reason: 'type_not_in_snapshot' });
    expect(readSnap('triggers/InvoiceTrigger.trigger')).toBeNull();
    expect(calls.retrieve).toEqual([]);

    // The proof: the listing names it and no other unpackaged trigger.
    org = org.filter((c) => c.type !== 'ApexTrigger');
    org.push(trigger, {
      type: 'ApexTrigger',
      fullName: 'pkg__Sync',
      files: {},
      manageableState: 'installed',
      namespacePrefix: 'pkg',
    });
    const first = await members([mem('ApexTrigger', 'InvoiceTrigger')]);
    expect(first.members[0]).toMatchObject({ outcome: 'refreshed', unit: 'ApexTrigger:InvoiceTrigger' });
    expect(readSnap('triggers/InvoiceTrigger.trigger')).toContain('trigger InvoiceTrigger');
    expect(db.countArtifactsByType(connId).ApexTrigger).toBe(1);
  });
});

describe('refreshMembers — package-owned units', () => {
  async function orgChangesGone(): Promise<Array<{ type: string; api_name: string }>> {
    const tools = await openTools();
    try {
      const { text } = await tools.call('get_org_changes', { connection: 'acme-uat' });
      const body = JSON.parse(text) as { gone_from_org?: Array<{ type: string; api_name: string }> };
      return body.gone_from_org ?? [];
    } finally {
      await tools.close();
    }
  }

  it('a field on an installed object the snapshot does not hold is skipped: nothing added, nothing reads as gone', async () => {
    await wholeRefresh();
    org.push({
      type: 'CustomObject',
      fullName: 'pkg__Ledger__c',
      files: { 'objects/pkg__Ledger__c.object': objectXml([['pkg__Total__c', 'Total']]) },
      manageableState: 'installed',
      namespacePrefix: 'pkg',
    });
    const countsBefore = db.countArtifactsByType(connId);
    const summary = await members([mem('CustomField', 'pkg__Ledger__c.pkg__Total__c')]);
    expect(summary.members).toEqual([
      {
        type: 'CustomField',
        api_name: 'pkg__Ledger__c.pkg__Total__c',
        unit: 'CustomObject:pkg__Ledger__c',
        outcome: 'skipped',
        reason: 'package_owned',
      },
    ]);
    expect(calls.retrieve).toEqual([]);
    expect(db.countArtifactsByType(connId)).toEqual(countsBefore);
    expect(fs.existsSync(path.join(current(), 'objects', 'pkg__Ledger__c.object'))).toBe(false);
    const gone = await orgChangesGone();
    expect(gone.filter((g) => g.api_name.startsWith('pkg__Ledger__c'))).toEqual([]);
  });

  it('an installedEditable LWC bundle with no row is skipped; a package-owned unit that HAS a row is re-read', async () => {
    await wholeRefresh();
    org.push(lwc('pkgCard', 'export default class PkgCard {}', { manageableState: 'installedEditable' }));
    const skipped = await members([mem('LightningComponentBundle', 'pkgCard')]);
    expect(skipped.members[0]).toMatchObject({ outcome: 'skipped', reason: 'package_owned' });
    expect(fs.existsSync(path.join(current(), 'lwc', 'pkgCard'))).toBe(false);

    setOrg('LightningComponentBundle', 'invoiceCard', {
      manageableState: 'installedEditable',
      files: {
        'lwc/invoiceCard/invoiceCard.js': 'export default class InvoiceCard { v2 }',
        'lwc/invoiceCard/invoiceCard.js-meta.xml': '<LightningComponentBundle/>',
      },
    });
    const held = await members([mem('LightningComponentBundle', 'invoiceCard')]);
    expect(held.members[0]).toMatchObject({ outcome: 'refreshed' });
    expect(readSnap('lwc/invoiceCard/invoiceCard.js')).toBe('export default class InvoiceCard { v2 }');
    // The bundle is replaced whole: the file the org no longer returns is gone.
    expect(readSnap('lwc/invoiceCard/invoiceCard.html')).toBeNull();
  });

  it('with the listing faulted, the retrieve\'s own fileProperties row decides the same way', async () => {
    await wholeRefresh();
    org.push(lwc('pkgCard', 'export default class PkgCard {}', { manageableState: 'installed' }));
    listFault = 'REQUEST_LIMIT_EXCEEDED: busy';
    const summary = await members([mem('LightningComponentBundle', 'pkgCard')]);
    expect(calls.retrieve).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({ outcome: 'skipped', reason: 'package_owned' });
    expect(fs.existsSync(path.join(current(), 'lwc', 'pkgCard'))).toBe(false);
    expect(row('LightningComponentBundle', 'pkgCard')).toBeNull();
  });

  it('the engine keeps no copy of the rule: it asks snapshot/members.ts\'s isPackageOwnedState', () => {
    // members.ts is the byte-identical unit the desktop mirrors, so the rule
    // (Decision 15) lives there once; the hand-mirrored engine only imports
    // and calls it. (Its S36 isPackageOwned is a different, wildcard rule.)
    const engine = fs.readFileSync(new URL('../snapshot/engine.ts', import.meta.url), 'utf8');
    expect(engine).toMatch(/import\s*\{[^}]*\bisPackageOwnedState\b[^}]*\}\s*from\s*'\.\/members\.js'/);
    expect(engine).toMatch(/isPackageOwnedState\(\s*listedPropFor\(/);
    expect(engine).not.toMatch(/\b(function|const|let|var)\s+isPackageOwned(State|Listing)\b/);
  });
});

describe('refreshMembers — stamps come from the listing first', () => {
  it('an ApexClass and an LWC bundle carry the listing stamp, not the retrieve\'s; no listing stamp → the retrieve\'s', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceService', {
      listStamp: '2026-11-16T12:00:00.000Z',
      retrieveStamp: '2026-11-16T12:00:07.000Z',
    });
    setOrg('LightningComponentBundle', 'invoiceCard', {
      listStamp: '2026-11-16T13:00:00.000Z',
      retrieveStamp: '2026-11-16T13:00:09.000Z',
    });
    setOrg('ApexClass', 'InvoiceSelector', { listStamp: null, retrieveStamp: '2026-11-16T14:00:00.000Z' });
    setOrg('CustomObject', 'Invoice__c', {
      listStamp: '2026-11-16T15:00:00.000Z',
      retrieveStamp: '2026-11-16T15:00:05.000Z',
    });
    await members([
      mem('ApexClass', 'InvoiceService'),
      mem('LightningComponentBundle', 'invoiceCard'),
      mem('ApexClass', 'InvoiceSelector'),
      mem('CustomField', 'Invoice__c.Amount__c'),
    ]);
    expect(row('ApexClass', 'InvoiceService')!.lastModifiedDate).toBe('2026-11-16T12:00:00.000Z');
    expect(row('LightningComponentBundle', 'invoiceCard')!.lastModifiedDate).toBe('2026-11-16T13:00:00.000Z');
    expect(row('ApexClass', 'InvoiceSelector')!.lastModifiedDate).toBe('2026-11-16T14:00:00.000Z');
    expect(row('CustomObject', 'Invoice__c')!.lastModifiedDate).toBe('2026-11-16T15:00:00.000Z');
    expect(row('CustomField', 'Invoice__c.Amount__c')!.lastModifiedDate).toBe('2026-11-16T15:00:00.000Z');
    expect(row('CustomField', 'Invoice__c.Due__c')!.lastModifiedDate).toBe('2026-11-16T15:00:00.000Z');
  });
});

describe('refreshMembers — the commit point', () => {
  async function nothingWritten(mutate: () => void, expected: string): Promise<void> {
    await wholeRefresh();
    const before = rows();
    const filesBefore = tree(current());
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    // Between the retrieve's last poll and the commit.
    beforeFinalStatus = mutate;
    const error = await memberFailure([mem('ApexClass', 'InvoiceService')]);
    expect(error).toBe(expected);
    expect(calls.retrieve).toHaveLength(1);
    if (db.getConnection(connId)) {
      expect(rows()).toEqual(before);
      expect(tree(current())).toEqual(filesBefore);
    } else {
      // Removed: nothing written, and the snapshot directory is not recreated.
      expect(db.listArtifacts(connId)).toEqual([]);
      expect(fs.existsSync(path.join(tmp, 'snapshots', connId))).toBe(false);
    }
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    expect(audits('snapshot.members_refresh_failed')).toHaveLength(1);
  }

  it('metadata_read revoked while the re-read ran: zero files and zero rows written', async () => {
    await nothingWritten(() => db.updateGrants(connId, emptyGrantSet()), noMetadataReadText('acme-uat'));
  });

  it('the connection removed while the re-read ran: nothing written, the snapshot directory not recreated', async () => {
    await nothingWritten(() => {
      db.deleteConnection(connId);
      store.removeConnection(connId);
    }, CONNECTION_REMOVED_TEXT);
  });

  it('a failure after the commit point is reported as a snapshot that may be only partly updated', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    vi.spyOn(db, 'replaceArtifactRows').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const error = await memberFailure([mem('ApexClass', 'InvoiceService')]);
    expect(error).toBe(partialWriteText('SQLITE_BUSY: database is locked'));
    expect(error).toBe(
      'the snapshot may be only partly updated for these components (SQLITE_BUSY: database is locked) — its files and its index can disagree until they are re-read',
    );
    // The files had already been swapped — which is why the error says "partly".
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
  });

  it('a failed retrieve leaves every byte and row as it was', async () => {
    await wholeRefresh();
    const before = rows();
    const filesBefore = tree(current());
    retrieveFailure = 'INVALID_CROSS_REFERENCE_KEY: something went wrong';
    const error = await memberFailure([mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Due__c')]);
    expect(error).toBe('retrieve failed: INVALID_CROSS_REFERENCE_KEY: something went wrong');
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
  });
});

describe('refreshMembers — refusals and identity', () => {
  it('no snapshot yet: the member refresh says so and touches nothing', async () => {
    const error = await memberFailure([mem('ApexClass', 'InvoiceService')]);
    expect(error).toBe(noSnapshotText('acme-uat'));
    expect(error).toBe(
      '"acme-uat" has no snapshot yet — a member-scoped refresh only updates an existing snapshot. Run refresh_snapshot without members first.',
    );
    expect(calls.soap).toBe(0);
  });

  it('a Profile-only run makes zero SOAP calls', async () => {
    await wholeRefresh();
    const summary = await members([mem('Profile', 'Admin')]);
    expect(summary.members).toEqual([{ type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' }]);
    expect(summary.counts).toEqual({ refreshed: 0, removed: 0, skipped: 1 });
    expect(summary.retrieved_at).toBeNull();
    expect(calls.soap).toBe(0);
  });

  it('a FlowDefinition member re-reads the Flow', async () => {
    await wholeRefresh();
    setOrg('Flow', 'Send_Invoice', {
      files: { 'flows/Send_Invoice.flow': SEND_INVOICE_FLOW_XML.replace('Send Invoice', 'Send Invoice v2') },
    });
    const summary = await members([mem('FlowDefinition', 'Send_Invoice')]);
    expect(summary.members).toEqual([
      { type: 'FlowDefinition', api_name: 'Send_Invoice', unit: 'Flow:Send_Invoice', outcome: 'refreshed' },
    ]);
    expect(calls.retrieve[0]).toContain('<met:members>Send_Invoice</met:members><met:name>Flow</met:name>');
    expect(calls.retrieve[0]).not.toContain('FlowDefinition');
    expect(readSnap('flows/Send_Invoice.flow')).toContain('Send Invoice v2');
  });

  it('a member job and a same-type refresh are different jobs and serialise; a poll returns kind members; a reordered re-send attaches', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 30;
    armGate();
    const first = await engine.refreshMembers(conn, [mem('ApexClass', 'InvoiceService'), mem('ApexClass', 'InvoiceSelector')]);
    expect(first.status).toBe('in_progress');
    expect(first.job_id).toMatch(/^members-[0-9a-f]{12}$/);
    if (first.status !== 'in_progress') return;
    expect(first.state.members).toEqual([mem('ApexClass', 'InvoiceService'), mem('ApexClass', 'InvoiceSelector')]);
    expect(first.state.types).toEqual([]);
    expect(calls.list).toHaveLength(1);

    const types = await engine.refresh(conn, ['ApexClass']);
    expect(types.status).toBe('in_progress');
    expect(types.job_id).not.toBe(first.job_id);
    // Serialised: the type refresh has not touched the org while the member run holds the chain.
    expect(calls.list).toHaveLength(1);

    const again = await engine.refreshMembers(conn, [mem('ApexClass', 'invoiceselector'), mem('ApexClass', 'INVOICESERVICE')]);
    expect(again.status).toBe('in_progress');
    expect(again.job_id).toBe(first.job_id);
    expect(calls.list).toHaveLength(1);

    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const polled = await engine.refresh(conn, undefined, first.job_id);
    expect(polled.status).toBe('complete');
    if (polled.status !== 'complete') return;
    expect(polled.kind).toBe('members');
    if (polled.kind !== 'members') return;
    expect(polled.summary.counts).toEqual({ refreshed: 2, removed: 0, skipped: 0 });

    const typesDone = await engine.refresh(conn, ['ApexClass']);
    expect(typesDone.status).toBe('complete');
    if (typesDone.status !== 'complete') return;
    expect(typesDone.kind).toBe('types');
    expect(calls.list.length).toBeGreaterThan(1);
  });

  it('a live foreign lease (the desktop app mid-sync) refuses the member refresh before it touches the org', async () => {
    await wholeRefresh();
    const raw = new Database(path.join(tmp, 'test.db'));
    try {
      raw.exec(
        `CREATE TABLE app_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL,
           pid INTEGER, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
      );
      raw
        .prepare(`INSERT INTO app_locks (name, holder, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(
          `snapshot:${connId}`,
          'desktop:4242',
          4242,
          new Date().toISOString(),
          new Date(Date.now() + 10 * 60_000).toISOString(),
        );
      const error = await memberFailure([mem('ApexClass', 'InvoiceService')]);
      expect(error).toBe(
        'another Contrail process (the desktop app) is refreshing this connection — try again once its sync finishes',
      );
      expect(calls.soap).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('more than 100 members is refused without a run', async () => {
    await wholeRefresh();
    const many = Array.from({ length: 101 }, (_, i) => mem('ApexClass', `Cls${i}`));
    const error = await memberFailure(many);
    expect(error).toBe('a member-scoped refresh takes at most 100 components (101 were named)');
    expect(calls.soap).toBe(0);
  });
});

describe('refreshMembers — a finished result is reused for 60 s only', () => {
  const list = [mem('ApexClass', 'InvoiceService')];

  /** Start a member job that finishes with nobody collecting it; return its id. */
  async function finishUncollected(): Promise<string> {
    config.snapshot.toolWaitMs = 20;
    armGate();
    const started = await engine.refreshMembers(conn, list);
    expect(started.status).toBe('in_progress');
    const finished = (): number =>
      audits('snapshot.members_refreshed').length + audits('snapshot.members_refresh_failed').length;
    const done = finished();
    releaseGate();
    await until(() => finished() === done + 1);
    await settle();
    config.snapshot.toolWaitMs = 10_000;
    return started.job_id;
  }

  it('+59 s: the stored summary, no new org call; +61 s: a new listing and retrieve; a job_id poll still collects', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse(T0);
    vi.setSystemTime(new Date(t0));
    await wholeRefresh();

    await finishUncollected();
    const soap = calls.soap;
    vi.setSystemTime(new Date(t0 + 59_000));
    const reused = await engine.refreshMembers(conn, list);
    expect(reused.status).toBe('complete');
    if (reused.status !== 'complete') return;
    expect(reused.summary.retrieved_at).toBe(new Date(t0).toISOString());
    expect(calls.soap).toBe(soap);

    vi.setSystemTime(new Date(t0 + 60_000));
    await finishUncollected(); // finishes at +60 s
    const lists = calls.list.length;
    vi.setSystemTime(new Date(t0 + 60_000 + 61_000));
    const fresh = await engine.refreshMembers(conn, list);
    expect(fresh.status).toBe('complete');
    if (fresh.status !== 'complete') return;
    expect(fresh.summary.retrieved_at).toBe(new Date(t0 + 121_000).toISOString());
    expect(calls.list.length).toBe(lists + 1);

    const jobId = await finishUncollected(); // finishes at +121 s
    const soapBeforePoll = calls.soap;
    vi.setSystemTime(new Date(t0 + 121_000 + 61_000));
    const polled = await engine.refresh(conn, undefined, jobId);
    expect(polled.status).toBe('complete');
    if (polled.status !== 'complete' || polled.kind !== 'members') throw new Error('expected a member summary');
    expect(polled.summary.retrieved_at).toBe(new Date(t0 + 121_000).toISOString());
    expect(calls.soap).toBe(soapBeforePoll);
  });

  it('a FAILED uncollected job re-sent after 61 s starts a new run instead of returning the old error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse(T0);
    vi.setSystemTime(new Date(t0));
    await wholeRefresh();
    retrieveFailure = 'UNKNOWN_EXCEPTION: try later';
    await finishUncollected();
    retrieveFailure = null;
    const retrievesBefore = calls.retrieve.length;
    vi.setSystemTime(new Date(t0 + 61_000));
    const again = await engine.refreshMembers(conn, list);
    expect(again.status).toBe('complete');
    expect(calls.retrieve.length).toBe(retrievesBefore + 1);
  });

  it('within 60 s a failed uncollected job is still delivered as failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse(T0);
    vi.setSystemTime(new Date(t0));
    await wholeRefresh();
    retrieveFailure = 'UNKNOWN_EXCEPTION: try later';
    await finishUncollected();
    retrieveFailure = null;
    vi.setSystemTime(new Date(t0 + 30_000));
    const error = await memberFailure(list);
    expect(error).toBe('retrieve failed: UNKNOWN_EXCEPTION: try later');
  });
});

// ── the tool: refresh_snapshot members (C2) ─────────────────────────────

describe('refresh_snapshot members — the tool path', () => {
  const ALONE = 'Pass members ALONE with connection — not with types, check_only or job_id.';
  const invalid = (type: string, apiName: string) =>
    `invalid member "${type}:${apiName}" — expected a metadata type name and a full API name ` +
    '(children dotted, foldered names "Folder/Name").';

  let tools: ToolHarness;
  beforeEach(async () => {
    tools = await openTools();
  });
  afterEach(async () => {
    await tools.close();
  });

  const refresh = (args: Record<string, unknown>) =>
    tools.call('refresh_snapshot', { connection: 'acme-uat', ...args });

  it('describes members (1 to 100 components, alone) and polls by type set or member set', async () => {
    const { tools: listed } = await tools.client.listTools();
    const tool = listed.find((t) => t.name === 'refresh_snapshot')!;
    expect(tool.description).toContain(
      'check_only=true just reports staleness. members re-reads only the named components (a child such as ' +
        'a CustomField re-reads its whole parent object; a bundle is replaced whole) into an EXISTING snapshot — ' +
        'use it for what an execute_deploy result reports as not re-baselined, or to pick up one change made in ' +
        "the org. A member whose type this snapshot does not cover is skipped, unless the org's listing shows no " +
        'unpackaged component of that type other than the named ones (never for foldered types). A member-scoped ' +
        'refresh never re-queries the org-computed dependency data and does not see anything else that changed in the org.',
    );
    const props = tool.inputSchema.properties as Record<
      string,
      { description?: string; minItems?: number; maxItems?: number }
    >;
    expect(props.members!.minItems).toBe(1);
    expect(props.members!.maxItems).toBe(100);
    expect(props.members!.description).toBe(
      'Re-read ONLY these components — [{type, api_name}], at most 100, passed ALONE with connection ' +
        '(not with types, check_only or job_id). Children are dotted (Account.My_Field__c) and re-read their ' +
        'parent document; a FlowDefinition name re-reads the Flow. Each member comes back refreshed, removed ' +
        '(no longer in what the org returned for it) or skipped with the reason.',
    );
    expect(props.job_id!.description).toBe(
      'Poll a RUNNING refresh by the job_id an earlier call returned — pass {connection, job_id} ALONE. ' +
        'Jobs are keyed by their requested type set (or member set), so a poll only ever returns the refresh ' +
        'it names (re-sending the same types or members attaches to the same job too).',
    );
  });

  it('members with types, check_only or job_id is refused before any org call', async () => {
    await wholeRefresh();
    const members = [mem('ApexClass', 'InvoiceService')];
    for (const extra of [
      { types: ['ApexClass'] },
      { types: [] },
      { check_only: true },
      { check_only: false },
      { job_id: 'members-000000000000' },
    ]) {
      const out = await refresh({ members, ...extra });
      expect(out, JSON.stringify(extra)).toEqual({ text: ALONE, isError: true });
    }
    expect(calls.soap).toBe(0);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    expect(audits('snapshot.members_refresh_failed')).toEqual([]);
  });

  it('a bad member type or name is refused, naming the member, before any org call', async () => {
    await wholeRefresh();
    const cases: Array<[string, string]> = [
      ['Apex Class', 'InvoiceService'],
      ['Apex_Class', 'InvoiceService'],
      ['ApexClass', '../InvoiceService'],
      ['ApexClass', 'classes\\InvoiceService'],
      ['Report', 'Sales/Pipeline/Extra'],
      ['ApexClass', ''],
      ['CustomField', 'Invoice__c.Due__c;DROP'],
    ];
    for (const [type, apiName] of cases) {
      // One good member first: a single bad one refuses the whole call.
      const out = await refresh({
        members: [mem('ApexClass', 'InvoiceSelector'), mem(type, apiName)],
      });
      expect(out).toEqual({ text: invalid(type, apiName), isError: true });
    }
    expect(calls.soap).toBe(0);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
    expect(audits('snapshot.members_refresh_failed')).toEqual([]);
  });

  it('101 members (and an empty list) are refused by the schema; 100 are accepted', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => mem('ApexClass', `Cls${i}`));
    const over = await refresh({ members: many(101) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('Invalid arguments for tool refresh_snapshot');
    const empty = await refresh({ members: [] });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('Invalid arguments for tool refresh_snapshot');
    expect(calls.soap).toBe(0);

    // 100 pass the schema and reach the engine — which refuses here only
    // because this connection has no snapshot yet, in the member wording.
    const hundred = await refresh({ members: many(100) });
    const jobId = /^Member refresh failed \(job (members-[0-9a-f]{12})\): /.exec(hundred.text)?.[1];
    expect(hundred).toEqual({
      text: `Member refresh failed (job ${jobId}): ${noSnapshotText('acme-uat')}`,
      isError: true,
    });
    expect(calls.soap).toBe(0);
  });

  it('the grant gate still applies: no metadata_read, no member refresh', async () => {
    await wholeRefresh();
    db.updateGrants(connId, emptyGrantSet());
    const out = await refresh({ members: [mem('ApexClass', 'InvoiceService')] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('metadata_read');
    expect(calls.soap).toBe(0);
    expect(audits('grant.refused').some((e) => e.tool === 'refresh_snapshot')).toBe(true);
  });

  it('complete: the member message, the job_id and the summary; only the named unit changes', async () => {
    await wholeRefresh();
    const before = row('ApexClass', 'InvoiceSelector')!;
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    setOrg('ApexClass', 'InvoiceSelector', { returned: false });
    const out = await refresh({
      members: [mem('ApexClass', 'InvoiceService'), mem('ApexClass', 'InvoiceSelector'), mem('Profile', 'Admin')],
    });
    expect(out.isError).toBe(false);
    const { message, body } = splitResult(out.text);
    expect(message).toBe('Member refresh complete: 1 refreshed, 0 removed, 2 skipped.');
    expect(body.job_id).toMatch(/^members-[0-9a-f]{12}$/);
    expect(body.connection).toBe('acme-uat');
    expect(body.counts).toEqual({ refreshed: 1, removed: 0, skipped: 2 });
    expect(body.members).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
      {
        type: 'ApexClass',
        api_name: 'InvoiceSelector',
        unit: 'ApexClass:InvoiceSelector',
        outcome: 'skipped',
        reason: 'not_returned',
      },
      { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' },
    ]);
    expect(body.units).toEqual(['ApexClass:InvoiceService']);
    expect(body.notes).toEqual([...MEMBER_REFRESH_NOTES]);
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
    expect(row('ApexClass', 'InvoiceSelector')).toEqual(before);
    const [audit] = audits('snapshot.members_refreshed');
    expect(audit!.tool).toBe('refresh_snapshot');
    expect(audit!.detail).toMatchObject({ origin: 'refresh_snapshot', refreshed: 1, removed: 0, skipped: 2 });
  });

  it('in progress, then a job_id poll collects the member job with the member message — a type job keeps its own', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 30;
    armGate();
    const started = await refresh({
      members: [mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Due__c')],
    });
    expect(started.isError).toBe(false);
    const first = splitResult(started.text);
    const jobId = first.body.job_id as string;
    expect(jobId).toMatch(/^members-[0-9a-f]{12}$/);
    expect(first.message).toBe(
      `Member refresh is still running — poll with {connection, job_id: "${jobId}"}, ` +
        'or re-send the same members (which attaches to this same job).',
    );
    expect(first.body.types).toEqual([]);
    expect(first.body.members).toEqual([mem('ApexClass', 'InvoiceService'), mem('CustomField', 'Invoice__c.Due__c')]);
    // Held at the org's answer to the retrieve.
    await until(() => calls.status >= 1);

    // A poll while it still runs, and a reordered, re-cased re-send, both attach.
    const polling = splitResult((await refresh({ job_id: jobId })).text);
    expect(polling.message).toBe(
      `Member refresh is still running — poll with {connection, job_id: "${jobId}"}, ` +
        'or re-send the same members (which attaches to this same job).',
    );
    const resent = splitResult(
      (await refresh({ members: [mem('CustomField', 'invoice__c.due__c'), mem('ApexClass', 'INVOICESERVICE')] }))
        .text,
    );
    expect(resent.body.job_id).toBe(jobId);
    expect(calls.retrieve).toHaveLength(1);

    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const polled = await refresh({ job_id: jobId });
    expect(polled.isError).toBe(false);
    const done = splitResult(polled.text);
    expect(done.message).toBe('Member refresh complete: 2 refreshed, 0 removed, 0 skipped.');
    expect(done.body.job_id).toBe(jobId);
    expect(done.body.counts).toEqual({ refreshed: 2, removed: 0, skipped: 0 });

    // A whole-type refresh through the same tool keeps today's message.
    const types = await refresh({ types: ['ApexClass'] });
    expect(splitResult(types.text).message).toBe('Snapshot refreshed.');
  });

  it('a failed member job collected by job_id is a member refresh failure, as the members call says it; a type job keeps its own wording', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 30;
    armGate();
    const started = await refresh({ members: [mem('ApexClass', 'InvoiceService')] });
    expect(started.isError).toBe(false);
    const jobId = splitResult(started.text).body.job_id as string;
    expect(jobId).toMatch(/^members-[0-9a-f]{12}$/);
    await until(() => calls.status >= 1);
    retrieveFailure = 'UNKNOWN_EXCEPTION: try later';
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    expect(await refresh({ job_id: jobId })).toEqual({
      text: `Member refresh failed (job ${jobId}): retrieve failed: UNKNOWN_EXCEPTION: try later`,
      isError: true,
    });

    // A failed whole-type job collected the same way keeps the snapshot wording.
    config.snapshot.toolWaitMs = 30;
    armGate();
    const typed = await refresh({ types: ['ApexClass'] });
    expect(typed.isError).toBe(false);
    const typeJob = splitResult(typed.text).body.job_id as string;
    expect(typeJob.startsWith('members-')).toBe(false);
    await until(() => calls.status >= 2);
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const failedType = await refresh({ job_id: typeJob });
    expect(failedType.isError).toBe(true);
    expect(failedType.text.startsWith(`Snapshot refresh failed (job ${typeJob}): `)).toBe(true);
  });

  it('a poll of a collected job says what to re-send: the same members for a member job, types for a type job', async () => {
    await wholeRefresh();
    const collected = await refresh({ members: [mem('ApexClass', 'InvoiceService')] });
    expect(collected.isError).toBe(false);
    const memberJob = splitResult(collected.text).body.job_id as string;
    expect(memberJob).toMatch(/^members-[0-9a-f]{12}$/);
    const soap = calls.soap;
    expect(await refresh({ job_id: memberJob })).toEqual({
      text:
        `No running or uncollected refresh job "${memberJob}" on "acme-uat" — its result may already ` +
        'have been collected. Re-send the same members to start a new member refresh.',
      isError: true,
    });
    expect(calls.soap).toBe(soap); // the poll started no work

    const typed = await refresh({ types: ['ApexClass'] });
    const typeJob = splitResult(typed.text).body.job_id as string;
    expect(typeJob.startsWith('members-')).toBe(false);
    const typedSoap = calls.soap;
    expect(await refresh({ job_id: typeJob })).toEqual({
      text:
        `No running or uncollected refresh job "${typeJob}" on "acme-uat" — its result may already ` +
        'have been collected. Re-send types to start a new refresh.',
      isError: true,
    });
    expect(calls.soap).toBe(typedSoap);
  });

  it('a failure carries the step-7 sentence, or the partly-updated sentence, whole', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    const before = rows();
    // metadata_read revoked between the retrieve's last poll and the commit.
    beforeFinalStatus = () => db.updateGrants(connId, emptyGrantSet());
    const revoked = await refresh({ members: [mem('ApexClass', 'InvoiceService')] });
    const jobId = /members-[0-9a-f]{12}/.exec(revoked.text)![0];
    expect(revoked).toEqual({
      text: `Member refresh failed (job ${jobId}): ${noMetadataReadText('acme-uat')}`,
      isError: true,
    });
    expect(revoked.text).toBe(
      `Member refresh failed (job ${jobId}): "acme-uat" no longer grants metadata_read — nothing was written to the snapshot.`,
    );
    expect(rows()).toEqual(before);
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V1);

    beforeFinalStatus = null;
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    db.updateGrants(connId, grants);
    vi.spyOn(db, 'replaceArtifactRows').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const partial = await refresh({ members: [mem('ApexClass', 'InvoiceService')] });
    expect(partial).toEqual({
      text: `Member refresh failed (job ${jobId}): ${partialWriteText('SQLITE_BUSY: database is locked')}`,
      isError: true,
    });
  });
});

// ── the execute path (engine level; the deploy hook is wired in its own slice) ──

describe('rebaselineMembers', () => {
  const opts = (over: Partial<{ timeoutMs: number; requestId: string; deleted: SnapshotMember[] }> = {}) => ({
    timeoutMs: 10_000,
    requestId: 'req-0001',
    deleted: [] as SnapshotMember[],
    ...over,
  });

  it('ran: the deploy\'s components re-read; only its own deletions are removed; the audit carries requestId', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    setOrg('ApexClass', 'InvoiceSelector', null);
    // A changed field the re-read parent no longer holds, and a deleted one.
    setOrg('CustomObject', 'Invoice__c', {
      files: { 'objects/Invoice__c.object': objectXml([['Amount__c', 'Amount']]) },
    });
    const out = await engine.rebaselineMembers(
      conn,
      [
        mem('ApexClass', 'InvoiceService'),
        mem('ApexClass', 'InvoiceSelector'),
        mem('CustomField', 'Invoice__c.Due__c'),
        mem('CustomField', 'Invoice__c.Status__c'),
      ],
      opts({ deleted: [mem('ApexClass', 'InvoiceSelector'), mem('CustomField', 'Invoice__c.Status__c')] }),
    );
    expect(out.status).toBe('ran');
    if (out.status !== 'ran') return;
    expect(out.summary.members).toEqual([
      { type: 'ApexClass', api_name: 'InvoiceService', unit: 'ApexClass:InvoiceService', outcome: 'refreshed' },
      { type: 'ApexClass', api_name: 'InvoiceSelector', unit: 'ApexClass:InvoiceSelector', outcome: 'removed' },
      {
        type: 'CustomField',
        api_name: 'Invoice__c.Due__c',
        unit: 'CustomObject:Invoice__c',
        outcome: 'skipped',
        reason: 'child_not_in_parent',
      },
      {
        type: 'CustomField',
        api_name: 'Invoice__c.Status__c',
        unit: 'CustomObject:Invoice__c',
        outcome: 'removed',
        detail: 'not in the parent document the org returned',
      },
    ]);
    expect(row('ApexClass', 'InvoiceSelector')).toBeNull();
    expect(readSnap('classes/InvoiceService.cls')).toBe(SERVICE_V2);
    expect(retrieveNamesChild()).toBe(false);
    expect(childListings()).toEqual([]);
    const [audit] = audits('snapshot.members_refreshed');
    expect(audit!.tool).toBe('execute_deploy');
    expect(Object.keys(audit!.detail!).sort()).toEqual(
      ['duration_ms', 'origin', 'refreshed', 'removed', 'requestId', 'skipped', 'units'].sort(),
    );
    expect(audit!.detail).toMatchObject({ origin: 'execute_deploy', requestId: 'req-0001', refreshed: 1, removed: 2, skipped: 1 });
  });

  it('a changed component the listing and the retrieve both miss is kept: not_confirmed, its file, rows and edges intact', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceSelector', { listed: false, returned: false });
    const before = rows();
    const edgesBefore = db.edgesFrom(connId, 'ApexClass', 'InvoiceSelector');
    const out = await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceSelector')], opts());
    expect(out.status).toBe('ran');
    if (out.status !== 'ran') return;
    expect(out.summary.members).toEqual([
      {
        type: 'ApexClass',
        api_name: 'InvoiceSelector',
        unit: 'ApexClass:InvoiceSelector',
        outcome: 'skipped',
        reason: 'not_confirmed',
      },
    ]);
    expect(rows()).toEqual(before);
    expect(readSnap('classes/InvoiceSelector.cls')).toBe(SELECTOR);
    expect(db.edgesFrom(connId, 'ApexClass', 'InvoiceSelector')).toEqual(edgesBefore);
  });

  it('a delete-only re-read gets a zip holding only package.xml and removes the deleted class', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceSelector', null);
    const out = await engine.rebaselineMembers(
      conn,
      [mem('ApexClass', 'InvoiceSelector')],
      opts({ deleted: [mem('ApexClass', 'InvoiceSelector')] }),
    );
    expect(out).toMatchObject({ status: 'ran' });
    if (out.status !== 'ran') return;
    expect(out.summary.counts).toEqual({ refreshed: 0, removed: 1, skipped: 0 });
    expect(readSnap('classes/InvoiceSelector.cls')).toBeNull();
    expect(readSnap('package.xml')).toBe(fs.readFileSync(path.join(current(), 'package.xml'), 'utf8'));
  });

  it('too_many_members: more than 100 distinct members, no org call', async () => {
    await wholeRefresh();
    const many = [
      ...Array.from({ length: 100 }, (_, i) => mem('ApexClass', `Cls${i}`)),
      mem('CustomField', 'Invoice__c.Amount__c'),
    ];
    expect(await engine.rebaselineMembers(conn, many, opts())).toEqual({
      status: 'unavailable',
      reason: 'too_many_members',
      detail: 'ApexClass, CustomObject',
    });
    expect(calls.soap).toBe(0);
  });

  it('refresh_running: a slow refresh ahead outlasts the queue wait, and the aborted run writes nothing when its turn comes', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 20;
    armGate();
    const whole = await engine.refresh(conn, ['ApexClass']);
    expect(whole.status).toBe('in_progress');
    const listsBefore = calls.list.length;
    const out = await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts({ timeoutMs: 150 }));
    expect(out).toEqual({ status: 'unavailable', reason: 'refresh_running' });
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const done = await engine.refresh(conn, ['ApexClass']);
    expect(done.status).toBe('complete');
    await settle();
    // The aborted run returned before taking the lease: no member listing, no member audit.
    expect(calls.list.length).toBe(listsBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('refresh_running (fake timers): a 60 s timeout still waits only 10 s in the queue, and the aborted run writes nothing', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 20;
    armGate();
    const whole = await engine.refresh(conn, ['ApexClass']);
    expect(whole.status).toBe('in_progress');
    // The whole refresh is held at the org's answer, so the member run can only queue behind it.
    await until(() => calls.status >= 1);
    const listsBefore = calls.list.length;
    const retrievesBefore = calls.retrieve.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let out: RebaselineOutcome | undefined;
    const pending = engine
      .rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts({ timeoutMs: 60_000 }))
      .then((o) => {
        out = o;
      });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(out).toBeUndefined();
    // REBASELINE_QUEUE_WAIT_MS, not the 60 s timeout, ends the wait for its turn.
    await vi.advanceTimersByTimeAsync(2);
    expect(out).toEqual({ status: 'unavailable', reason: 'refresh_running' });
    await pending;
    vi.useRealTimers();
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    const done = await engine.refresh(conn, ['ApexClass']);
    expect(done.status).toBe('complete');
    await settle();
    // The aborted run returned before taking the lease: no member listing or retrieve, no member audit.
    expect(calls.list.length).toBe(listsBefore);
    expect(calls.retrieve.length).toBe(retrievesBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('the retrieve gets only the budget the queue left: a run that waited 50 s of 60 s times out 10 s into its retrieve', async () => {
    await wholeRefresh();
    config.snapshot.toolWaitMs = 20;
    armGate();
    const whole = await engine.refresh(conn, ['ApexClass']);
    expect(whole.status).toBe('in_progress');
    // The whole refresh is held at the org's answer, so the member run queues behind it.
    await until(() => calls.status >= 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse(T0);
    vi.setSystemTime(t0);
    // The member run's retrieve never finishes; each status poll moves the clock 15 s on.
    slowRetrieve = (body) => body.includes('<met:members>InvoiceService</met:members>');
    onSlowPoll = () => vi.setSystemTime(Date.now() + 15_000);
    let out: RebaselineOutcome | undefined;
    const pending = engine
      .rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts({ timeoutMs: 60_000 }))
      .then((o) => {
        out = o;
      });
    // 50 s of the 60 s budget pass in the queue.
    vi.setSystemTime(t0 + 50_000);
    releaseGate();
    config.snapshot.toolWaitMs = 10_000;
    await pending;
    expect(out).toEqual({ status: 'unavailable', reason: 'timeout' });
    // One poll: its 15 s step passed the 10 s the queue left (a fresh 60 s would have taken five).
    expect(slowPolls).toBe(1);
    expect(calls.retrieve.filter((b) => b.includes('<met:members>InvoiceService</met:members>'))).toHaveLength(1);
    // Nothing written: the row is the whole refresh's, stamped when it finished.
    expect(row('ApexClass', 'InvoiceService')!.retrievedAt).toBe(new Date(t0 + 50_000).toISOString());
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('a deleted member that cannot be placed fails the run before the retrieve: failed, nothing written', async () => {
    await wholeRefresh();
    const before = rows();
    const filesBefore = tree(current());
    const bad = mem('CustomField', '.Due__c');
    const out = await engine.rebaselineMembers(
      conn,
      [mem('ApexClass', 'InvoiceService')],
      opts({ deleted: [bad] }),
    );
    expect(out).toEqual({ status: 'unavailable', reason: 'failed', detail: invalidMemberText(bad) });
    expect(calls.retrieve).toEqual([]);
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('timeout: the re-read did not finish in time, nothing is written even when the org answers later', async () => {
    await wholeRefresh();
    setOrg('ApexClass', 'InvoiceService', {
      files: { 'classes/InvoiceService.cls': SERVICE_V2, 'classes/InvoiceService.cls-meta.xml': CLS_META },
    });
    const before = rows();
    const filesBefore = tree(current());
    const lease = vi.spyOn(db, 'releaseAppLock');
    armGate();
    const out = await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts({ timeoutMs: 100 }));
    expect(out).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(calls.status).toBe(1);
    releaseGate();
    // The org answers; the aborted run stops at its last checkpoint and lets the lease go.
    await until(() => lease.mock.calls.length === 1);
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);
    expect(audits('snapshot.members_refreshed')).toEqual([]);
  });

  it('locked, no_snapshot and failed (before the commit point, nothing written)', async () => {
    expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
      status: 'unavailable',
      reason: 'no_snapshot',
    });
    await wholeRefresh();
    const before = rows();
    retrieveFailure = 'UNKNOWN_EXCEPTION: try later';
    expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
      status: 'unavailable',
      reason: 'failed',
      detail: 'retrieve failed: UNKNOWN_EXCEPTION: try later',
    });
    expect(rows()).toEqual(before);
    retrieveFailure = null;

    const raw = new Database(path.join(tmp, 'test.db'));
    try {
      raw.exec(
        `CREATE TABLE app_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL,
           pid INTEGER, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
      );
      raw
        .prepare(`INSERT INTO app_locks (name, holder, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(`snapshot:${connId}`, 'desktop:4242', 4242, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
      expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
        status: 'unavailable',
        reason: 'locked',
      });
    } finally {
      raw.close();
    }
  });

  it('failed_after_write: a failure after the commit point carries the partly-updated sentence', async () => {
    await wholeRefresh();
    vi.spyOn(db, 'replaceArtifactRows').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
      status: 'unavailable',
      reason: 'failed_after_write',
      detail: partialWriteText('SQLITE_BUSY: database is locked').slice(0, 200),
    });
  });

  it('metadata_read revoked, or the connection removed, at the commit point: nothing written', async () => {
    await wholeRefresh();
    const before = rows();
    const filesBefore = tree(current());
    beforeFinalStatus = () => db.updateGrants(connId, emptyGrantSet());
    expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
      status: 'unavailable',
      reason: 'no_metadata_read',
    });
    expect(rows()).toEqual(before);
    expect(tree(current())).toEqual(filesBefore);

    const grants = emptyGrantSet();
    grants.metadata_read = true;
    db.updateGrants(connId, grants);
    beforeFinalStatus = () => {
      db.deleteConnection(connId);
      store.removeConnection(connId);
    };
    expect(await engine.rebaselineMembers(conn, [mem('ApexClass', 'InvoiceService')], opts())).toEqual({
      status: 'unavailable',
      reason: 'connection_removed',
    });
    expect(fs.existsSync(path.join(tmp, 'snapshots', connId))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { MetadataSoapClient } from '../salesforce/metadataSoap.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { ConnectionRecord } from '../core/types.js';
import { emptyGrantSet } from '../core/grants.js';
import { SnapshotStore } from '../snapshot/store.js';
import {
  buildDeployZip,
  isValidComponentName,
  parseEnvelopeFor,
  type StampSource,
} from '../deploy/package.js';
import { resolveSourceFile } from '../deploy/sources.js';
import { stagingDir } from '../core/paths.js';
import {
  NOT_RESTORABLE_LIST_ONLY,
  NOT_RESTORABLE_NO_BYTES,
  NOT_RESTORABLE_PROFILE,
  NOT_RESTORABLE_UNPLACED,
  buildPreImageListQueries,
  buildPreImageRetrieveMembers,
  bundleEnvelopeJson,
  finalizeRevertPackage,
  hhmm,
  listDates,
  preImageKey,
  preImageListQueryFor,
  preImageRetrieveMemberFor,
  retrieveMessagesNote,
  retrieveNamedMembers,
  retrievePreImages,
  revertDirFor,
  revertReadmeText,
  summarizePreImage,
  targetMovedRefusalText,
  writeRevertPreImages,
  type DeployMovedMember,
  type PreImage,
  type PreImageMember,
  type PreImageResult,
  type RevertPlan,
} from '../deploy/preimage.js';
import type { StampQuery, StampQueryApi } from '../deploy/stampprobe.js';

/**
 * S45: the live pre-image module — one retrieve, resolved per member into
 * content, presence and stamps; `unavailable` reserved for the retrieve
 * path; the revert layout under staging/_reverts; and the verbatim refusal /
 * README texts.
 * S46 D1: one stamp source per member — the listing calls for the
 * listing-sourced types, an injected stamp query for CustomField,
 * ValidationRule, CustomLabel and ListView (never listed here) — and a
 * retrieve that names those four by their own type.
 */

const CONN: ConnectionRecord = {
  id: 'c1',
  workspaceId: 'default',
  alias: 'test',
  instanceUrl: 'https://inst.stub.salesforce.com',
  loginUrl: 'https://login.salesforce.com',
  orgId: '00D1',
  orgName: 'Test',
  orgType: 'developer',
  isSandbox: false,
  username: null,
  userId: null,
  grants: emptyGrantSet(),
  createdAt: '',
  updatedAt: '',
  lastUsedAt: null,
};

function fakeTokenMgr(tokens: string[]): AccessTokenManager {
  let i = 0;
  return {
    getAccessToken: async () => tokens[Math.min(i, tokens.length - 1)]!,
    invalidate: () => {
      i += 1;
    },
  } as unknown as AccessTokenManager;
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

const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

// ── fixture org ──────────────────────────────────────────────────────────

const FOO_CLS = 'public class Foo {\n    public static Integer one() { return 1; }\n}\n';
const FOO_META =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<ApexClass ${MD}>\n    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
const INVOICE_OBJECT =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<CustomObject ${MD}>\n` +
  '    <fields>\n        <fullName>Amount__c</fullName>\n        <type>Currency</type>\n    </fields>\n' +
  '    <fields>\n        <fullName>Status__c</fullName>\n        <type>Picklist</type>\n    </fields>\n' +
  '    <label>Invoice</label>\n' +
  '    <validationRules>\n        <fullName>Positive_Amount</fullName>\n        <active>true</active>\n' +
  '    </validationRules>\n</CustomObject>\n';
const LWC_FILES: Record<string, string> = {
  'myCmp.js': "import { LightningElement } from 'lwc';\nexport default class MyCmp extends LightningElement {}\n",
  'myCmp.js-meta.xml':
    `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle ${MD}>\n` +
    '    <apiVersion>66.0</apiVersion>\n    <isExposed>false</isExposed>\n</LightningComponentBundle>\n',
  'myCmp.html': '<template><p>hi</p></template>\n',
  'templates/alt.html': '<template><p>alt</p></template>\n',
};
const ADMIN_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile ${MD}>\n    <custom>false</custom>\n</Profile>\n`;
const MYBOT = `<?xml version="1.0" encoding="UTF-8"?>\n<Bot ${MD}>\n    <botVersions>\n        <fullName>v1</fullName>\n        <botDialogs/>\n    </botVersions>\n    <label>MyBot</label>\n</Bot>\n`;
const PIPELINE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>\n<Report ${MD}>\n    <name>Pipeline</name>\n</Report>\n`;
const OPS_FOLDER = `<?xml version="1.0" encoding="UTF-8"?>\n<ReportFolder ${MD}>\n    <name>Ops</name>\n</ReportFolder>\n`;

const AMOUNT_BLOCK =
  '    <fields>\n        <fullName>Amount__c</fullName>\n        <type>Currency</type>\n    </fields>\n';
const STATUS_BLOCK =
  '    <fields>\n        <fullName>Status__c</fullName>\n        <type>Picklist</type>\n    </fields>\n';
function objectDocument(blocks: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${MD}>\n${blocks}</CustomObject>\n`;
}
/**
 * A partial container: the parent's file holding ONLY the Amount__c block —
 * the shape a retrieve naming `CustomField: Invoice__c.Amount__c` was
 * measured to return on a dev org.
 */
const PARTIAL_INVOICE_OBJECT = objectDocument(AMOUNT_BLOCK);
/** A partial container WITHOUT that block: the retrieve named two fields and returned the other. */
const PARTIAL_INVOICE_OTHER_FIELD = objectDocument(STATUS_BLOCK);
/** A standard object's document holding a standard field — read through the container. */
const ACCOUNT_OBJECT = objectDocument(
  '    <fields>\n        <fullName>Industry</fullName>\n        <type>Picklist</type>\n    </fields>\n',
);

/** The fixture org's files, by their path inside the retrieve zip's unpackaged/ root. */
function fixtureEntries(): Record<string, string> {
  const entries: Record<string, string> = {
    'classes/Foo.cls': FOO_CLS,
    'classes/Foo.cls-meta.xml': FOO_META,
    'objects/Invoice__c.object': INVOICE_OBJECT,
    'profiles/Admin.profile': ADMIN_PROFILE,
    'bots/MyBot.bot': MYBOT,
    'reports/Ops/Pipeline.report': PIPELINE_REPORT,
    'reports/Ops-meta.xml': OPS_FOLDER,
  };
  for (const [rel, body] of Object.entries(LWC_FILES)) entries[`lwc/myCmp/${rel}`] = body;
  return entries;
}

function zipOf(entries: Record<string, string>): string {
  const zipped: Record<string, Uint8Array> = { 'unpackaged/package.xml': strToU8('<Package/>') };
  for (const [rel, body] of Object.entries(entries)) zipped[`unpackaged/${rel}`] = strToU8(body);
  return Buffer.from(zipSync(zipped)).toString('base64');
}

function fixtureZipB64(): string {
  return zipOf(fixtureEntries());
}

/**
 * The fixture zip with objects/Invoice__c.object as a partial container — by
 * default the one holding only the Amount__c block; `null` leaves the file
 * out altogether (nothing the retrieve named on that object exists).
 */
function partialZipB64(objectBody: string | null = PARTIAL_INVOICE_OBJECT): string {
  const entries = fixtureEntries();
  if (objectBody === null) delete entries['objects/Invoice__c.object'];
  else entries['objects/Invoice__c.object'] = objectBody;
  return zipOf(entries);
}

interface ListRow {
  fullName: string;
  date: string;
  by: string;
}

// The stub org WOULD answer a listing of CustomField or ValidationRule — with
// stamps that differ from the stamp query's (PROBE_ROWS below). S46 D1 never
// issues that listing, so a date from these two rows in an image means the
// listing was consulted for a probed type.
const DEFAULT_LIST_ROWS: Record<string, ListRow[]> = {
  ApexClass: [{ fullName: 'Foo', date: '2026-11-01T10:00:00.000Z', by: 'Ryley' }],
  CustomField: [{ fullName: 'Invoice__c.Amount__c', date: '2026-11-02T10:00:00.000Z', by: 'Ryley' }],
  ValidationRule: [
    { fullName: 'Invoice__c.Positive_Amount', date: '2026-11-02T11:00:00.000Z', by: 'Ryley' },
  ],
  RecordType: [{ fullName: 'Invoice__c.Biz', date: '2026-11-02T12:00:00.000Z', by: 'Dana Admin' }],
  LightningComponentBundle: [{ fullName: 'myCmp', date: '2026-11-03T10:00:00.000Z', by: 'Ryley' }],
  Profile: [{ fullName: 'Admin', date: '2026-11-04T10:00:00.000Z', by: 'Ryley' }],
  Bot: [{ fullName: 'MyBot', date: '2026-11-04T12:00:00.000Z', by: 'Ryley' }],
  Report: [{ fullName: 'Ops/Pipeline', date: '2026-11-05T10:00:00.000Z', by: 'Ryley' }],
  ReportFolder: [{ fullName: 'Ops', date: '2026-11-05T09:00:00.000Z', by: 'Ryley' }],
  PresenceUserConfig: [{ fullName: 'Voice_Agents', date: '2026-11-06T10:00:00.000Z', by: 'Ryley' }],
};

function listRowXml(type: string, r: ListRow): string {
  return (
    `<result><fullName>${r.fullName}</fullName><type>${type}</type><fileName>x</fileName>` +
    `<id>1</id><lastModifiedDate>${r.date}</lastModifiedDate>` +
    `<lastModifiedByName>${r.by}</lastModifiedByName></result>`
  );
}

// ── the stamp-query stub ─────────────────────────────────────────────────

type ProbeRow = Record<string, unknown>;

/** One returned record, shaped as the org sends it (the name column varies by sObject). */
function probeRow(
  nameColumn: string,
  name: string,
  date: unknown,
  ns: string | null = null,
  by: string | null = 'Dana Admin',
): ProbeRow {
  return {
    attributes: { type: 'stub' },
    Id: '000000000000001',
    [nameColumn]: name,
    NamespacePrefix: ns,
    LastModifiedDate: date,
    LastModifiedBy: by === null ? null : { Name: by },
  };
}

/** The Amount__c stamp as Tooling writes it (`+0000`), and as a pre-image stores it (`Z`). */
const AMOUNT_STAMP_RAW = '2026-11-17T17:30:19.000+0000';
const AMOUNT_STAMP = '2026-11-17T17:30:19.000Z';
const RULE_STAMP = '2026-11-17T17:31:00.000Z';
const LABEL_STAMP = '2026-11-17T17:32:00.000Z';
const VIEW_STAMP = '2026-11-17T17:33:00.000Z';

/** The stub org's stamp-query rows, by the sObject a query's FROM clause names. */
const PROBE_ROWS: Record<string, ProbeRow[]> = {
  CustomField: [probeRow('DeveloperName', 'Amount', AMOUNT_STAMP_RAW)],
  ValidationRule: [probeRow('ValidationName', 'Positive_Amount', '2026-11-17T17:31:00.000+0000')],
  ExternalString: [probeRow('Name', 'Greeting', '2026-11-17T17:32:00.000+0000')],
  ListView: [probeRow('DeveloperName', 'Open_Invoices', '2026-11-17T17:33:00.000+0000')],
};

const Q_AMOUNT =
  'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
  "FROM CustomField WHERE (DeveloperName = 'Amount' AND EntityDefinition.QualifiedApiName = 'Invoice__c')";

let probeRows: Record<string, ProbeRow[]>;
/** SOQL substrings: a matching query rejects / never answers (and ignores its signal). */
let probeFailOn: string | null;
let probeHangOn: string | null;
let probeIssued: Array<{ api: StampQueryApi; soql: string }>;

/**
 * The injected executor: answers a stamp query with the rows registered for
 * the sObject its FROM clause names, and records every call.
 */
const probeStub: StampQuery = async (api, soql) => {
  probeIssued.push({ api, soql });
  if (probeFailOn !== null && soql.includes(probeFailOn)) {
    throw new Error('Salesforce API error 500 on /services/data/v66.0/tooling/query: stub fault');
  }
  if (probeHangOn !== null && soql.includes(probeHangOn)) return new Promise<ProbeRow[]>(() => {});
  const sobject = / FROM (\w+) WHERE /.exec(soql)?.[1] ?? '';
  return probeRows[sobject] ?? [];
};

let tmp: string;
let store: SnapshotStore;
let soapBodies: string[];
let statusCalls: number;
let retrieveMode: 'ok' | 'never' | 'fault' | 'failed' | 'nozip';
/** In 'ok' mode: how many checkRetrieveStatus calls answer InProgress before the finished one. */
let pendingPolls: number;
/** `problem` texts the finished retrieve status carries as <messages> elements. */
let statusMessages: string[];
let listMode: 'ok' | 'fault';
let invalidTypes: Set<string>;
let zipB64: string;

function messagesXml(): string {
  return statusMessages
    .map(
      (problem) =>
        `<messages><fileName>unpackaged/package.xml</fileName><problem>${problem}</problem></messages>`,
    )
    .join('');
}

/**
 * The soap.test.ts stubWithInvalidType idiom, widened to the three calls
 * this module makes: retrieve → one async id; checkRetrieveStatus → the
 * fixture zip (after pendingPolls unfinished answers; or never done / failed
 * / finished with no zip, per retrieveMode), with statusMessages as its
 * <messages>; listMetadata → canned rows per queried type, folder-aware, an
 * sf:INVALID_TYPE Fault for any type in invalidTypes, a transport-shaped
 * fault when listMode is 'fault'.
 */
function stubSoap(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    soapBodies.push(body);
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
      if (retrieveMode === 'never' || (retrieveMode === 'ok' && statusCalls <= pendingPolls)) {
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>false</done><id>09S1</id>` +
              `<status>InProgress</status><success>false</success></result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (retrieveMode === 'failed') {
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
              `<status>Failed</status><success>false</success><errorMessage>boom</errorMessage>` +
              `</result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (retrieveMode === 'nozip') {
        // A retrieve the org reports as a success, with no zipFile element.
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
              `${messagesXml()}<status>Succeeded</status><success>true</success>` +
              `</result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      return new Response(
        soapEnvelope(
          `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
            `${messagesXml()}<status>Succeeded</status><success>true</success>` +
            `<fileProperties><fullName>Foo</fullName><type>ApexClass</type><fileName>classes/Foo.cls</fileName>` +
            `<id>01p1</id><lastModifiedDate>2026-11-01T10:00:00.000Z</lastModifiedDate>` +
            `<lastModifiedByName>Ryley</lastModifiedByName></fileProperties>` +
            `<zipFile>${zipB64}</zipFile></result></checkRetrieveStatusResponse>`,
        ),
      );
    }
    if (body.includes('<met:listMetadata>')) {
      if (listMode === 'fault') return fault('INSUFFICIENT_ACCESS', 'no metadata api for you');
      const queries = [
        ...body.matchAll(
          /<met:queries>(?:<met:folder>([^<]*)<\/met:folder>)?<met:type>([^<]+)<\/met:type><\/met:queries>/g,
        ),
      ].map((m) => ({ folder: m[1], type: m[2]! }));
      for (const q of queries) {
        if (invalidTypes.has(q.type)) {
          return fault('INVALID_TYPE', `INVALID_TYPE: Cannot use: ${q.type} in this version`);
        }
      }
      const rows = queries.flatMap((q) =>
        (DEFAULT_LIST_ROWS[q.type] ?? [])
          .filter((r) => q.folder === undefined || r.fullName.startsWith(`${q.folder}/`))
          .map((r) => listRowXml(q.type, r)),
      );
      return new Response(
        soapEnvelope(`<listMetadataResponse ${MD}>${rows.join('')}</listMetadataResponse>`),
      );
    }
    return new Response('unexpected SOAP body', { status: 500 });
  });
}

function client(): MetadataSoapClient {
  return new MetadataSoapClient(fakeTokenMgr(['AT']), CONN, 'v66.0');
}

const STARTED_AT = '2026-11-14T15:00:00.000Z';

function opts(over: Partial<Parameters<typeof retrievePreImages>[2]> = {}) {
  return {
    startedAt: STARTED_AT,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    extractZip: (zip: Buffer) => store.extractRetrieveZip(zip),
    queryStamps: probeStub,
    ...over,
  };
}

const MEMBERS: PreImageMember[] = [
  { type: 'ApexClass', api_name: 'Foo' },
  { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
  { type: 'LightningComponentBundle', api_name: 'myCmp' },
  { type: 'ApexClass', api_name: 'Missing' },
  { type: 'Profile', api_name: 'Admin' },
];

function image(result: PreImageResult, type: string, apiName: string): PreImage {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.reason}`);
  const img = result.images.get(preImageKey(type, apiName));
  if (!img) throw new Error(`no image for ${type}:${apiName}`);
  return img;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function listBodies(): string[] {
  return soapBodies.filter((b) => b.includes('<met:listMetadata>'));
}

function retrieveBody(): string {
  return soapBodies.find((b) => b.includes('<met:retrieve>')) ?? '';
}

/** `<met:members>…</met:members><met:name>Type</met:name>` as the retrieve request writes one type. */
function manifestEntry(type: string, ...members: string[]): string {
  return `${members.map((m) => `<met:members>${m}</met:members>`).join('')}<met:name>${type}</met:name>`;
}

const AMOUNT: PreImageMember = { type: 'CustomField', api_name: 'Invoice__c.Amount__c' };
const AMOUNT_KEY = 'CustomField:Invoice__c.Amount__c';
const INDUSTRY: PreImageMember = { type: 'CustomField', api_name: 'Account.Industry' };

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-preimage-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  soapBodies = [];
  statusCalls = 0;
  retrieveMode = 'ok';
  pendingPolls = 0;
  statusMessages = [];
  listMode = 'ok';
  invalidTypes = new Set();
  zipB64 = fixtureZipB64();
  probeRows = { ...PROBE_ROWS };
  probeFailOn = null;
  probeHangOn = null;
  probeIssued = [];
  stubSoap();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ok path ──────────────────────────────────────────────────────────────

describe('retrievePreImages — ok path', () => {
  it('resolves a document, a child, a bundle, an absent member and a Profile from one retrieve + listing + stamp query', async () => {
    // The retrieve names the field by its own type, so the object file comes
    // back as a partial container.
    zipB64 = partialZipB64();
    const result = await retrievePreImages(client(), MEMBERS, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.started_at).toBe(STARTED_AT);
    expect(Date.parse(result.at)).toBeGreaterThanOrEqual(Date.parse(STARTED_AT));
    expect(result.dates_unavailable_types).toEqual([]);
    expect(result.dates_unavailable).toBeUndefined();
    expect(result.probe_failures).toEqual({});
    expect(result.probe_unmatched).toEqual([]);
    expect(result.retrieve_messages).toEqual([]);
    expect(result.images.size).toBe(5);

    // Document: content_file-ready body, the -meta.xml sidecar kept in files.
    const foo = image(result, 'ApexClass', 'Foo');
    expect(foo).toMatchObject({
      present: true,
      source: 'retrieve',
      stamp_source: 'listMetadata',
      content: FOO_CLS,
      sha256: sha256(FOO_CLS),
      last_modified_date: '2026-11-01T10:00:00.000Z',
      last_modified_by: 'Ryley',
      comparable: true,
      restorable: true,
    });
    expect(foo.files?.get('classes/Foo.cls-meta.xml')).toBe(FOO_META);
    expect(summarizePreImage(foo)).toEqual({
      present: true,
      source: 'retrieve',
      stamp_source: 'listMetadata',
      sha256: sha256(FOO_CLS),
      last_modified_date: '2026-11-01T10:00:00.000Z',
      last_modified_by: 'Ryley',
      comparable: true,
      restorable: true,
    });

    // Child: the block extracted from the (partial) parent document, dated by
    // the stamp query that names it — the stub's stamp, stored in the `Z`
    // form, never the listing row's.
    const field = image(result, 'CustomField', 'Invoice__c.Amount__c');
    expect(field.present).toBe(true);
    expect(field.content).toMatch(/^<fields>[\s\S]*<fullName>Amount__c<\/fullName>[\s\S]*<\/fields>$/);
    expect(field.content).not.toContain('Status__c');
    expect(field.stamp_source).toBe('tooling:CustomField');
    expect(field.last_modified_date).toBe(AMOUNT_STAMP);
    expect(field.last_modified_by).toBe('Dana Admin');
    expect(field.comparable).toBe(true);
    expect(field.restorable).toBe(true);
    expect(summarizePreImage(field)).toEqual({
      present: true,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      sha256: field.sha256,
      last_modified_date: AMOUNT_STAMP,
      last_modified_by: 'Dana Admin',
      comparable: true,
      restorable: true,
    });
    expect(probeIssued).toEqual([{ api: 'tooling', soql: Q_AMOUNT }]);

    // Bundle: a {rel: body} map (the comparison unit), never an envelope —
    // the envelope is built only for the revert content_file, and
    // parseBundleEnvelope accepts it.
    const lwc = image(result, 'LightningComponentBundle', 'myCmp');
    expect(lwc.present).toBe(true);
    expect(lwc.content).toBeUndefined();
    expect([...lwc.files!.keys()].sort()).toEqual(Object.keys(LWC_FILES).sort());
    expect(lwc.files!.get('templates/alt.html')).toBe(LWC_FILES['templates/alt.html']);
    const envelope = bundleEnvelopeJson(lwc.files!);
    expect(parseEnvelopeFor('LightningComponentBundle', 'myCmp', envelope).files).toEqual(LWC_FILES);
    expect(lwc.sha256).toBe(sha256(envelope));
    expect(lwc.last_modified_date).toBe('2026-11-03T10:00:00.000Z');

    // present:false — the retrieve returned nothing and the listing names no such member.
    const missing = image(result, 'ApexClass', 'Missing');
    expect(missing).toEqual({
      present: false,
      source: 'retrieve',
      stamp_source: 'listMetadata',
      last_modified_date: null,
      last_modified_by: null,
      comparable: false,
      restorable: false,
    });

    // Profile: present and dated, bytes captured, but neither comparable nor restorable.
    const profile = image(result, 'Profile', 'Admin');
    expect(profile.present).toBe(true);
    expect(profile.content).toBe(ADMIN_PROFILE);
    expect(profile.last_modified_date).toBe('2026-11-04T10:00:00.000Z');
    expect(profile.comparable).toBe(false);
    expect(profile.restorable).toBe(false);

    // The retrieve manifest: the field by its OWN type — never its container
    // — and one member per name.
    const body = retrieveBody();
    expect(body).toMatch(
      /<met:types><met:members>Foo<\/met:members><met:members>Missing<\/met:members><met:name>ApexClass<\/met:name><\/met:types>/,
    );
    expect(body).toContain(manifestEntry('CustomField', 'Invoice__c.Amount__c'));
    expect(body).not.toContain('<met:name>CustomObject</met:name>');
    expect(body).toContain('<met:members>myCmp</met:members><met:name>LightningComponentBundle</met:name>');
    expect(body).toContain('<met:members>Admin</met:members><met:name>Profile</met:name>');
    // The listing is the date source for the listing-sourced types only: it
    // never names the field's type (nor its container).
    const listed = listBodies().join('\n');
    expect(listed).not.toContain('<met:type>CustomField</met:type>');
    expect(listed).not.toContain('<met:type>CustomObject</met:type>');
    expect(listed).toContain('<met:type>ApexClass</met:type>');
    expect(listed).toContain('<met:type>LightningComponentBundle</met:type>');
  });

  it('an empty member set makes no SOAP call and no stamp query, and is ok with no images', async () => {
    const result = await retrievePreImages(client(), [], opts());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.images.size).toBe(0);
      expect(result.probe_failures).toEqual({});
      expect(result.probe_unmatched).toEqual([]);
      expect(result.retrieve_messages).toEqual([]);
    }
    expect(soapBodies).toEqual([]);
    expect(probeIssued).toEqual([]);
  });

  it('the four probed types: each named by its own type in the retrieve, stamped by its own query, never listed', async () => {
    zipB64 = zipOf({
      'objects/Invoice__c.object': objectDocument(
        '    <listViews>\n        <fullName>Open_Invoices</fullName>\n        <label>Open</label>\n    </listViews>\n' +
          '    <validationRules>\n        <fullName>Positive_Amount</fullName>\n        <active>true</active>\n    </validationRules>\n',
      ),
      'labels/CustomLabels.labels':
        `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels ${MD}>\n` +
        '    <labels>\n        <fullName>Greeting</fullName>\n        <value>Hello</value>\n    </labels>\n' +
        '</CustomLabels>\n',
    });
    const result = await retrievePreImages(
      client(),
      [
        { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' },
        { type: 'CustomLabel', api_name: 'Greeting' },
        { type: 'ListView', api_name: 'Invoice__c.Open_Invoices' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const rule = image(result, 'ValidationRule', 'Invoice__c.Positive_Amount');
    expect(rule).toMatchObject({
      present: true,
      source: 'retrieve',
      stamp_source: 'tooling:ValidationRule',
      last_modified_date: RULE_STAMP,
      last_modified_by: 'Dana Admin',
      comparable: true,
      restorable: true,
    });
    expect(rule.content).toMatch(/^<validationRules>[\s\S]*<fullName>Positive_Amount<\/fullName>/);
    const label = image(result, 'CustomLabel', 'Greeting');
    expect(label).toMatchObject({
      present: true,
      stamp_source: 'tooling:ExternalString',
      last_modified_date: LABEL_STAMP,
      comparable: true,
    });
    expect(label.content).toMatch(/^<labels>[\s\S]*<fullName>Greeting<\/fullName>/);
    const view = image(result, 'ListView', 'Invoice__c.Open_Invoices');
    expect(view).toMatchObject({
      present: true,
      stamp_source: 'data:ListView',
      last_modified_date: VIEW_STAMP,
      comparable: true,
    });
    expect(view.content).toMatch(/^<listViews>[\s\S]*<fullName>Open_Invoices<\/fullName>/);

    const body = retrieveBody();
    expect(body).toContain(manifestEntry('ValidationRule', 'Invoice__c.Positive_Amount'));
    expect(body).toContain(manifestEntry('CustomLabel', 'Greeting'));
    expect(body).toContain(manifestEntry('ListView', 'Invoice__c.Open_Invoices'));
    expect(body).not.toContain('<met:name>CustomObject</met:name>');
    expect(body).not.toContain('<met:name>CustomLabels</met:name>');
    // Nothing here is listing-sourced: no listMetadata call at all.
    expect(listBodies()).toEqual([]);
    // One query per type; ListView through the Data API, the others through Tooling.
    expect(probeIssued.map((q) => q.api).sort()).toEqual(['data', 'tooling', 'tooling']);
    expect(probeIssued.find((q) => q.api === 'data')?.soql).toBe(
      'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ' +
        "FROM ListView WHERE (SobjectType = 'Invoice__c' AND DeveloperName = 'Open_Invoices')",
    );
  });

  it('a RecordType stays listing-sourced and rides its container; a field beside it rides that container too', async () => {
    const result = await retrievePreImages(
      client(),
      [{ type: 'RecordType', api_name: 'Invoice__c.Biz' }, AMOUNT],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The retrieve names the container once, and never the field beside it.
    const body = retrieveBody();
    expect(body).toContain(manifestEntry('CustomObject', 'Invoice__c'));
    expect(body).not.toContain('<met:name>CustomField</met:name>');
    expect(body).not.toContain('<met:name>RecordType</met:name>');
    // RecordType: listed by its own type, as before. (The fixture document
    // holds no recordTypes block; the listing row is its presence.)
    expect(listBodies().join('\n')).toContain('<met:type>RecordType</met:type>');
    expect(listBodies().join('\n')).not.toContain('<met:type>CustomField</met:type>');
    expect(image(result, 'RecordType', 'Invoice__c.Biz')).toMatchObject({
      present: true,
      stamp_source: 'listMetadata',
      last_modified_date: '2026-11-02T12:00:00.000Z',
      restorable: false,
    });
    // The field: its block from the WHOLE document, its stamp from the query.
    const field = image(result, 'CustomField', 'Invoice__c.Amount__c');
    expect(field).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: AMOUNT_STAMP,
      comparable: true,
    });
    expect(field.content).not.toContain('Status__c');
    expect(probeIssued).toEqual([{ api: 'tooling', soql: Q_AMOUNT }]);
  });

  it('a field whose container is in the package rides the container: the retrieve never names both', async () => {
    const result = await retrievePreImages(
      client(),
      [AMOUNT, { type: 'CustomObject', api_name: 'Invoice__c' }],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const body = retrieveBody();
    expect(body).toContain(manifestEntry('CustomObject', 'Invoice__c'));
    expect(body).not.toContain('<met:name>CustomField</met:name>');
    expect(image(result, 'CustomObject', 'Invoice__c')).toMatchObject({
      present: true,
      stamp_source: 'listMetadata',
      content: INVOICE_OBJECT,
    });
    expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: AMOUNT_STAMP,
    });
  });

  it('a standard field keeps the parent-container retrieve and gets no stamp query and no listing', async () => {
    zipB64 = zipOf({ 'objects/Account.object': ACCOUNT_OBJECT });
    const result = await retrievePreImages(client(), [INDUSTRY], opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(retrieveBody()).toContain(manifestEntry('CustomObject', 'Account'));
    expect(retrieveBody()).not.toContain('<met:name>CustomField</met:name>');
    expect(probeIssued).toEqual([]);
    expect(listBodies()).toEqual([]);
    const industry = image(result, 'CustomField', 'Account.Industry');
    expect(industry).toMatchObject({
      present: true,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
      last_modified_by: null,
      comparable: true,
      restorable: true,
    });
    expect(industry.content).toMatch(/^<fields>[\s\S]*<fullName>Industry<\/fullName>/);
    // No query ran, so the type did not fail: the member is simply undated.
    expect(result.dates_unavailable_types).toEqual([]);
    expect(result.probe_failures).toEqual({});
  });
});

// ── unavailable is reserved for the retrieve path ────────────────────────

describe('retrievePreImages — unavailable only when the org was not re-read', () => {
  it('a retrieve that never finishes within timeoutMs → unavailable/timeout, never a throw', async () => {
    retrieveMode = 'never';
    const result = await retrievePreImages(client(), MEMBERS, opts({ timeoutMs: 30, pollIntervalMs: 5 }));
    expect(result).toMatchObject({ status: 'unavailable', started_at: STARTED_AT, reason: 'timeout' });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it('a retrieve fault, or an org-reported failed retrieve → unavailable/retrieve_failed:<msg>', async () => {
    retrieveMode = 'fault';
    const faulted = await retrievePreImages(client(), MEMBERS, opts());
    expect(faulted.status).toBe('unavailable');
    if (faulted.status === 'unavailable') {
      expect(faulted.reason).toMatch(/^retrieve_failed:.*retrieve blew up/);
    }

    retrieveMode = 'failed';
    const failed = await retrievePreImages(client(), MEMBERS, opts());
    expect(failed).toMatchObject({ status: 'unavailable', reason: 'retrieve_failed:boom' });
    // No messages came with either failure: the key is absent, not an empty list.
    expect(faulted).not.toHaveProperty('retrieve_messages');
    expect(failed).not.toHaveProperty('retrieve_messages');
  });

  it('a retrieve that finishes as a success with NO zip stays unavailable — never "everything absent" — and carries what the org said', async () => {
    retrieveMode = 'nozip';
    statusMessages = ["Entity of type 'CustomField' named 'Invoice__c.Amount__c' cannot be found"];
    const result = await retrievePreImages(client(), [AMOUNT], opts());
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'retrieve_failed:Succeeded',
      retrieve_messages: ["Entity of type 'CustomField' named 'Invoice__c.Amount__c' cannot be found"],
    });
    expect(result).not.toHaveProperty('images');
  });

  it('a type the listing cannot enumerate (INVALID_TYPE) keeps its members’ content with null dates and lands in dates_unavailable_types', async () => {
    // The soap.test.ts stubWithInvalidType idiom: BotVersion faults, the retrieve zip is good.
    invalidTypes = new Set(['BotVersion']);
    const result = await retrievePreImages(
      client(),
      [
        { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
        { type: 'BotVersion', api_name: 'MyBot.v1' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const version = image(result, 'BotVersion', 'MyBot.v1');
    expect(version.present).toBe(true);
    expect(version.stamp_source).toBe('listMetadata');
    expect(version.content).toMatch(/^<botVersions>[\s\S]*<fullName>v1<\/fullName>/);
    expect(version.last_modified_date).toBeNull();
    expect(version.last_modified_by).toBeNull();
    expect(version.comparable).toBe(true);
    // The field's stamp is its query's: an unlistable type beside it changes nothing.
    const field = image(result, 'CustomField', 'Invoice__c.Amount__c');
    expect(field.last_modified_date).toBe(AMOUNT_STAMP);
    expect(result.dates_unavailable_types).toEqual(['BotVersion']);
    expect(result.dates_unavailable).toBeUndefined();
    expect(result.probe_failures).toEqual({});
    // BotVersion keeps the container retrieve.
    expect(retrieveBody()).toContain(manifestEntry('Bot', 'MyBot'));
  });

  it('a listing that throws (non-INVALID_TYPE) never discards the retrieve: ok, every LISTING-sourced date null, dates_unavailable set — and the stamp query’s date stands', async () => {
    listMode = 'fault';
    const result = await retrievePreImages(client(), MEMBERS, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.dates_unavailable).toMatch(/no metadata api for you/);
    expect(result.dates_unavailable_types).toEqual([]);
    expect(result.probe_failures).toEqual({});
    let listingSourced = 0;
    for (const img of result.images.values()) {
      if (img.stamp_source !== 'listMetadata') continue;
      listingSourced += 1;
      expect(img.last_modified_date).toBeNull();
      expect(img.last_modified_by).toBeNull();
    }
    expect(listingSourced).toBe(4);
    expect(image(result, 'ApexClass', 'Foo')).toMatchObject({ present: true, content: FOO_CLS });
    expect(image(result, 'ApexClass', 'Missing').present).toBe(false);
    // A listing that threw says nothing about a stamp query.
    expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      last_modified_date: AMOUNT_STAMP,
      last_modified_by: 'Dana Admin',
    });
  });
});

// ── S46 D1: the stamp query is the date source, the retrieve the presence ─

describe('S46 D1: probed members — presence from the container, dates from the stamp query', () => {
  /** A stub row carrying the field's developer name under a namespace the package did not name. */
  const NS_AMOUNT_ROW = probeRow('DeveloperName', 'Amount', AMOUNT_STAMP_RAW, 'ns');

  async function resolveAmount(): Promise<{
    result: Extract<PreImageResult, { status: 'ok' }>;
    amount: PreImage;
  }> {
    const result = await retrievePreImages(client(), [AMOUNT], opts());
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.reason}`);
    return { result, amount: image(result, 'CustomField', 'Invoice__c.Amount__c') };
  }

  const noBytes = { comparable: false, restorable: false };
  const noDates = { last_modified_date: null, last_modified_by: null };

  // Row 1 of the D1.2 table.
  it('block + row → present, the row’s dates, comparable and restorable', async () => {
    zipB64 = partialZipB64();
    const { result, amount } = await resolveAmount();
    expect(amount).toEqual({
      present: true,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      content: amount.content,
      sha256: sha256(amount.content!),
      last_modified_date: AMOUNT_STAMP,
      last_modified_by: 'Dana Admin',
      comparable: true,
      restorable: true,
    });
    expect(amount.content).toMatch(/^<fields>[\s\S]*<fullName>Amount__c<\/fullName>[\s\S]*<\/fields>$/);
    expect(result.dates_unavailable_types).toEqual([]);
  });

  // Row 2: a returned block is never turned into "absent" by what the query says.
  it('block + no row → present with null dates; the type did not fail', async () => {
    zipB64 = partialZipB64();
    probeRows.CustomField = [];
    const { result, amount } = await resolveAmount();
    expect(amount).toMatchObject({ present: true, ...noDates, comparable: true, restorable: true });
    expect(result.dates_unavailable_types).toEqual([]);
    expect(result.probe_failures).toEqual({});
    expect(result.probe_unmatched).toEqual([]);
  });

  it('block + only a same-name row under another namespace → present, null dates, key in probe_unmatched, no stamp taken from that row', async () => {
    zipB64 = partialZipB64();
    probeRows.CustomField = [NS_AMOUNT_ROW];
    const { result, amount } = await resolveAmount();
    expect(amount).toMatchObject({ present: true, ...noDates, comparable: true, restorable: true });
    expect(result.probe_unmatched).toEqual([AMOUNT_KEY]);
    expect(result.dates_unavailable_types).toEqual([]);
  });

  it('block + two rows for the member → present, null dates', async () => {
    zipB64 = partialZipB64();
    probeRows.CustomField = [
      probeRow('DeveloperName', 'Amount', AMOUNT_STAMP_RAW),
      probeRow('DeveloperName', 'Amount', '2026-11-17T18:00:00.000+0000'),
    ];
    const { result, amount } = await resolveAmount();
    expect(amount).toMatchObject({ present: true, ...noDates, comparable: true });
    expect(result.probe_unmatched).toEqual([]);
  });

  it('block + a row whose date cannot be parsed → present, null date', async () => {
    zipB64 = partialZipB64();
    probeRows.CustomField = [probeRow('DeveloperName', 'Amount', 'yesterday')];
    const { amount } = await resolveAmount();
    expect(amount).toMatchObject({ present: true, last_modified_date: null, comparable: true });
  });

  it('block + the type’s query failed → present, null dates, the type in dates_unavailable_types and probe_failures — and NO listing of the type (no fallback)', async () => {
    zipB64 = partialZipB64();
    probeFailOn = 'FROM CustomField';
    const result = await retrievePreImages(
      client(),
      [AMOUNT, { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' }, { type: 'ApexClass', api_name: 'Foo' }],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      ...noDates,
      comparable: true,
      restorable: true,
    });
    expect(result.dates_unavailable_types).toEqual(['CustomField']);
    expect(result.probe_failures).toEqual({
      CustomField: 'Salesforce API error 500 on /services/data/v66.0/tooling/query: stub fault',
    });
    expect(result.dates_unavailable).toBeUndefined();
    // The failure is per type: the other probed type and the listing are untouched.
    expect(image(result, 'ValidationRule', 'Invoice__c.Positive_Amount').last_modified_date).toBe(RULE_STAMP);
    expect(image(result, 'ApexClass', 'Foo').last_modified_date).toBe('2026-11-01T10:00:00.000Z');
    // A failed stamp query is never replaced by the org-wide listing.
    const listed = listBodies().join('\n');
    expect(listed).toContain('<met:type>ApexClass</met:type>');
    expect(listed).not.toContain('<met:type>CustomField</met:type>');
    expect(listed).not.toContain('<met:type>ValidationRule</met:type>');
  });

  it('block + not probeable (a standard field, read from its container) → present, null dates, no query', async () => {
    zipB64 = zipOf({ 'objects/Account.object': ACCOUNT_OBJECT });
    const result = await retrievePreImages(client(), [INDUSTRY], opts());
    expect(image(result, 'CustomField', 'Account.Industry')).toMatchObject({
      present: true,
      stamp_source: 'tooling:CustomField',
      ...noDates,
      comparable: true,
    });
    expect(probeIssued).toEqual([]);
  });

  // Row 3.
  it('no block + row → present with no bytes: the row’s dates, nothing to compare or restore', async () => {
    zipB64 = partialZipB64(null);
    const { amount } = await resolveAmount();
    expect(amount).toEqual({
      present: true,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      last_modified_date: AMOUNT_STAMP,
      last_modified_by: 'Dana Admin',
      ...noBytes,
    });
    // The revert package says why it cannot restore it — without citing a listing.
    const dir = revertDirFor(stagingDir(), 'req-nobytes');
    expect(writeRevertPreImages(dir, [{ ...AMOUNT, image: amount }]).not_restorable).toEqual([
      { ...AMOUNT, reason: NOT_RESTORABLE_NO_BYTES },
    ]);
    expect(NOT_RESTORABLE_NO_BYTES).toBe(
      'the org reports this member, but the retrieve returned no bytes for it',
    );
  });

  // Row 4.
  it('no block + queried, no row with its name → absent, whether the container is missing or holds only another block', async () => {
    probeRows.CustomField = [];
    for (const body of [null, PARTIAL_INVOICE_OTHER_FIELD]) {
      zipB64 = partialZipB64(body);
      const { result, amount } = await resolveAmount();
      expect(amount).toEqual({
        present: false,
        source: 'retrieve',
        stamp_source: 'tooling:CustomField',
        ...noDates,
        ...noBytes,
      });
      expect(result.probe_unmatched).toEqual([]);
      expect(result.dates_unavailable_types).toEqual([]);
    }
  });

  // Row 5.
  it('no block + only a same-name row under another namespace → absent on the retrieve alone, key in probe_unmatched, no stamp taken from that row', async () => {
    zipB64 = partialZipB64(null);
    probeRows.CustomField = [NS_AMOUNT_ROW];
    const { result, amount } = await resolveAmount();
    expect(amount).toEqual({
      present: false,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      ...noDates,
      ...noBytes,
    });
    expect(result.probe_unmatched).toEqual([AMOUNT_KEY]);
  });

  // Row 6.
  it('no block + the type’s query failed → absent, null dates, the type in dates_unavailable_types', async () => {
    zipB64 = partialZipB64(null);
    probeFailOn = 'FROM CustomField';
    const { result, amount } = await resolveAmount();
    expect(amount).toMatchObject({ present: false, ...noDates, ...noBytes });
    expect(result.dates_unavailable_types).toEqual(['CustomField']);
    expect(Object.keys(result.probe_failures)).toEqual(['CustomField']);
  });

  // Row 7.
  it('no block + not probeable (a standard field whose container the org did not return) → absent, null dates, no query', async () => {
    zipB64 = partialZipB64(null);
    const result = await retrievePreImages(client(), [INDUSTRY], opts());
    expect(image(result, 'CustomField', 'Account.Industry')).toEqual({
      present: false,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      ...noDates,
      ...noBytes,
    });
    expect(probeIssued).toEqual([]);
    if (result.status === 'ok') expect(result.dates_unavailable_types).toEqual([]);
  });

  it('a stamp query that never answers is bounded by timeoutMs: the retrieve still stands and the type is reported failed', async () => {
    zipB64 = partialZipB64();
    probeHangOn = 'FROM CustomField';
    const started = Date.now();
    const result = await retrievePreImages(client(), [AMOUNT], opts({ timeoutMs: 40 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.probe_failures).toEqual({ CustomField: 'no answer within 40 ms' });
    expect(result.dates_unavailable_types).toEqual(['CustomField']);
    expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
      present: true,
      ...noDates,
      comparable: true,
    });
  });

  it('a stamp query that never answers is cut off after 30 s when timeoutMs is longer: the retrieve still stands and the type is reported failed', async () => {
    zipB64 = partialZipB64();
    probeHangOn = 'FROM CustomField';
    vi.useFakeTimers();
    try {
      const pending = retrievePreImages(client(), [AMOUNT], opts({ timeoutMs: 120_000 }));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // The retrieve has its zip at once; only the stamp query is outstanding.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.probe_failures).toEqual({ CustomField: 'no answer within 30 s' });
      expect(result.dates_unavailable_types).toEqual(['CustomField']);
      expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
        present: true,
        ...noDates,
        comparable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('probe_unmatched and dates_unavailable_types are sorted', async () => {
    zipB64 = partialZipB64(null);
    // In the order they are gathered, the type the listing cannot enumerate
    // comes before the type whose stamp query failed, and Zeta__c before
    // Amount__c: neither order is the sorted one.
    invalidTypes = new Set(['PresenceUserConfig']);
    probeFailOn = 'FROM ExternalString';
    probeRows.CustomField = [
      probeRow('DeveloperName', 'Zeta', AMOUNT_STAMP_RAW, 'ns'),
      probeRow('DeveloperName', 'Amount', AMOUNT_STAMP_RAW, 'ns'),
    ];
    const result = await retrievePreImages(
      client(),
      [
        { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
        { type: 'CustomField', api_name: 'Invoice__c.Zeta__c' },
        AMOUNT,
        { type: 'CustomLabel', api_name: 'Greeting' },
        { type: 'CustomLabel', api_name: 'Farewell' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.probe_unmatched).toEqual([AMOUNT_KEY, 'CustomField:Invoice__c.Zeta__c']);
    expect(result.dates_unavailable_types).toEqual(['CustomLabel', 'PresenceUserConfig']);
    // Two labels were asked for; their type failed once.
    expect(Object.keys(result.probe_failures)).toEqual(['CustomLabel']);
  });
});

// ── S46 D1f: what the retrieve said is a note, never a verdict ───────────

describe('S46 D1f: retrieve messages', () => {
  const NOT_FOUND = "Entity of type 'CustomField' named 'Invoice__c.Gone__c' cannot be found";

  it('a status with <messages> → the texts are returned and no image’s presence changes', async () => {
    const members = [...MEMBERS, { type: 'CustomField', api_name: 'Invoice__c.Gone__c' }];
    const quiet = await retrievePreImages(client(), members, opts());
    statusMessages = [NOT_FOUND, 'A second thing the org said'];
    const noisy = await retrievePreImages(client(), members, opts());
    expect(quiet.status).toBe('ok');
    expect(noisy.status).toBe('ok');
    if (quiet.status !== 'ok' || noisy.status !== 'ok') return;
    expect(quiet.retrieve_messages).toEqual([]);
    expect(noisy.retrieve_messages).toEqual([NOT_FOUND, 'A second thing the org said']);
    const presence = (r: typeof quiet) => [...r.images].map(([key, img]) => [key, img.present]);
    expect(presence(noisy)).toEqual(presence(quiet));
    // The member the message names is absent because the retrieve returned no
    // block for it and its query no row — in both runs, message or not.
    expect(image(noisy, 'CustomField', 'Invoice__c.Gone__c').present).toBe(false);
    expect(image(quiet, 'CustomField', 'Invoice__c.Gone__c').present).toBe(false);
    // And a message naming a member the retrieve DID return changes nothing either.
    statusMessages = ["Entity of type 'ApexClass' named 'Foo' cannot be found"];
    const contradicted = await retrievePreImages(client(), members, opts());
    expect(image(contradicted, 'ApexClass', 'Foo').present).toBe(true);
  });

  it('the texts are deduplicated, cut to 300 characters and capped at 20', async () => {
    const long = 'x'.repeat(400);
    statusMessages = [NOT_FOUND, NOT_FOUND, long, ...Array.from({ length: 30 }, (_, i) => `message ${i}`)];
    const result = await retrievePreImages(client(), MEMBERS, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.retrieve_messages).toHaveLength(20);
    expect(result.retrieve_messages.slice(0, 3)).toEqual([NOT_FOUND, 'x'.repeat(300), 'message 0']);
    expect(result.retrieve_messages[19]).toBe('message 17');
  });

  it('retrieveMessagesNote: undefined for none; the verbatim note for 1 and for 5 messages', () => {
    expect(retrieveMessagesNote([])).toBeUndefined();
    expect(retrieveMessagesNote([NOT_FOUND])).toBe(
      "The org's retrieve returned 1 message(s) — reported as sent; Contrail does not decide what " +
        "exists from them: Entity of type 'CustomField' named 'Invoice__c.Gone__c' cannot be found",
    );
    expect(retrieveMessagesNote(['one', 'two', 'three', 'four', 'five'])).toBe(
      "The org's retrieve returned 5 message(s) — reported as sent; Contrail does not decide what " +
        'exists from them: one | two | three (+2 more)',
    );
    // Exactly three: all shown, no "more"; each shown text is cut to 200 characters.
    expect(retrieveMessagesNote(['one', 'two', 'y'.repeat(250)])).toBe(
      "The org's retrieve returned 3 message(s) — reported as sent; Contrail does not decide what " +
        `exists from them: one | two | ${'y'.repeat(200)}`,
    );
  });
});

// ── F0: the one never-throwing retrieve, and the exported listing ────────

describe('retrieveNamedMembers — one named retrieve, polled to its end', () => {
  const MANIFEST = { ApexClass: ['Foo'] };
  const namedOpts = { timeoutMs: 5_000, pollIntervalMs: 5 };

  it('ok: the raw zip, the status’ fileProperties and its messages', async () => {
    statusMessages = ['something the org said'];
    const result = await retrieveNamedMembers(client(), MANIFEST, namedOpts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.isBuffer(result.zip)).toBe(true);
    expect(store.extractRetrieveZip(result.zip).get('classes/Foo.cls')).toBeDefined();
    expect(result.fileProperties).toMatchObject([
      { fullName: 'Foo', type: 'ApexClass', lastModifiedDate: '2026-11-01T10:00:00.000Z' },
    ]);
    expect(result.messages).toEqual([
      { fileName: 'unpackaged/package.xml', problem: 'something the org said' },
    ]);
    expect(retrieveBody()).toContain(manifestEntry('ApexClass', 'Foo'));
  });

  it('a retrieve that never finishes within timeoutMs → timeout, with no messages', async () => {
    retrieveMode = 'never';
    const result = await retrieveNamedMembers(client(), MANIFEST, { timeoutMs: 30, pollIntervalMs: 5 });
    expect(result).toEqual({ ok: false, reason: 'timeout', messages: [] });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it('cancelled: an abort ends the loop at the next tick; a signal aborted beforehand makes no SOAP call', async () => {
    retrieveMode = 'never';
    const ctl = new AbortController();
    const pending = retrieveNamedMembers(client(), MANIFEST, {
      timeoutMs: 60_000,
      pollIntervalMs: 5,
      signal: ctl.signal,
    });
    await until(() => statusCalls >= 2);
    ctl.abort();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled', messages: [] });
    const frozen = statusCalls;
    await new Promise((r) => setTimeout(r, 40));
    expect(statusCalls).toBe(frozen);

    soapBodies = [];
    const before = await retrieveNamedMembers(client(), MANIFEST, { ...namedOpts, signal: ctl.signal });
    expect(before).toEqual({ ok: false, reason: 'cancelled', messages: [] });
    expect(soapBodies).toEqual([]);
  });

  it('onPoll is called once per unfinished poll, before the delay; the progress text carries the label', async () => {
    pendingPolls = 3;
    const events: string[] = [];
    const result = await retrieveNamedMembers(client(), MANIFEST, {
      ...namedOpts,
      label: 're-reading members',
      onProgress: (p) => events.push(p),
      onPoll: () => events.push('poll'),
    });
    expect(result.ok).toBe(true);
    expect(statusCalls).toBe(4);
    expect(events).toEqual([
      're-reading members (poll 1, status InProgress)',
      'poll',
      're-reading members (poll 2, status InProgress)',
      'poll',
      're-reading members (poll 3, status InProgress)',
      'poll',
    ]);

    // The default label is the pre-image one, and a finished first status polls nothing.
    statusCalls = 0;
    pendingPolls = 1;
    const progress: string[] = [];
    await retrieveNamedMembers(client(), MANIFEST, { ...namedOpts, onProgress: (p) => progress.push(p) });
    expect(progress).toEqual(['retrieving live pre-images (poll 1, status InProgress)']);
    statusCalls = 0;
    pendingPolls = 0;
    let polls = 0;
    await retrieveNamedMembers(client(), MANIFEST, { ...namedOpts, onPoll: () => (polls += 1) });
    expect(polls).toBe(0);
  });

  it('never throws: a fault, an org-reported failure, a success with no zip and a throwing onPoll are all ok:false', async () => {
    retrieveMode = 'fault';
    const faulted = await retrieveNamedMembers(client(), MANIFEST, namedOpts);
    expect(faulted.ok).toBe(false);
    if (!faulted.ok) expect(faulted.reason).toMatch(/^retrieve_failed:.*retrieve blew up/);

    retrieveMode = 'failed';
    expect(await retrieveNamedMembers(client(), MANIFEST, namedOpts)).toEqual({
      ok: false,
      reason: 'retrieve_failed:boom',
      messages: [],
    });

    retrieveMode = 'nozip';
    statusMessages = ['nothing to send'];
    expect(await retrieveNamedMembers(client(), MANIFEST, namedOpts)).toEqual({
      ok: false,
      reason: 'retrieve_failed:Succeeded',
      messages: [{ fileName: 'unpackaged/package.xml', problem: 'nothing to send' }],
    });

    retrieveMode = 'ok';
    statusCalls = 0;
    pendingPolls = 1;
    const thrown = await retrieveNamedMembers(client(), MANIFEST, {
      ...namedOpts,
      onPoll: () => {
        throw new Error('lease lost');
      },
    });
    expect(thrown).toEqual({ ok: false, reason: 'retrieve_failed:lease lost', messages: [] });
  });

  it('listDates is exported: the rows of the members it is handed, unsupported types, or the reason it threw', async () => {
    const listing = await listDates(client(), [
      { type: 'ApexClass', api_name: 'Foo' },
      { type: 'Report', api_name: 'Ops/Pipeline' },
    ]);
    expect(listing.failure).toBeUndefined();
    expect(listing.unsupported.size).toBe(0);
    expect(listing.props?.map((p) => `${p.type}:${p.fullName}`).sort()).toEqual([
      'ApexClass:Foo',
      'Report:Ops/Pipeline',
    ]);

    invalidTypes = new Set(['BotVersion']);
    const unsupported = await listDates(client(), [{ type: 'BotVersion', api_name: 'MyBot.v1' }]);
    expect([...unsupported.unsupported]).toEqual(['BotVersion']);

    listMode = 'fault';
    const thrown = await listDates(client(), [{ type: 'ApexClass', api_name: 'Foo' }]);
    expect(thrown.props).toBeNull();
    expect(thrown.failure).toMatch(/no metadata api for you/);

    // No member → no call.
    soapBodies = [];
    expect(await listDates(client(), [])).toEqual({ props: [], unsupported: new Set() });
    expect(soapBodies).toEqual([]);
  });
});

// ── list-only pre-images ─────────────────────────────────────────────────

describe('members with no retrieve mirror', () => {
  it('an unregistered destructive member gets a list-only pre_image: presence and dates from the listing, no content', async () => {
    const result = await retrievePreImages(
      client(),
      [
        { type: 'ApexClass', api_name: 'Foo' },
        { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
        { type: 'PresenceUserConfig', api_name: 'Gone' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    const listed = image(result, 'PresenceUserConfig', 'Voice_Agents');
    expect(listed).toEqual({
      present: true,
      source: 'list',
      stamp_source: 'listMetadata',
      last_modified_date: '2026-11-06T10:00:00.000Z',
      last_modified_by: 'Ryley',
      comparable: false,
      restorable: false,
    });
    expect(image(result, 'PresenceUserConfig', 'Gone')).toMatchObject({ present: false, source: 'list' });
    // Never retrieved (no directory map locates its zip entry); listed by its type.
    expect(retrieveBody()).not.toContain('PresenceUserConfig');
    expect(listBodies().join('\n')).toContain('<met:type>PresenceUserConfig</met:type>');
  });

  it('a type the org cannot enumerate at all → present: null; an unknown foldered type is not listed bare', async () => {
    invalidTypes = new Set(['PresenceUserConfig']);
    const result = await retrievePreImages(
      client(),
      [
        { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
        { type: 'EmailTemplate', api_name: 'unfiled$public/Welcome' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(image(result, 'PresenceUserConfig', 'Voice_Agents')).toMatchObject({
      present: null,
      source: 'list',
      stamp_source: 'listMetadata',
      last_modified_date: null,
    });
    expect(result.dates_unavailable_types).toEqual(['PresenceUserConfig']);
    // listMetadata takes the folder for a foldered type, and Contrail has no
    // folder table for EmailTemplate — a bare listing cannot report presence,
    // so the member is neither listed nor called absent.
    expect(image(result, 'EmailTemplate', 'unfiled$public/Welcome').present).toBeNull();
    expect(listBodies().join('\n')).not.toContain('EmailTemplate');
    // No retrievable member at all → no retrieve was issued.
    expect(retrieveBody()).toBe('');
  });

  it('types named "constructor" and "toString" are never retrieved and never listed: presence unknown (null), unplaced in the revert plan, and nothing throws', async () => {
    const strays: PreImageMember[] = [
      { type: 'constructor', api_name: 'Stray_One' },
      { type: 'toString', api_name: 'Stray_Two' },
    ];
    const members: PreImageMember[] = [{ type: 'ApexClass', api_name: 'Foo' }, ...strays];
    for (const s of strays) {
      expect(preImageRetrieveMemberFor(s.type, s.api_name)).toBeNull();
      // Not the unregistered-type path: FOLDERED_TYPES (salesforce/metadataSoap.ts)
      // is a plain-object lookup, so an Object.prototype name reads as a foldered
      // type with no folder and no listing query is built for it — where a really
      // unregistered type (PresenceUserConfig, above) is listed by its type.
      expect(preImageListQueryFor(s)).toBeNull();
    }
    expect(buildPreImageRetrieveMembers(members)).toEqual({ ApexClass: ['Foo'] });
    expect(buildPreImageListQueries(strays)).toEqual({ types: [], folderQueries: [] });
    const result = await retrievePreImages(client(), members, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const s of strays) {
      // No read named it, so its presence is unknown — never absent.
      expect(image(result, s.type, s.api_name)).toEqual({
        present: null,
        source: 'list',
        stamp_source: 'listMetadata',
        last_modified_date: null,
        last_modified_by: null,
        comparable: false,
        restorable: false,
      });
    }
    expect(retrieveBody()).toContain(manifestEntry('ApexClass', 'Foo'));
    expect(retrieveBody()).not.toContain('Stray_');
    // The listing named ApexClass only: no query for either stray, and no untyped query.
    const listed = listBodies().join('\n');
    expect([...listed.matchAll(/<met:queries>(.*?)<\/met:queries>/g)].map((q) => q[1])).toEqual([
      '<met:type>ApexClass</met:type>',
    ]);
    expect(probeIssued).toEqual([]);
    expect(result.dates_unavailable_types).toEqual([]);
    // The rest of the package resolves as usual.
    expect(image(result, 'ApexClass', 'Foo')).toMatchObject({ present: true, content: FOO_CLS });
    // The revert writer: neither is written as a file or as absent; both are
    // not restorable because no read placed the name.
    const written = writeRevertPreImages(
      path.join(tmp, 'rev-strays'),
      members.map((m) => ({ ...m, image: image(result, m.type, m.api_name) })),
    );
    expect(written.components.map((c) => c.api_name)).toEqual(['Foo']);
    expect(written.absent).toEqual([]);
    expect(written.not_restorable).toEqual(
      strays.map((s) => ({ ...s, reason: NOT_RESTORABLE_UNPLACED })),
    );
  });
});

// ── a probed-type member no read can name ────────────────────────────────

describe('S46: a probed-type member whose name cannot be placed', () => {
  const UNPLACED: PreImageMember = { type: 'CustomField', api_name: '.X__c' };

  it('reaches retrievePreImages: the package builder admits the name on the destructive path', () => {
    // The type/name grammar accepts it (no backslash, no "..", NAME_RE), and
    // deletions are validated by that grammar only.
    expect(isValidComponentName(UNPLACED.type, UNPLACED.api_name)).toBe(true);
    expect(() => buildDeployZip([], [UNPLACED], '62.0', () => null)).not.toThrow();
    // A component of that name is refused (it names no parent) — only a delete gets through.
    expect(() =>
      buildDeployZip([{ ...UNPLACED, content: '<fields/>' }], [], '62.0', () => null),
    ).toThrow('CustomField names are dotted (Parent.Child), got ".X__c"');
  });

  it('is named by neither the retrieve nor a stamp query, so its presence is unknown (null) — never absent', async () => {
    zipB64 = partialZipB64();
    expect(buildPreImageRetrieveMembers([AMOUNT, UNPLACED])).toEqual({
      CustomField: ['Invoice__c.Amount__c'],
    });
    const result = await retrievePreImages(client(), [AMOUNT, UNPLACED], opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(image(result, UNPLACED.type, UNPLACED.api_name)).toEqual({
      present: null,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
      last_modified_by: null,
      comparable: false,
      restorable: false,
    });
    // No read named it: the retrieve and the one stamp query name only the other field.
    expect(retrieveBody()).not.toContain('.X__c');
    expect(probeIssued.map((q) => q.soql)).toEqual([Q_AMOUNT]);
    // It is not reported as a member some query answered for under another namespace.
    expect(result.probe_unmatched).toEqual([]);
    expect(result.dates_unavailable_types).toEqual([]);
    // The other member is unaffected.
    expect(image(result, 'CustomField', 'Invoice__c.Amount__c')).toMatchObject({
      present: true,
      last_modified_date: AMOUNT_STAMP,
    });
  });

  it('alone in a package: no retrieve and no stamp query at all, and still null', async () => {
    const result = await retrievePreImages(client(), [UNPLACED], opts());
    expect(result.status).toBe('ok');
    expect(image(result, UNPLACED.type, UNPLACED.api_name).present).toBeNull();
    expect(retrieveBody()).toBe('');
    expect(probeIssued).toEqual([]);
  });

  it('the revert package lists it as not restorable with the reason that no read named it — never as absent', () => {
    const img: PreImage = {
      present: null,
      source: 'retrieve',
      stamp_source: 'tooling:CustomField',
      last_modified_date: null,
      last_modified_by: null,
      comparable: false,
      restorable: false,
    };
    const written = writeRevertPreImages(path.join(tmp, 'rev-unplaced'), [
      { ...UNPLACED, image: img },
    ]);
    expect(written.absent).toEqual([]);
    expect(written.components).toEqual([]);
    expect(written.not_restorable).toEqual([{ ...UNPLACED, reason: NOT_RESTORABLE_UNPLACED }]);
    expect(NOT_RESTORABLE_UNPLACED).not.toContain('could not enumerate');
  });
});

// ── foldered members ─────────────────────────────────────────────────────

describe('foldered members', () => {
  it('a Report is listed by ITS folder only (<met:folder> before <met:type>), never the whole tree', async () => {
    const result = await retrievePreImages(
      client(),
      [
        { type: 'Report', api_name: 'Ops/Pipeline' },
        { type: 'ReportFolder', api_name: 'Ops' },
      ],
      opts(),
    );
    expect(result.status).toBe('ok');
    const bodies = listBodies();
    const folderCall = bodies.find((b) => b.includes('<met:folder>'));
    expect(folderCall).toMatch(
      /<met:queries><met:folder>Ops<\/met:folder><met:type>Report<\/met:type><\/met:queries>/,
    );
    // No bare Report query, no folder enumeration, no unfiled$public pass.
    expect(bodies.join('\n')).not.toMatch(/<met:queries><met:type>Report<\/met:type>/);
    expect(bodies.join('\n')).not.toContain('unfiled$public');
    expect(bodies.join('\n')).toContain('<met:type>ReportFolder</met:type>');

    const report = image(result, 'Report', 'Ops/Pipeline');
    expect(report).toMatchObject({
      present: true,
      content: PIPELINE_REPORT,
      last_modified_date: '2026-11-05T10:00:00.000Z',
      comparable: true,
    });
    const folder = image(result, 'ReportFolder', 'Ops');
    expect(folder).toMatchObject({ present: true, content: OPS_FOLDER, last_modified_date: '2026-11-05T09:00:00.000Z' });
    // Folders address as members of their CONTENT type in the retrieve manifest.
    expect(retrieveBody()).toMatch(
      /<met:members>Ops\/Pipeline<\/met:members><met:members>Ops<\/met:members><met:name>Report<\/met:name>/,
    );
  });
});

// ── cancellation ─────────────────────────────────────────────────────────

describe('cancellation', () => {
  it('an aborted signal ends the poll loop at the next tick: unavailable/cancelled, no further checkRetrieveStatus', async () => {
    retrieveMode = 'never';
    const ctl = new AbortController();
    const pending = retrievePreImages(
      client(),
      MEMBERS,
      opts({ timeoutMs: 60_000, pollIntervalMs: 5, signal: ctl.signal }),
    );
    await until(() => statusCalls >= 2);
    ctl.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    const frozen = statusCalls;
    await new Promise((r) => setTimeout(r, 40));
    expect(statusCalls).toBe(frozen);
  });

  it('a signal already aborted before the retrieve starts is cancelled without any retrieve call or stamp query', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const result = await retrievePreImages(client(), MEMBERS, opts({ signal: ctl.signal }));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    expect(retrieveBody()).toBe('');
    expect(probeIssued).toEqual([]);
  });
});

// ── member grouping ──────────────────────────────────────────────────────

describe('member grouping', () => {
  const members: PreImageMember[] = [
    { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
    { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' },
    { type: 'CustomField', api_name: 'Account.Tier__c' },
    { type: 'ApexClass', api_name: 'Foo' },
    { type: 'ApexClass', api_name: 'Foo' },
    { type: 'ReportFolder', api_name: 'Ops' },
    { type: 'Report', api_name: 'Ops/Pipeline' },
    { type: 'Report', api_name: 'Ops/Weekly' },
    { type: 'Dashboard', api_name: 'Exec/Summary' },
    { type: 'CustomLabel', api_name: 'Greeting' },
    { type: 'BotVersion', api_name: 'MyBot.v1' },
    { type: 'LightningComponentBundle', api_name: 'myCmp' },
    { type: 'PresenceUserConfig', api_name: 'Voice_Agents' },
  ];

  it('buildPreImageRetrieveMembers groups by retrieve type, dedupes, omits unregistered types, and names the four probed types by their own type', () => {
    expect(buildPreImageRetrieveMembers(members)).toEqual({
      ApexClass: ['Foo'],
      Report: ['Ops', 'Ops/Pipeline', 'Ops/Weekly'],
      Dashboard: ['Exec/Summary'],
      Bot: ['MyBot'],
      LightningComponentBundle: ['myCmp'],
      CustomField: ['Invoice__c.Amount__c', 'Account.Tier__c'],
      ValidationRule: ['Invoice__c.Positive_Amount'],
      CustomLabel: ['Greeting'],
    });
    // A child listed twice is named once.
    expect(buildPreImageRetrieveMembers([AMOUNT, AMOUNT])).toEqual({
      CustomField: ['Invoice__c.Amount__c'],
    });
  });

  it('buildPreImageRetrieveMembers: a child whose container is in the manifest rides the container, whatever the order', () => {
    // The container itself is a member — only CustomObject is named.
    expect(
      buildPreImageRetrieveMembers([
        ...members,
        { type: 'CustomObject', api_name: 'Invoice__c' },
      ]),
    ).toEqual({
      ApexClass: ['Foo'],
      Report: ['Ops', 'Ops/Pipeline', 'Ops/Weekly'],
      Dashboard: ['Exec/Summary'],
      Bot: ['MyBot'],
      LightningComponentBundle: ['myCmp'],
      CustomObject: ['Invoice__c'],
      // Account is not in the manifest, so its field is still named by its own type.
      CustomField: ['Account.Tier__c'],
      CustomLabel: ['Greeting'],
    });
    expect(
      buildPreImageRetrieveMembers([AMOUNT, { type: 'CustomObject', api_name: 'Invoice__c' }]),
    ).toEqual({ CustomObject: ['Invoice__c'] });
    // A RecordType keeps the container retrieve, and so brings the container in.
    expect(
      buildPreImageRetrieveMembers([
        AMOUNT,
        { type: 'ValidationRule', api_name: 'Invoice__c.Positive_Amount' },
        { type: 'RecordType', api_name: 'Invoice__c.Biz' },
      ]),
    ).toEqual({ CustomObject: ['Invoice__c'] });
    // A standard field keeps the container retrieve — and a custom field of
    // the same object then rides it.
    expect(buildPreImageRetrieveMembers([INDUSTRY])).toEqual({ CustomObject: ['Account'] });
    expect(
      buildPreImageRetrieveMembers([{ type: 'CustomField', api_name: 'Account.Tier__c' }, INDUSTRY]),
    ).toEqual({ CustomObject: ['Account'] });
  });

  it('preImageRetrieveMemberFor: own type for a probeable child, retrieveMemberFor’s answer for everything else', () => {
    expect(preImageRetrieveMemberFor('CustomField', 'Invoice__c.Amount__c')).toEqual({
      type: 'CustomField',
      member: 'Invoice__c.Amount__c',
    });
    expect(preImageRetrieveMemberFor('ValidationRule', 'Invoice__c.Positive_Amount')).toEqual({
      type: 'ValidationRule',
      member: 'Invoice__c.Positive_Amount',
    });
    expect(preImageRetrieveMemberFor('ListView', 'Account.Mine')).toEqual({
      type: 'ListView',
      member: 'Account.Mine',
    });
    expect(preImageRetrieveMemberFor('CustomLabel', 'Greeting')).toEqual({
      type: 'CustomLabel',
      member: 'Greeting',
    });
    // Not probeable: a standard field, and a name no stamp query can place.
    expect(preImageRetrieveMemberFor('CustomField', 'Account.Industry')).toEqual({
      type: 'CustomObject',
      member: 'Account',
    });
    expect(preImageRetrieveMemberFor('CustomField', "Account.Bad'Name__c")).toEqual({
      type: 'CustomObject',
      member: 'Account',
    });
    // Listing-sourced children keep their container; documents themselves; unregistered → null.
    expect(preImageRetrieveMemberFor('RecordType', 'Invoice__c.Biz')).toEqual({
      type: 'CustomObject',
      member: 'Invoice__c',
    });
    expect(preImageRetrieveMemberFor('BotVersion', 'MyBot.v1')).toEqual({ type: 'Bot', member: 'MyBot' });
    expect(preImageRetrieveMemberFor('ApexClass', 'Foo')).toEqual({ type: 'ApexClass', member: 'Foo' });
    expect(preImageRetrieveMemberFor('ReportFolder', 'Ops')).toEqual({ type: 'Report', member: 'Ops' });
    expect(preImageRetrieveMemberFor('PresenceUserConfig', 'Voice_Agents')).toBeNull();
  });

  it('buildPreImageListQueries lists children by their own type and foldered members per folder', () => {
    expect(buildPreImageListQueries(members)).toEqual({
      types: [
        'CustomField',
        'ValidationRule',
        'ApexClass',
        'ReportFolder',
        'CustomLabel',
        'BotVersion',
        'LightningComponentBundle',
        'PresenceUserConfig',
      ],
      folderQueries: [
        { type: 'Report', folder: 'Ops' },
        { type: 'Dashboard', folder: 'Exec' },
      ],
    });
    expect(preImageListQueryFor({ type: 'Report', api_name: 'Weekly' })).toBeNull();
    expect(preImageListQueryFor({ type: 'EmailTemplate', api_name: 'unfiled$public/Welcome' })).toBeNull();
    expect(preImageListQueryFor({ type: 'ApexClass', api_name: 'Foo' })).toEqual({ type: 'ApexClass' });
    expect(preImageKey('CustomField', 'Invoice__c.Amount__c')).toBe('CustomField:Invoice__c.Amount__c');
  });
});

// ── revert package ───────────────────────────────────────────────────────

describe('revert package layout', () => {
  it('writes documents, children and bundle envelopes under staging/_reverts/<id>, lists not_restorable, and the content_file resolves as a deploy source', async () => {
    const result = await retrievePreImages(
      client(),
      [...MEMBERS, { type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
      opts(),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const dir = revertDirFor(stagingDir(), 'req-1');
    expect(dir).toBe(path.join(tmp, 'staging', '_reverts', 'req-1'));
    expect(() => revertDirFor(stagingDir(), '../x')).toThrow(/invalid request id/);

    const entries = [...result.images.entries()].map(([key, img]) => {
      const colon = key.indexOf(':');
      return { type: key.slice(0, colon), api_name: key.slice(colon + 1), image: img };
    });
    const written = writeRevertPreImages(dir, entries);

    expect(written.components.map((c) => `${c.type}:${c.api_name}`)).toEqual([
      'ApexClass:Foo',
      'CustomField:Invoice__c.Amount__c',
      'LightningComponentBundle:myCmp',
    ]);
    const [foo, field, lwc] = written.components;
    expect(foo!.content_file).toBe(path.join(dir, 'classes', 'Foo.cls'));
    expect(fs.readFileSync(foo!.content_file, 'utf8')).toBe(FOO_CLS);
    expect(fs.readFileSync(path.join(dir, 'classes', 'Foo.cls-meta.xml'), 'utf8')).toBe(FOO_META);
    expect(field!.content_file).toBe(path.join(dir, 'children', 'CustomField', 'Invoice__c.Amount__c.xml'));
    expect(fs.readFileSync(field!.content_file, 'utf8')).toMatch(/^<fields>[\s\S]*<\/fields>$/);
    expect(lwc!.content_file).toBe(
      path.join(dir, 'bundles', 'LightningComponentBundle', 'myCmp.contrail-bundle.json'),
    );
    const envelope = fs.readFileSync(lwc!.content_file, 'utf8');
    expect(parseEnvelopeFor('LightningComponentBundle', 'myCmp', envelope).files).toEqual(LWC_FILES);

    expect(written.not_restorable).toEqual([
      { type: 'Profile', api_name: 'Admin', reason: NOT_RESTORABLE_PROFILE },
      { type: 'PresenceUserConfig', api_name: 'Voice_Agents', reason: NOT_RESTORABLE_LIST_ONLY },
    ]);
    expect(written.absent).toEqual([{ type: 'ApexClass', api_name: 'Missing' }]);
    expect(written.covered).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'profiles'))).toBe(false);

    const plan: RevertPlan = {
      request_id: 'req-1',
      connection: 'test',
      executed_at: '2026-11-14T15:05:00.000Z',
      retrieved_at: result.at,
      retrieve_started_at: result.started_at,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [
          { type: 'ApexClass', api_name: 'Foo' },
          { type: 'CustomField', api_name: 'Invoice__c.Amount__c' },
          { type: 'LightningComponentBundle', api_name: 'myCmp' },
          { type: 'Profile', api_name: 'Admin' },
          { type: 'ApexClass', api_name: 'Missing' },
        ],
        unchecked: [
          { type: 'PresenceUserConfig', api_name: 'Voice_Agents', reason: 'type_not_enumerable' },
        ],
      },
      components: written.components,
      destructive: written.absent,
      not_restorable: written.not_restorable,
      covered: written.covered,
      note: 'n',
    };
    const finalized = finalizeRevertPackage(dir, plan);
    expect(JSON.parse(fs.readFileSync(finalized.plan_path, 'utf8'))).toEqual(plan);
    const readme = fs.readFileSync(finalized.readme_path, 'utf8');
    expect(readme.trimEnd()).toBe(finalized.readme);
    expect(readme).toContain(
      `A revert re-deploys what Contrail retrieved from "test" at ${result.at}, when this deploy was validated. ` +
        `Before executing at 2026-11-14T15:05:00.000Z, Contrail compared the org's last-modified stamps ` +
        `against that retrieve for 5 of 6 members and found them unchanged; it did not re-read their ` +
        `contents, and a matching stamp is evidence, not a byte comparison.`,
    );
    expect(readme).toContain(
      `1 member(s) could not be re-checked (PresenceUserConfig Voice_Agents — type_not_enumerable); ` +
        `their pre-image is as of ${result.at} only.`,
    );
    // The Profile-modify README pin: its bytes WERE captured (package-relative)
    // and the change is a modify — never "no captured bytes" or "a delete".
    expect(readme).toContain(
      `2 member(s) cannot be restored from this package (Profile Admin — ${NOT_RESTORABLE_PROFILE}, ` +
        `PresenceUserConfig Voice_Agents — ${NOT_RESTORABLE_LIST_ONLY}) — if this deploy changed or ` +
        `deleted them, reverting that needs another source.`,
    );
    expect(readme).not.toContain('have no captured bytes');
    expect(readme).not.toContain('a delete of them');

    // The content_file is a legitimate deploy source: staging is an allowed root.
    const src = resolveSourceFile(plan.components[0]!.content_file);
    expect(src.content).toBe(FOO_CLS);
    expect(src.sourcePath.startsWith(fs.realpathSync(stagingDir()))).toBe(true);
  });

  it('refuses a traversal-shaped member path instead of writing outside the revert dir', () => {
    const dir = revertDirFor(stagingDir(), 'req-2');
    const restorable = (content: string, stampSource: StampSource): PreImage => ({
      present: true,
      source: 'retrieve',
      stamp_source: stampSource,
      content,
      last_modified_date: null,
      last_modified_by: null,
      comparable: true,
      restorable: true,
    });
    // children/<Type>/ is two levels deep: three '..' segments would land in _reverts/.
    // (CustomLabel: its container is fixed, so the name reaches the write path intact.)
    expect(() =>
      writeRevertPreImages(dir, [
        {
          type: 'CustomLabel',
          api_name: '../../../escape',
          image: restorable('<labels/>', 'tooling:ExternalString'),
        },
      ]),
    ).toThrow(/unsafe revert path/);
    // Document paths go through fileSafeName, which percent-encodes '/': the
    // name cannot climb, it becomes one odd segment inside the revert dir.
    const doc = writeRevertPreImages(dir, [
      { type: 'ApexClass', api_name: '../../escape', image: restorable('x', 'listMetadata') },
    ]);
    expect(doc.components[0]!.content_file).toBe(path.join(dir, 'classes', '..%2F..%2Fescape.cls'));
    expect(fs.readdirSync(path.join(tmp, 'staging', '_reverts'))).toEqual(['req-2']);
  });

  const restorableImage = (
    content: string,
    files?: Map<string, string>,
    stampSource: StampSource = 'listMetadata',
  ): PreImage => ({
    present: true,
    source: 'retrieve',
    stamp_source: stampSource,
    content,
    ...(files ? { files } : {}),
    last_modified_date: null,
    last_modified_by: null,
    comparable: true,
    restorable: true,
  });
  /** A restorable field block — its stamp source is the field's stamp query. */
  const fieldImage = (content: string): PreImage =>
    restorableImage(content, undefined, 'tooling:CustomField');
  const INVOICE_OBJECT =
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    '    <fields>\n        <fullName>Old__c</fullName>\n        <label>Old</label>\n' +
    '        <length>10</length>\n        <type>Text</type>\n    </fields>\n' +
    '    <label>Invoice</label>\n    <pluralLabel>Invoices</pluralLabel>\n</CustomObject>\n';
  const OLD_FIELD =
    '<fields>\n        <fullName>Old__c</fullName>\n        <label>Old</label>\n' +
    '        <length>10</length>\n        <type>Text</type>\n    </fields>';

  it('a child whose container document is restored too gets no file of its own (listed under covered), whatever the order', () => {
    const dir = revertDirFor(stagingDir(), 'req-covered');
    // The field comes FIRST: the container is only known after a full pass.
    const written = writeRevertPreImages(dir, [
      { type: 'CustomField', api_name: 'Invoice__c.Old__c', image: fieldImage(OLD_FIELD) },
      { type: 'CustomObject', api_name: 'Invoice__c', image: restorableImage(INVOICE_OBJECT) },
    ]);
    expect(written.components).toEqual([
      {
        type: 'CustomObject',
        api_name: 'Invoice__c',
        content_file: path.join(dir, 'objects', 'Invoice__c.object'),
      },
    ]);
    expect(fs.existsSync(path.join(dir, 'children'))).toBe(false);
    expect(written.covered).toEqual([
      {
        type: 'CustomField',
        api_name: 'Invoice__c.Old__c',
        container: { type: 'CustomObject', api_name: 'Invoice__c' },
      },
    ]);
    // The revert package validate_deploy would be handed builds; a container
    // document beside its own child would have been refused.
    const contents = written.components.map((c) => ({
      type: c.type,
      api_name: c.api_name,
      content: fs.readFileSync(c.content_file, 'utf8'),
    }));
    expect(() => buildDeployZip(contents, [], '62.0', () => null)).not.toThrow();
    expect(() =>
      buildDeployZip(
        [...contents, { type: 'CustomField', api_name: 'Invoice__c.Old__c', content: OLD_FIELD }],
        [],
        '62.0',
        () => null,
      ),
    ).toThrow(/Cannot deploy both the full/);

    const readme = revertReadmeText({
      request_id: 'req-covered',
      connection: 'test',
      executed_at: '2026-11-14T15:05:00.000Z',
      retrieved_at: '2026-11-14T15:00:02.000Z',
      retrieve_started_at: '2026-11-14T15:00:00.000Z',
      target_check: null,
      components: written.components,
      destructive: [],
      not_restorable: [],
      covered: written.covered,
      note: 'n',
    });
    expect(readme).toContain(
      " 1 child member(s) (CustomField Invoice__c.Old__c) are restored by their container's document " +
        '(CustomObject Invoice__c), whose retrieved bytes include them; they have no file of their own ' +
        'because validate_deploy refuses a container document and its own children in one package.',
    );
  });

  it('a child is still written on its own when its container is absent or not restorable', () => {
    const dir = revertDirFor(stagingDir(), 'req-uncovered');
    const written = writeRevertPreImages(dir, [
      { type: 'CustomField', api_name: 'Invoice__c.Old__c', image: fieldImage(OLD_FIELD) },
      {
        type: 'CustomObject',
        api_name: 'Invoice__c',
        image: { present: false, source: 'retrieve', stamp_source: 'listMetadata', last_modified_date: null, last_modified_by: null, comparable: false, restorable: false },
      },
      { type: 'CustomField', api_name: 'Other__c.Old__c', image: fieldImage(OLD_FIELD) },
      {
        type: 'CustomObject',
        api_name: 'Other__c',
        image: { ...restorableImage(INVOICE_OBJECT), restorable: false },
      },
    ]);
    expect(written.covered).toEqual([]);
    expect(written.components.map((c) => c.content_file)).toEqual([
      path.join(dir, 'children', 'CustomField', 'Invoice__c.Old__c.xml'),
      path.join(dir, 'children', 'CustomField', 'Other__c.Old__c.xml'),
    ]);
  });

  it('a member listed twice (components and destructive) yields one restorable file', () => {
    const dir = revertDirFor(stagingDir(), 'req-twice');
    const image = restorableImage(FOO_CLS, new Map([['classes/Foo.cls-meta.xml', FOO_META]]));
    const written = writeRevertPreImages(dir, [
      { type: 'ApexClass', api_name: 'Foo', image },
      { type: 'ApexClass', api_name: 'Foo', image },
    ]);
    expect(written.components).toEqual([
      { type: 'ApexClass', api_name: 'Foo', content_file: path.join(dir, 'classes', 'Foo.cls') },
    ]);
    expect(fs.readdirSync(path.join(dir, 'classes')).sort()).toEqual(['Foo.cls', 'Foo.cls-meta.xml']);
  });

  it('never writes through a planted entry: a file where a directory belongs, or a link, refuses the write', () => {
    const dir = revertDirFor(stagingDir(), 'req-planted');
    fs.mkdirSync(dir, { recursive: true });
    // A regular FILE where the classes/ directory belongs.
    fs.writeFileSync(path.join(dir, 'classes'), 'planted');
    expect(() =>
      writeRevertPreImages(dir, [{ type: 'ApexClass', api_name: 'Foo', image: restorableImage(FOO_CLS) }]),
    ).toThrow(/unsafe revert path/);
    expect(fs.readFileSync(path.join(dir, 'classes'), 'utf8')).toBe('planted');

    // A link (junction on Windows) where the classes/ directory belongs.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-outside-'));
    const linked = revertDirFor(stagingDir(), 'req-linked');
    fs.mkdirSync(linked, { recursive: true });
    try {
      try {
        fs.symlinkSync(outside, path.join(linked, 'classes'), 'junction');
      } catch {
        return; // The OS refused to create a link: nothing to pin here.
      }
      expect(() =>
        writeRevertPreImages(linked, [
          { type: 'ApexClass', api_name: 'Foo', image: restorableImage(FOO_CLS) },
        ]),
      ).toThrow(/unsafe revert path/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('finalizeRevertPackage never overwrites or follows what is already at revert-plan.json', () => {
    const dir = revertDirFor(stagingDir(), 'req-final');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'revert-plan.json'), 'planted');
    const plan: RevertPlan = {
      request_id: 'req-final',
      connection: 'test',
      executed_at: '2026-11-14T15:05:00.000Z',
      retrieved_at: '2026-11-14T15:00:02.000Z',
      retrieve_started_at: '2026-11-14T15:00:00.000Z',
      target_check: null,
      components: [],
      destructive: [],
      not_restorable: [],
      covered: [],
      note: 'n',
    };
    expect(() => finalizeRevertPackage(dir, plan)).toThrow(/EEXIST/);
    expect(fs.readFileSync(path.join(dir, 'revert-plan.json'), 'utf8')).toBe('planted');

    // A file planted at README.txt: the README write fails, and the plan
    // this call just wrote is removed — a plan without its README would
    // read as a finalized package. The planted file is left alone.
    const readmeDir = revertDirFor(stagingDir(), 'req-final-readme');
    fs.mkdirSync(readmeDir, { recursive: true });
    fs.writeFileSync(path.join(readmeDir, 'README.txt'), 'planted');
    expect(() =>
      finalizeRevertPackage(readmeDir, { ...plan, request_id: 'req-final-readme' }),
    ).toThrow(/EEXIST/);
    expect(fs.existsSync(path.join(readmeDir, 'revert-plan.json'))).toBe(false);
    expect(fs.readFileSync(path.join(readmeDir, 'README.txt'), 'utf8')).toBe('planted');

    // A link planted at README.txt: never followed.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-outside-'));
    const target = path.join(outside, 'precious.txt');
    fs.writeFileSync(target, 'precious');
    const linkDir = revertDirFor(stagingDir(), 'req-final-link');
    fs.mkdirSync(linkDir, { recursive: true });
    try {
      try {
        fs.symlinkSync(target, path.join(linkDir, 'README.txt'), 'file');
      } catch {
        return; // Symlink creation needs a privilege this host lacks.
      }
      expect(() => finalizeRevertPackage(linkDir, { ...plan, request_id: 'req-final-link' })).toThrow(
        /EEXIST/,
      );
      expect(fs.readFileSync(target, 'utf8')).toBe('precious');
      expect(fs.existsSync(path.join(linkDir, 'revert-plan.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── texts ────────────────────────────────────────────────────────────────

describe('revert README text', () => {
  const base: RevertPlan = {
    request_id: 'r',
    connection: 'test',
    executed_at: '2026-11-14T15:05:00.000Z',
    retrieved_at: '2026-11-14T15:00:02.000Z',
    retrieve_started_at: '2026-11-14T15:00:00.000Z',
    target_check: {
      status: 'ok',
      checked_at: '2026-11-14T15:04:58.000Z',
      checked: [{ type: 'ApexClass', api_name: 'Foo' }],
      unchecked: [],
    },
    components: [{ type: 'ApexClass', api_name: 'Foo', content_file: 'x' }],
    destructive: [],
    not_restorable: [],
    covered: [],
    note: 'n',
  };

  it('is the verbatim text with neither conditional sentence when the lists are empty', () => {
    const text = revertReadmeText(base);
    expect(text).toBe(
      'A revert re-deploys what Contrail retrieved from "test" at 2026-11-14T15:00:02.000Z, when this ' +
        "deploy was validated. Before executing at 2026-11-14T15:05:00.000Z, Contrail compared the org's " +
        'last-modified stamps against that retrieve for 1 of 1 members and found them unchanged; it did not ' +
        're-read their contents, and a matching stamp is evidence, not a byte comparison. It does not undo ' +
        'data changes, automation that ran, permission effects, or changes made since to components ' +
        'outside this package. For the components it restores it is a wholesale replace: re-deploying ' +
        'these files OVERWRITES anything changed in them since that retrieve, another user\'s edits ' +
        "included — the revert's own validate_deploy page diffs it against the org as it is then (or " +
        'against the local snapshot when the org cannot be re-read). ' +
        'Re-deploying a Flow whose latest version is active creates a NEW version; an inactive latest ' +
        'version is overwritten in place. Deleting the components this deploy added is destructive; ' +
        'revert-plan.json lists them under "destructive". Contrail never deploys a revert on its own: pass ' +
        "each component's content_file (and the destructive list) to validate_deploy, and a human approves " +
        'it like any deploy. DML is out of scope — the persisted before-values and created_ids make a ' +
        'manual revert possible.',
    );
    expect(text).not.toContain('could not be re-checked');
    expect(text).not.toContain('cannot be restored from this package');
    expect(text).not.toContain('restored by their container');
    // A revert overwrites later edits to what it restores — never "does not undo" them.
    expect(text).not.toContain('anything another user changed since');
  });

  it('never describes a pass that compared nothing (0 of N) as a comparison', () => {
    const text = revertReadmeText({
      ...base,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [],
        unchecked: [
          { type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_validate' },
          { type: 'BotVersion', api_name: 'MyBot.v1', reason: 'type_not_enumerable' },
        ],
      },
    });
    expect(text).toContain("Contrail did not re-check the org's last-modified stamps");
    expect(text).not.toContain('found them unchanged');
    expect(text).not.toContain('0 of 2');
  });

  it('counts <m> as every member the guard considered, not the revert lists', () => {
    // A delete of a member the org already lacked is checked by the guard but
    // has nothing to restore: the package lists one member, the guard two.
    const text = revertReadmeText({
      ...base,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [
          { type: 'ApexClass', api_name: 'Foo' },
          { type: 'ApexClass', api_name: 'Gone' },
        ],
        unchecked: [{ type: 'BotVersion', api_name: 'MyBot.v1', reason: 'type_not_enumerable' }],
      },
    });
    expect(text).toContain('against that retrieve for 2 of 3 members and found them unchanged');
  });

  it('never claims a comparison that did not happen: unavailable check and outcome-unknown variants', () => {
    const unavailable = revertReadmeText({
      ...base,
      target_check: { status: 'unavailable', reason: 'listMetadata HTTP 500' },
    });
    expect(unavailable).toContain(
      'Before executing at 2026-11-14T15:05:00.000Z, Contrail could not re-read the org to compare ' +
        'last-modified stamps (listMetadata HTTP 500); the deploy was submitted unverified, and ' +
        'these files describe the org as of the validate-time retrieve only.',
    );
    expect(unavailable).not.toContain('found them unchanged');

    // No check recorded at all is not the same as a check that failed.
    const unchecked = revertReadmeText({ ...base, target_check: null });
    expect(unchecked).toContain(
      "Contrail did not re-check the org's last-modified stamps; these files describe the org as " +
        'of the validate-time retrieve only.',
    );
    expect(unchecked).not.toContain('could not re-read');
    expect(unchecked).not.toContain('found them unchanged');

    // A guard with no baseline (not_checked) compared nothing — never "0 of N … unchanged".
    const notChecked = revertReadmeText({
      ...base,
      target_check: {
        status: 'not_checked',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [],
        unchecked: [
          { type: 'ApexClass', api_name: 'Foo', reason: 'live_check_unavailable_no_org_clock' },
        ],
        note: 'no baseline',
      },
    });
    expect(notChecked).toContain("Contrail did not re-check the org's last-modified stamps");
    expect(notChecked).not.toContain('found them unchanged');
    expect(notChecked).not.toContain('could not be re-checked');

    const unknown = revertReadmeText({
      ...base,
      executed_at: null,
      outcome: 'unknown',
      deploy_id: '0Af1',
      note: 'Contrail lost track of this deploy (deploy_timeout); check Setup → Deployment Status.',
    });
    expect(unknown).toContain('Before submitting this deploy (whose outcome Contrail lost track of');
    expect(unknown).not.toContain('null');
    expect(unknown.endsWith('\n\nContrail lost track of this deploy (deploy_timeout); check Setup → Deployment Status.')).toBe(true);
  });

  // ── S46 D4: true for every package ──────────────────────────────────────

  const NEW_CLS = { type: 'ApexClass', api_name: 'NewCls' };
  const ABSENT_READ =
    'the execute-time read of their stamp source again returned nothing for them';
  const NOT_UNDONE =
    'A revert does not undo data changes, automation that ran, permission effects, or changes made ' +
    'since to components outside this package.';
  const DML_SCOPE =
    'DML is out of scope — the persisted before-values and created_ids make a manual revert possible.';
  /** A deploy that only added NewCls: nothing to restore, one component to delete. */
  const addOnly: RevertPlan = {
    ...base,
    target_check: {
      status: 'ok',
      checked_at: '2026-11-14T15:04:58.000Z',
      checked: [{ ...NEW_CLS, absent: true }],
      unchecked: [],
    },
    components: [],
    destructive: [NEW_CLS],
  };

  it('a checked member marked absent is counted apart from the stamp comparisons, and the sentence says what was read', () => {
    const text = revertReadmeText({
      ...base,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [
          { type: 'ApexClass', api_name: 'Foo' },
          { ...NEW_CLS, absent: true },
        ],
        unchecked: [{ type: 'BotVersion', api_name: 'MyBot.v1', reason: 'type_not_enumerable' }],
      },
      destructive: [NEW_CLS],
    });
    expect(text).toContain(
      'A revert re-deploys what Contrail retrieved from "test" at 2026-11-14T15:00:02.000Z, when this ' +
        "deploy was validated. Before executing at 2026-11-14T15:05:00.000Z, Contrail compared the org's " +
        'last-modified stamps against that retrieve for 1 of 3 members and found them unchanged, and ' +
        're-checked 1 member(s) that were absent from the org at validate, and the execute-time read of ' +
        'their stamp source again returned nothing for them; it did not re-read any contents, and a ' +
        'matching stamp is evidence, not a byte comparison. It does not undo data changes,',
    );
    expect(text).toContain(ABSENT_READ);
    // What Contrail read — never a claim about what the org holds.
    expect(text).not.toContain('still reporting none');
    // The absent member is not a stamp comparison: never "2 of 3 … unchanged".
    expect(text).not.toContain('for 2 of 3 members');
    // The unchecked tail is appended as before.
    expect(text).toContain(
      ' 1 member(s) could not be re-checked (BotVersion MyBot.v1 — type_not_enumerable); their ' +
        'pre-image is as of 2026-11-14T15:00:02.000Z only.',
    );
  });

  it('only absent members checked: no stamp comparison is claimed at all', () => {
    const text = revertReadmeText({
      ...base,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [
          { ...NEW_CLS, absent: true },
          { type: 'ApexClass', api_name: 'Other', absent: true },
        ],
        unchecked: [{ type: 'ApexClass', api_name: 'Foo', reason: 'dates_unavailable_at_validate' }],
      },
    });
    expect(text).toContain(
      'Before executing at 2026-11-14T15:05:00.000Z, Contrail re-checked 2 member(s) that were ' +
        'absent from the org at validate — of 3 member(s) it considered — and ' +
        `${ABSENT_READ}; no last-modified stamp was compared. It does not undo data changes,`,
    );
    // The count of absent members is never read as "N of M members were absent".
    expect(text).not.toContain('2 of 3 members');
    expect(text).not.toContain('found them unchanged');
    expect(text).not.toContain('evidence, not a byte comparison');
    expect(text).not.toContain('still reporting none');
  });

  it('nothing to re-deploy, one component to delete: the package says what it holds and what it can revert — verbatim', () => {
    const text = revertReadmeText(addOnly);
    expect(text).toBe(
      'This revert package holds no files to re-deploy: when Contrail retrieved from "test" at ' +
        '2026-11-14T15:00:02.000Z, while this deploy was validated, it captured nothing a revert could ' +
        'restore. What this package can revert is the 1 component(s) this deploy added: a revert deletes ' +
        'them — revert-plan.json lists them under "destructive". Before executing at ' +
        '2026-11-14T15:05:00.000Z, Contrail re-checked 1 member(s) that were absent from the org at ' +
        `validate — of 1 member(s) it considered — and ${ABSENT_READ}; no last-modified stamp was ` +
        `compared. ${NOT_UNDONE} Deleting the ` +
        'components this deploy added is destructive. Contrail never deploys a revert on its own: pass ' +
        'the destructive list to validate_deploy, and a human approves it like any deploy. ' +
        DML_SCOPE,
    );
    expect(text.startsWith('This revert package holds no files to re-deploy')).toBe(true);
    expect(text).toContain(
      'What this package can revert is the 1 component(s) this deploy added: a revert deletes them',
    );
    expect(text).not.toContain('A revert re-deploys what Contrail retrieved');
    expect(text).not.toContain('OVERWRITES');
    expect(text).not.toContain('Reverting this deploy means');
    expect(text).not.toContain('content_file');
  });

  it('the same package with an unknown outcome hedges the adds: ", if it committed"', () => {
    const text = revertReadmeText({
      ...addOnly,
      executed_at: null,
      target_check: null,
      outcome: 'unknown',
      note: 'Contrail lost track of this deploy (deploy_timeout); check Setup → Deployment Status.',
    });
    expect(text).toContain('this deploy added, if it committed: a revert deletes them');
    expect(text.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    expect(text).toContain(
      "Before submitting this deploy (whose outcome Contrail lost track of — see the note in " +
        "revert-plan.json), Contrail did not re-check the org's last-modified stamps",
    );
    expect(text.endsWith('\n\nContrail lost track of this deploy (deploy_timeout); check Setup → Deployment Status.')).toBe(true);
    // A known outcome carries no hedge.
    expect(revertReadmeText(addOnly)).not.toContain('if it committed');
    // A package that holds no files never refers to "these files".
    expect(text).toContain(
      "Contrail did not re-check the org's last-modified stamps; revert-plan.json describes the " +
        'org as of the validate-time retrieve only.',
    );
    expect(text).not.toContain('these files');
  });

  it('nothing to re-deploy and an execute-time check that could not re-read the org: the sentence names revert-plan.json, never "these files" — verbatim', () => {
    const text = revertReadmeText({
      ...addOnly,
      target_check: { status: 'unavailable', reason: 'the org did not answer within 15 s' },
    });
    expect(text).toBe(
      'This revert package holds no files to re-deploy: when Contrail retrieved from "test" at ' +
        '2026-11-14T15:00:02.000Z, while this deploy was validated, it captured nothing a revert could ' +
        'restore. What this package can revert is the 1 component(s) this deploy added: a revert deletes ' +
        'them — revert-plan.json lists them under "destructive". Before executing at ' +
        '2026-11-14T15:05:00.000Z, Contrail could not re-read the org to compare last-modified stamps ' +
        '(the org did not answer within 15 s); the deploy was submitted unverified, and ' +
        'revert-plan.json describes the org as of the validate-time retrieve only. ' +
        `${NOT_UNDONE} Deleting the components this deploy added is destructive. Contrail never ` +
        'deploys a revert on its own: pass the destructive list to validate_deploy, and a human ' +
        `approves it like any deploy. ${DML_SCOPE}`,
    );
    expect(text).not.toContain('these files');
    expect(text).not.toContain('found them unchanged');
  });

  it('nothing to re-deploy, nothing to delete, nothing compared (not_checked): never "these files"', () => {
    const text = revertReadmeText({
      ...base,
      components: [],
      destructive: [],
      target_check: {
        status: 'not_checked',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [],
        unchecked: [
          {
            type: 'CustomField',
            api_name: 'Invoice__c.Status__c',
            reason: 'dates_unavailable_at_validate',
          },
        ],
        note: 'nothing compared',
      },
    });
    expect(text.startsWith('This revert package holds no files to re-deploy and lists nothing to delete: ')).toBe(true);
    expect(text).toContain(
      "Before executing at 2026-11-14T15:05:00.000Z, Contrail did not re-check the org's " +
        'last-modified stamps; revert-plan.json describes the org as of the validate-time retrieve only.',
    );
    expect(text).not.toContain('these files');
  });

  it('nothing restorable beside an add: deleting the add is what the package CAN revert, and the not-restorable tail says what else there is', () => {
    const text = revertReadmeText({
      ...addOnly,
      target_check: {
        status: 'ok',
        checked_at: '2026-11-14T15:04:58.000Z',
        checked: [
          { ...NEW_CLS, absent: true },
          { type: 'Profile', api_name: 'Admin' },
        ],
        unchecked: [],
      },
      not_restorable: [{ type: 'Profile', api_name: 'Admin', reason: NOT_RESTORABLE_PROFILE }],
    });
    expect(text.startsWith('This revert package holds no files to re-deploy: ')).toBe(true);
    expect(text).toContain('What this package can revert is the 1 component(s) this deploy added');
    expect(text).not.toContain('Reverting this deploy means');
    expect(text).toContain(
      'for 1 of 2 members and found them unchanged, and re-checked 1 member(s) that were absent',
    );
    expect(text).toContain(
      ` 1 member(s) cannot be restored from this package (Profile Admin — ${NOT_RESTORABLE_PROFILE}) ` +
        '— if this deploy changed or deleted them, reverting that needs another source.',
    );
  });

  it('nothing to re-deploy and nothing to delete: the package says both — verbatim', () => {
    const text = revertReadmeText({ ...base, components: [], destructive: [] });
    expect(text).toBe(
      'This revert package holds no files to re-deploy and lists nothing to delete: when Contrail ' +
        'retrieved from "test" at 2026-11-14T15:00:02.000Z, while this deploy was validated, it ' +
        'captured nothing a revert could restore. Before executing at 2026-11-14T15:05:00.000Z, ' +
        "Contrail compared the org's last-modified stamps against that retrieve for 1 of 1 members and " +
        'found them unchanged; it did not re-read their contents, and a matching stamp is evidence, not ' +
        `a byte comparison. ${NOT_UNDONE} Contrail never deploys a revert on its own. ${DML_SCOPE}`,
    );
    expect(text).not.toContain('A revert re-deploys what Contrail retrieved');
    expect(text).not.toContain('What this package can revert');
    expect(text).not.toContain('destructive');
    expect(text).not.toContain('OVERWRITES');
  });
});

describe('targetMovedRefusalText — one source for the three refusals', () => {
  it('deploy: the verbatim refusal, consequence first', () => {
    const text = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [
        {
          type: 'ValidationRule',
          api_name: 'Invoice__c.Positive_Amount',
          last_modified_by: 'Sam Editor',
          last_modified_date: '2026-11-14T15:03:40.000Z',
          frozen_date: '2026-11-02T11:00:00.000Z',
        },
        {
          type: 'ApexClass',
          api_name: 'Foo',
          last_modified_by: null,
          last_modified_date: null,
          frozen_date: '2026-11-01T10:00:00.000Z',
          state: 'gone',
        },
      ],
    });
    expect(text).toBe(
      'TARGET MOVED — not executed, and this code is now void. listMetadata (15:04) reports members ' +
        'changed in "acme-uat" since this package was validated: ValidationRule Invoice__c.Positive_Amount — ' +
        'last modified by Sam Editor at 2026-11-14T15:03:40.000Z (the approval was based on the version ' +
        'last modified at 2026-11-02T11:00:00.000Z); ApexClass Foo — listMetadata no longer reports it ' +
        '(the approval was based on the version last modified at 2026-11-01T10:00:00.000Z). The approved diff no longer ' +
        'describes what this deploy would overwrite. Re-run validate_deploy to see the current state and ' +
        'get a fresh code. This check is best-effort: Contrail re-reads the org immediately before claiming ' +
        'the code and compares last-modified stamps, not bytes; a change landing after that read — while ' +
        'the deploy is submitted and processed by the org — is not caught.',
    );
    expect(text.indexOf('not executed')).toBeLessThan(text.indexOf('listMetadata'));
  });

  it('deploy, degrade variant: anchored on the org clock, never "based on undefined"', () => {
    const text = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [
        {
          type: 'ApexClass',
          api_name: 'Foo',
          last_modified_by: 'Sam Editor',
          last_modified_date: '2026-11-14T15:03:40.000Z',
          frozen_date: null,
        },
      ],
      degrade: { org_clock_created_date: '2026-11-14T15:00:01.000Z', live_check_reason: 'timeout' },
    });
    expect(text).toContain(
      'ApexClass Foo — last modified by Sam Editor at 2026-11-14T15:03:40.000Z, after this package was ' +
        'validated at 2026-11-14T15:00:01.000Z (no live baseline was captured at validate: timeout; ' +
        'Contrail compared against the org-side validation time, minus a 5-second ordering margin). ' +
        'The approved diff no longer describes',
    );
    expect(text).not.toMatch(/undefined|null|based on /);
    expect(text).toContain('reports members changed in "acme-uat" since this package was validated:');
    expect(text).not.toContain('within 5 seconds before');
  });

  it('deploy, degrade variant: a stamp inside the 5-second margin BEFORE validation is never described as "after"', () => {
    const degrade = { org_clock_created_date: '2026-11-14T15:00:01.000Z', live_check_reason: 'timeout' };
    const inMargin = {
      type: 'ApexClass',
      api_name: 'Foo',
      last_modified_by: 'Sam Editor',
      last_modified_date: '2026-11-14T14:59:58.000Z',
      frozen_date: null,
    };
    const text = targetMovedRefusalText('deploy', { at: '15:04', alias: 'acme-uat', moved: [inMargin], degrade });
    expect(text).toContain(
      'listMetadata (15:04) reports members changed in "acme-uat" since, or within 5 seconds before, ' +
        'this package was validated: ApexClass Foo — last modified by Sam Editor at ' +
        "2026-11-14T14:59:58.000Z, within 5 seconds before this package's org-side validation started at " +
        '2026-11-14T15:00:01.000Z, too close to rule out that the approved diff missed it (no live ' +
        'baseline was captured at validate: timeout; Contrail compared against the org-side validation ' +
        'time, minus a 5-second ordering margin). The approved diff no longer describes',
    );
    expect(text).not.toContain('after this package was validated');
    expect(text).not.toMatch(/undefined|null|based on /);

    // One member in the margin and one after it: each clause says its own.
    const both = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [
        inMargin,
        {
          type: 'ApexClass',
          api_name: 'Bar',
          last_modified_by: 'Carol Jones',
          last_modified_date: '2026-11-14T15:03:40.000Z',
          frozen_date: null,
        },
      ],
      degrade,
    });
    expect(both).toContain('since, or within 5 seconds before, this package was validated:');
    expect(both).toContain(
      "ApexClass Foo — last modified by Sam Editor at 2026-11-14T14:59:58.000Z, within 5 seconds before this package's",
    );
    expect(both).toContain(
      'ApexClass Bar — last modified by Carol Jones at 2026-11-14T15:03:40.000Z, after this package was ' +
        'validated at 2026-11-14T15:00:01.000Z (no live baseline',
    );
  });

  it('deploy: a member that appeared since validate is attributed to listMetadata, never asserted as fact', () => {
    const text = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [
        {
          type: 'ApexClass',
          api_name: 'Bar',
          last_modified_by: 'Sam Editor',
          last_modified_date: '2026-11-14T15:03:40.000Z',
          frozen_date: null,
          state: 'created',
        },
      ],
    });
    expect(text).toContain(
      'ApexClass Bar — listMetadata now reports it, last modified by Sam Editor at ' +
        '2026-11-14T15:03:40.000Z (the approval was based on the org reporting no such member). ' +
        'The approved diff no longer describes',
    );
    expect(text).not.toMatch(/undefined|null|in the org/);
  });

  // S46 D1: a moved member names the stamp source that reported the move.
  const MOVED_FIELD: DeployMovedMember = {
    type: 'CustomField',
    api_name: 'Invoice__c.Status__c',
    last_modified_by: 'Sam Editor',
    last_modified_date: '2026-11-14T15:03:40.000Z',
    frozen_date: '2026-11-02T10:00:00.000Z',
    source: 'tooling:CustomField',
  };
  const MOVED_CLASS: DeployMovedMember = {
    type: 'ApexClass',
    api_name: 'Foo',
    last_modified_by: 'Carol Jones',
    last_modified_date: '2026-11-14T15:03:50.000Z',
    frozen_date: '2026-11-01T10:00:00.000Z',
  };
  const TAIL =
    'The approved diff no longer describes what this deploy would overwrite. Re-run validate_deploy to ' +
    'see the current state and get a fresh code. This check is best-effort: Contrail re-reads the org ' +
    'immediately before claiming the code and compares last-modified stamps, not bytes; a change ' +
    'landing after that read — while the deploy is submitted and processed by the org — is not caught.';

  it('deploy: a member moved through its stamp query — the head names that query, the rest is unchanged', () => {
    const text = targetMovedRefusalText('deploy', { at: '15:04', alias: 'acme-uat', moved: [MOVED_FIELD] });
    expect(text).toBe(
      'TARGET MOVED — not executed, and this code is now void. A Tooling query on CustomField (15:04) ' +
        'reports members changed in "acme-uat" since this package was validated: CustomField ' +
        'Invoice__c.Status__c — last modified by Sam Editor at 2026-11-14T15:03:40.000Z (the approval ' +
        `was based on the version last modified at 2026-11-02T10:00:00.000Z). ${TAIL}`,
    );
    expect(text).not.toContain('listMetadata');
    // A source of listMetadata, and no source at all (a 0.39 request), read the same.
    const listed = targetMovedRefusalText('deploy', { at: '15:04', alias: 'acme-uat', moved: [MOVED_CLASS] });
    expect(listed).toContain('void. listMetadata (15:04) reports members changed in "acme-uat" since');
    expect(
      targetMovedRefusalText('deploy', {
        at: '15:04',
        alias: 'acme-uat',
        moved: [{ ...MOVED_CLASS, source: 'listMetadata' }],
      }),
    ).toBe(listed);
  });

  it('deploy: mixed sources are joined in first-appearance order with the plural verb', () => {
    const mixed = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [MOVED_CLASS, MOVED_FIELD],
    });
    expect(mixed).toBe(
      'TARGET MOVED — not executed, and this code is now void. listMetadata and a Tooling query on ' +
        'CustomField (15:04) report members changed in "acme-uat" since this package was validated: ' +
        'ApexClass Foo — last modified by Carol Jones at 2026-11-14T15:03:50.000Z (the approval was ' +
        'based on the version last modified at 2026-11-01T10:00:00.000Z); CustomField ' +
        'Invoice__c.Status__c — last modified by Sam Editor at 2026-11-14T15:03:40.000Z (the approval ' +
        `was based on the version last modified at 2026-11-02T10:00:00.000Z). ${TAIL}`,
    );
    // The query first: the head's first letter is capitalised; listMetadata keeps its case.
    expect(
      targetMovedRefusalText('deploy', { at: '15:04', alias: 'acme-uat', moved: [MOVED_FIELD, MOVED_CLASS] }),
    ).toContain(
      'void. A Tooling query on CustomField and listMetadata (15:04) report members changed in "acme-uat"',
    );
    // Three sources: ", " then a final " and "; two members of one source name it once.
    expect(
      targetMovedRefusalText('deploy', {
        at: '15:04',
        alias: 'acme-uat',
        moved: [
          MOVED_CLASS,
          MOVED_FIELD,
          { ...MOVED_FIELD, api_name: 'Invoice__c.Amount__c' },
          { ...MOVED_FIELD, type: 'ListView', api_name: 'Invoice__c.Open_Invoices', source: 'data:ListView' },
        ],
      }),
    ).toContain(
      'void. listMetadata, a Tooling query on CustomField and a query on ListView (15:04) report members changed in',
    );
    expect(
      targetMovedRefusalText('deploy', {
        at: '15:04',
        alias: 'acme-uat',
        moved: [{ ...MOVED_FIELD, type: 'ListView', api_name: 'Invoice__c.Open_Invoices', source: 'data:ListView' }],
      }),
    ).toContain('void. A query on ListView (15:04) reports members changed in');
  });

  it('deploy: gone and created clauses are attributed to the member’s own stamp source', () => {
    const text = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [
        { ...MOVED_FIELD, last_modified_by: null, last_modified_date: null, state: 'gone' },
        {
          type: 'CustomLabel',
          api_name: 'Greeting',
          last_modified_by: 'Sam Editor',
          last_modified_date: '2026-11-14T15:03:40.000Z',
          frozen_date: null,
          state: 'created',
          source: 'tooling:ExternalString',
        },
        { ...MOVED_CLASS, last_modified_by: null, last_modified_date: null, state: 'gone' },
      ],
    });
    expect(text).toContain(
      'A Tooling query on CustomField, a Tooling query on ExternalString and listMetadata (15:04) report ' +
        'members changed in "acme-uat" since this package was validated: ' +
        'CustomField Invoice__c.Status__c — a Tooling query on CustomField no longer reports it (the ' +
        'approval was based on the version last modified at 2026-11-02T10:00:00.000Z); ' +
        'CustomLabel Greeting — a Tooling query on ExternalString now reports it, last modified by Sam ' +
        'Editor at 2026-11-14T15:03:40.000Z (the approval was based on the org reporting no such ' +
        'member); ApexClass Foo — listMetadata no longer reports it (the approval was based on the ' +
        'version last modified at 2026-11-01T10:00:00.000Z). The approved diff no longer describes',
    );
    expect(text).not.toMatch(/undefined|null/);
  });

  it('deploy, degrade variant through a stamp query: the head names the query', () => {
    const text = targetMovedRefusalText('deploy', {
      at: '15:04',
      alias: 'acme-uat',
      moved: [{ ...MOVED_FIELD, frozen_date: null }],
      degrade: { org_clock_created_date: '2026-11-14T15:00:01.000Z', live_check_reason: 'timeout' },
    });
    expect(text).toContain(
      'void. A Tooling query on CustomField (15:04) reports members changed in "acme-uat" since this ' +
        'package was validated: CustomField Invoice__c.Status__c — last modified by Sam Editor at ' +
        '2026-11-14T15:03:40.000Z, after this package was validated at 2026-11-14T15:00:01.000Z (no live ' +
        'baseline was captured at validate: timeout;',
    );
  });

  it('dml: two vanished records share one explanatory tail with no dangling "it"', () => {
    const text = targetMovedRefusalText('dml', {
      at: '15:04',
      changed: [],
      missing: [
        { object: 'Contact', id: '003xx000004TmiQAAS' },
        { object: 'Contact', id: '003xx000004TmiRAAS' },
      ],
    });
    expect(text).toContain(
      'dml_propose: Contact 003xx000004TmiQAAS was returned by the preview query at propose but not at ' +
        '15:04; Contact 003xx000004TmiRAAS was returned by the preview query at propose but not at 15:04 ' +
        "— each was deleted, or is no longer visible to this connection's user",
    );
    expect(text.match(/those cases look identical from here/g)).toHaveLength(1);
  });

  it('dml: one changed record and one vanished record reproduce the template exactly', () => {
    const text = targetMovedRefusalText('dml', {
      at: '15:04',
      changed: [{ object: 'Account', id: '001xx000003DGbYAAW', field: 'Name', now: '"Acme East"', before: '"Acme"' }],
      missing: [{ object: 'Contact', id: '003xx000004TmiQAAS' }],
    });
    expect(text).toBe(
      'TARGET MOVED — not executed, and this code is now void. Re-running the preview query at 15:04 ' +
        'shows the records you approved have changed since dml_propose: Account 001xx000003DGbYAAW Name ' +
        'is now "Acme East" (the approval showed "Acme"); Contact 003xx000004TmiQAAS was returned by the ' +
        'preview query at propose but not at 15:04 — it was deleted, or is no longer visible to this ' +
        "connection's user (a converted Lead also drops out); those cases look identical from here. " +
        'Re-run dml_propose to see the current values and get a fresh code.',
    );
  });

  it('activation: Status now vs the approved from-status', () => {
    expect(
      targetMovedRefusalText('activation', {
        at: '15:04',
        version: 'v3',
        agent: 'Support_Agent',
        now: 'Active',
        from: 'Inactive',
      }),
    ).toBe(
      'TARGET MOVED — not executed, and this code is now void. SELECT Status at 15:04 reports BotVersion ' +
        'v3 of Support_Agent is Active; the approval was for a change from Inactive. Re-run ' +
        'agent_activation_propose.',
    );
  });

  it('hhmm renders a local clock face and passes an unparseable stamp through', () => {
    const d = new Date('2026-11-14T15:04:05.000Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(hhmm(d.toISOString())).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    expect(hhmm('not a date')).toBe('not a date');
  });
});

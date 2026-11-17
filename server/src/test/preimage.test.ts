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
import { buildDeployZip, parseEnvelopeFor } from '../deploy/package.js';
import { resolveSourceFile } from '../deploy/sources.js';
import { stagingDir } from '../core/paths.js';
import {
  NOT_RESTORABLE_LIST_ONLY,
  NOT_RESTORABLE_PROFILE,
  buildPreImageListQueries,
  buildPreImageRetrieveMembers,
  bundleEnvelopeJson,
  finalizeRevertPackage,
  hhmm,
  preImageKey,
  preImageListQueryFor,
  retrievePreImages,
  revertDirFor,
  revertReadmeText,
  summarizePreImage,
  targetMovedRefusalText,
  writeRevertPreImages,
  type PreImage,
  type PreImageMember,
  type PreImageResult,
  type RevertPlan,
} from '../deploy/preimage.js';

/**
 * S45: the live pre-image module — one retrieve + the listing calls that
 * are the one date source, resolved per member into content, presence and
 * stamps; `unavailable` reserved for the retrieve path; the revert layout
 * under staging/_reverts; and the verbatim refusal / README texts.
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

function fixtureZipB64(): string {
  const entries: Record<string, Uint8Array> = {
    'unpackaged/package.xml': strToU8('<Package/>'),
    'unpackaged/classes/Foo.cls': strToU8(FOO_CLS),
    'unpackaged/classes/Foo.cls-meta.xml': strToU8(FOO_META),
    'unpackaged/objects/Invoice__c.object': strToU8(INVOICE_OBJECT),
    'unpackaged/profiles/Admin.profile': strToU8(ADMIN_PROFILE),
    'unpackaged/bots/MyBot.bot': strToU8(MYBOT),
    'unpackaged/reports/Ops/Pipeline.report': strToU8(PIPELINE_REPORT),
    'unpackaged/reports/Ops-meta.xml': strToU8(OPS_FOLDER),
  };
  for (const [rel, body] of Object.entries(LWC_FILES)) {
    entries[`unpackaged/lwc/myCmp/${rel}`] = strToU8(body);
  }
  return Buffer.from(zipSync(entries)).toString('base64');
}

interface ListRow {
  fullName: string;
  date: string;
  by: string;
}

const DEFAULT_LIST_ROWS: Record<string, ListRow[]> = {
  ApexClass: [{ fullName: 'Foo', date: '2026-11-01T10:00:00.000Z', by: 'Ryley' }],
  CustomField: [{ fullName: 'Invoice__c.Amount__c', date: '2026-11-02T10:00:00.000Z', by: 'Ryley' }],
  ValidationRule: [
    { fullName: 'Invoice__c.Positive_Amount', date: '2026-11-02T11:00:00.000Z', by: 'Ryley' },
  ],
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

let tmp: string;
let store: SnapshotStore;
let soapBodies: string[];
let statusCalls: number;
let retrieveMode: 'ok' | 'never' | 'fault' | 'failed';
let listMode: 'ok' | 'fault';
let invalidTypes: Set<string>;
let zipB64: string;

/**
 * The soap.test.ts stubWithInvalidType idiom, widened to the three calls
 * this module makes: retrieve → one async id; checkRetrieveStatus → the
 * fixture zip (or never done / failed, per retrieveMode); listMetadata →
 * canned rows per queried type, folder-aware, an sf:INVALID_TYPE Fault for
 * any type in invalidTypes, a transport-shaped fault when listMode is
 * 'fault'.
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
      if (retrieveMode === 'never') {
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
      return new Response(
        soapEnvelope(
          `<checkRetrieveStatusResponse ${MD}><result><done>true</done><id>09S1</id>` +
            `<status>Succeeded</status><success>true</success>` +
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
  listMode = 'ok';
  invalidTypes = new Set();
  zipB64 = fixtureZipB64();
  stubSoap();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ok path ──────────────────────────────────────────────────────────────

describe('retrievePreImages — ok path', () => {
  it('resolves a document, a child, a bundle, an absent member and a Profile from one retrieve + listing', async () => {
    const result = await retrievePreImages(client(), MEMBERS, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.started_at).toBe(STARTED_AT);
    expect(Date.parse(result.at)).toBeGreaterThanOrEqual(Date.parse(STARTED_AT));
    expect(result.dates_unavailable_types).toEqual([]);
    expect(result.dates_unavailable).toBeUndefined();
    expect(result.images.size).toBe(5);

    // Document: content_file-ready body, the -meta.xml sidecar kept in files.
    const foo = image(result, 'ApexClass', 'Foo');
    expect(foo).toMatchObject({
      present: true,
      source: 'retrieve',
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
      sha256: sha256(FOO_CLS),
      last_modified_date: '2026-11-01T10:00:00.000Z',
      last_modified_by: 'Ryley',
      comparable: true,
      restorable: true,
    });

    // Child: the block extracted from the parent document, dated by its OWN type's listing.
    const field = image(result, 'CustomField', 'Invoice__c.Amount__c');
    expect(field.present).toBe(true);
    expect(field.content).toMatch(/^<fields>[\s\S]*<fullName>Amount__c<\/fullName>[\s\S]*<\/fields>$/);
    expect(field.content).not.toContain('Status__c');
    expect(field.last_modified_date).toBe('2026-11-02T10:00:00.000Z');
    expect(field.comparable).toBe(true);
    expect(field.restorable).toBe(true);

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

    // The retrieve manifest: children inside their container, one member per name.
    const body = retrieveBody();
    expect(body).toMatch(
      /<met:types><met:members>Foo<\/met:members><met:members>Missing<\/met:members><met:name>ApexClass<\/met:name><\/met:types>/,
    );
    expect(body).toContain('<met:members>Invoice__c</met:members><met:name>CustomObject</met:name>');
    expect(body).toContain('<met:members>myCmp</met:members><met:name>LightningComponentBundle</met:name>');
    expect(body).toContain('<met:members>Admin</met:members><met:name>Profile</met:name>');
    // The date source lists children by their OWN type, never the container.
    const listed = listBodies().join('\n');
    expect(listed).toContain('<met:type>CustomField</met:type>');
    expect(listed).not.toContain('<met:type>CustomObject</met:type>');
    expect(listed).toContain('<met:type>LightningComponentBundle</met:type>');
  });

  it('an empty member set makes no SOAP call and is ok with no images', async () => {
    const result = await retrievePreImages(client(), [], opts());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.images.size).toBe(0);
    expect(soapBodies).toEqual([]);
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
    expect(version.content).toMatch(/^<botVersions>[\s\S]*<fullName>v1<\/fullName>/);
    expect(version.last_modified_date).toBeNull();
    expect(version.last_modified_by).toBeNull();
    expect(version.comparable).toBe(true);
    const field = image(result, 'CustomField', 'Invoice__c.Amount__c');
    expect(field.last_modified_date).toBe('2026-11-02T10:00:00.000Z');
    expect(result.dates_unavailable_types).toEqual(['BotVersion']);
    expect(result.dates_unavailable).toBeUndefined();
  });

  it('a listing that throws (non-INVALID_TYPE) never discards the retrieve: ok, every date null, dates_unavailable set', async () => {
    listMode = 'fault';
    const result = await retrievePreImages(client(), MEMBERS, opts());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.dates_unavailable).toMatch(/no metadata api for you/);
    expect(result.dates_unavailable_types).toEqual([]);
    for (const img of result.images.values()) {
      expect(img.last_modified_date).toBeNull();
      expect(img.last_modified_by).toBeNull();
    }
    expect(image(result, 'ApexClass', 'Foo')).toMatchObject({ present: true, content: FOO_CLS });
    expect(image(result, 'ApexClass', 'Missing').present).toBe(false);
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

  it('a signal already aborted before the retrieve starts is cancelled without any SOAP call', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const result = await retrievePreImages(client(), MEMBERS, opts({ signal: ctl.signal }));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    expect(retrieveBody()).toBe('');
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

  it('buildPreImageRetrieveMembers groups by retrieve type, dedupes, and omits unregistered types', () => {
    expect(buildPreImageRetrieveMembers(members)).toEqual({
      CustomObject: ['Invoice__c', 'Account'],
      ApexClass: ['Foo'],
      Report: ['Ops', 'Ops/Pipeline', 'Ops/Weekly'],
      Dashboard: ['Exec/Summary'],
      CustomLabels: ['CustomLabels'],
      Bot: ['MyBot'],
      LightningComponentBundle: ['myCmp'],
    });
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
    const restorable = (content: string): PreImage => ({
      present: true,
      source: 'retrieve',
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
        { type: 'CustomLabel', api_name: '../../../escape', image: restorable('<labels/>') },
      ]),
    ).toThrow(/unsafe revert path/);
    // Document paths go through fileSafeName, which percent-encodes '/': the
    // name cannot climb, it becomes one odd segment inside the revert dir.
    const doc = writeRevertPreImages(dir, [
      { type: 'ApexClass', api_name: '../../escape', image: restorable('x') },
    ]);
    expect(doc.components[0]!.content_file).toBe(path.join(dir, 'classes', '..%2F..%2Fescape.cls'));
    expect(fs.readdirSync(path.join(tmp, 'staging', '_reverts'))).toEqual(['req-2']);
  });

  const restorableImage = (content: string, files?: Map<string, string>): PreImage => ({
    present: true,
    source: 'retrieve',
    content,
    ...(files ? { files } : {}),
    last_modified_date: null,
    last_modified_by: null,
    comparable: true,
    restorable: true,
  });
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
      { type: 'CustomField', api_name: 'Invoice__c.Old__c', image: restorableImage(OLD_FIELD) },
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
      { type: 'CustomField', api_name: 'Invoice__c.Old__c', image: restorableImage(OLD_FIELD) },
      {
        type: 'CustomObject',
        api_name: 'Invoice__c',
        image: { present: false, source: 'retrieve', last_modified_date: null, last_modified_by: null, comparable: false, restorable: false },
      },
      { type: 'CustomField', api_name: 'Other__c.Old__c', image: restorableImage(OLD_FIELD) },
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
        'last-modified stamps (listMetadata HTTP 500); the deploy was submitted unverified',
    );
    expect(unavailable).not.toContain('found them unchanged');

    // No check recorded at all is not the same as a check that failed.
    const unchecked = revertReadmeText({ ...base, target_check: null });
    expect(unchecked).toContain("Contrail did not re-check the org's last-modified stamps");
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

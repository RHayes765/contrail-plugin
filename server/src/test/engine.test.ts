import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { AuditLog } from '../core/audit.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { AccessTokenManager } from '../salesforce/tokens.js';
import { SnapshotStore } from '../snapshot/store.js';
import { SnapshotEngine } from '../snapshot/engine.js';
import { emptyGrantSet } from '../core/grants.js';
import {
  INVOICE_OBJECT_XML,
  INVOICE_SERVICE_APEX,
  SEND_INVOICE_FLOW_XML,
} from './fixtures.js';

/**
 * Full pipeline integration test with a stubbed Salesforce: token refresh,
 * SOAP listMetadata/retrieve/checkRetrieveStatus, Tooling MCD queries —
 * everything below `fetch` is real.
 */

let tmp: string;
let db: ContrailDb;
let engine: SnapshotEngine;
let store: SnapshotStore;
let connId: string;
let orgModifiedDate = '2026-08-01T00:00:00.000Z';

const TYPES = ['ApexClass', 'CustomObject', 'Flow'];

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function fileProp(type: string, fullName: string, fileName: string): string {
  return `<fileProperties><fullName>${fullName}</fullName><type>${type}</type>
    <fileName>${fileName}</fileName><id>x</id>
    <lastModifiedDate>${orgModifiedDate}</lastModifiedDate>
    <lastModifiedByName>Ryley</lastModifiedByName></fileProperties>`;
}

function listResult(type: string, fullName: string, fileName: string): string {
  return fileProp(type, fullName, fileName).replaceAll('fileProperties>', 'result>');
}

function buildFixtureZip(): string {
  const zip = zipSync({
    'unpackaged/package.xml': strToU8('<Package/>'),
    'unpackaged/classes/InvoiceService.cls': strToU8(INVOICE_SERVICE_APEX),
    'unpackaged/objects/Invoice__c.object': strToU8(INVOICE_OBJECT_XML),
    'unpackaged/flows/Send_Invoice.flow': strToU8(SEND_INVOICE_FLOW_XML),
  });
  return Buffer.from(zip).toString('base64');
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT-stub',
          instance_url: 'https://inst.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:listMetadata>')) {
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               ${listResult('ApexClass', 'InvoiceService', 'classes/InvoiceService.cls')}
               ${listResult('CustomObject', 'Invoice__c', 'objects/Invoice__c.object')}
               ${listResult('Flow', 'Send_Invoice', 'flows/Send_Invoice.flow')}
             </listMetadataResponse>`,
          ),
        );
      }
      if (body.includes('<met:retrieve>')) {
        return new Response(
          soapEnvelope(
            `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>09S-stub</id><done>false</done><state>Queued</state></result>
             </retrieveResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkRetrieveStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><done>true</done><status>Succeeded</status><success>true</success>
                 <id>09S-stub</id><zipFile>${buildFixtureZip()}</zipFile>
                 ${fileProp('ApexClass', 'InvoiceService', 'classes/InvoiceService.cls')}
                 ${fileProp('CustomObject', 'Invoice__c', 'objects/Invoice__c.object')}
                 ${fileProp('Flow', 'Send_Invoice', 'flows/Send_Invoice.flow')}
               </result>
             </checkRetrieveStatusResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    if (url.includes('/tooling/query')) {
      const q = decodeURIComponent(url);
      if (q.includes("MetadataComponentType = 'Flow'")) {
        return new Response(
          JSON.stringify({
            done: true,
            records: [
              {
                MetadataComponentName: 'Send_Invoice',
                MetadataComponentType: 'Flow',
                RefMetadataComponentName: 'InvoiceService',
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-engine-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  const tokens = new MemoryTokenStore();
  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 10, toolWaitMs: 10_000 },
  };
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  const conn = db.insertConnection({
    alias: 'stub-org',
    instanceUrl: 'https://inst.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Stub',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT-stub');
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  const tokenMgr = new AccessTokenManager(db, tokens, config);
  engine = new SnapshotEngine(db, store, tokenMgr, config, new AuditLog(db));
  stubSalesforce();
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SnapshotEngine.refresh', () => {
  it('runs the whole pipeline: retrieve → snapshot → index → edges → audit', async () => {
    const conn = db.getConnection(connId)!;
    const outcome = await engine.refresh(conn, TYPES);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;

    expect(outcome.summary.artifact_counts).toMatchObject({
      ApexClass: 1,
      CustomObject: 1,
      CustomField: 3,
      ValidationRule: 1,
      Flow: 1,
    });
    expect(outcome.summary.edge_counts.org).toBe(1);
    expect(outcome.summary.edge_counts.extractor).toBeGreaterThan(3);

    // index
    const cls = db.getArtifact(connId, 'ApexClass', 'InvoiceService');
    expect(cls).toBeTruthy();
    expect(cls!.lastModifiedDate).toBe(orgModifiedDate);
    expect(db.getArtifact(connId, 'CustomField', 'Invoice__c.Amount__c')).toBeTruthy();

    // snapshot files on disk
    expect(store.readCurrentFile(connId, 'classes/InvoiceService.cls')).toContain(
      'InvoiceHelper.process',
    );

    // search
    const hits = db.searchArtifacts(connId, 'InvoiceHelper', undefined, 10);
    expect(hits.some((h) => h.apiName === 'InvoiceService')).toBe(true);

    // graph: org edge + extractor edges coexist
    const usedBy = db.edgesTo(connId, 'ApexClass', 'InvoiceService');
    expect(usedBy.some((e) => e.source === 'org' && e.fromName === 'Send_Invoice')).toBe(true);
    const uses = db.edgesFrom(connId, 'ApexClass', 'InvoiceService');
    expect(uses.some((e) => e.toName === 'Invoice__c')).toBe(true);

    // audit
    const events = db.queryAuditEvents({}).map((e) => e.eventType);
    expect(events).toContain('snapshot.refreshed');
  });

  it('partial refresh preserves other types on disk, in the index, and in the graph', async () => {
    const conn = db.getConnection(connId)!;
    await engine.refresh(conn, TYPES);

    // Baseline from the full refresh: cross-type extractor edges exist.
    expect(
      db.edgesFrom(connId, 'ApexClass', 'InvoiceService').some((e) => e.toName === 'Invoice__c'),
    ).toBe(true);

    const partial = await engine.refresh(conn, ['ApexClass']);
    expect(partial.status).toBe('complete');

    // Non-refreshed types survive on disk and in the index.
    expect(store.readCurrentFile(connId, 'flows/Send_Invoice.flow')).toContain('Send Invoice');
    expect(store.readCurrentFile(connId, 'objects/Invoice__c.object')).toContain('Amount__c');
    expect(db.getArtifact(connId, 'Flow', 'Send_Invoice')).toBeTruthy();
    expect(db.getArtifact(connId, 'CustomField', 'Invoice__c.Amount__c')).toBeTruthy();

    // Cross-type Apex edges are rebuilt against the FULL index, not the slice.
    const uses = db.edgesFrom(connId, 'ApexClass', 'InvoiceService');
    expect(uses.some((e) => e.toType === 'CustomObject' && e.toName === 'Invoice__c')).toBe(true);
    expect(uses.some((e) => e.toType === 'ApexClass')).toBe(false); // InvoiceHelper not in this org fixture

    // Flow-origin extractor edges from the earlier full refresh are untouched.
    expect(
      db.edgesFrom(connId, 'Flow', 'Send_Invoice').some((e) => e.toName === 'InvoiceService'),
    ).toBe(true);
  });

  it('reports staleness when the org moved on', async () => {
    const conn = db.getConnection(connId)!;
    await engine.refresh(conn, TYPES);

    orgModifiedDate = '2026-08-06T12:00:00.000Z'; // org changed after the snapshot
    const report = await engine.checkStaleness(conn, TYPES);
    expect(report.stale.length).toBeGreaterThan(0);
    expect(report.stale[0]).toMatchObject({ api_name: expect.any(String) });
    expect(report.note).toContain('refresh_snapshot');

    orgModifiedDate = '2026-08-01T00:00:00.000Z';
    const clean = await engine.checkStaleness(conn, TYPES);
    expect(clean.stale).toEqual([]);
  });
});

describe('S29: foldered refresh (Report/ReportFolder)', () => {
  const REPORT_XML = '<Report><reportType>Opportunity</reportType></Report>';
  const FOLDER_XML = '<ReportFolder><name>Ops</name></ReportFolder>';

  function stubFolderedSalesforce(retrieveBodies: string[], opts?: { emptyOrg?: boolean }): void {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT-stub',
            instance_url: 'https://inst.stub.salesforce.com',
            id: 'https://login.salesforce.com/id/00D1/0051',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.includes('/services/Soap/m/')) {
        const body = String(init?.body ?? '');
        if (body.includes('<met:listMetadata>')) {
          if (opts?.emptyOrg) {
            return new Response(
              soapEnvelope(
                `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"></listMetadataResponse>`,
              ),
            );
          }
          if (body.includes('<met:folder>Ops</met:folder>')) {
            return new Response(
              soapEnvelope(
                `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                   ${listResult('Report', 'Ops/Weekly', 'reports/Ops/Weekly.report')}
                 </listMetadataResponse>`,
              ),
            );
          }
          if (body.includes('<met:type>ReportFolder</met:type>')) {
            return new Response(
              soapEnvelope(
                `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                   ${listResult('ReportFolder', 'Ops', 'reports/Ops')}
                 </listMetadataResponse>`,
              ),
            );
          }
          // unfiled$public and anything else: empty.
          return new Response(
            soapEnvelope(
              `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"></listMetadataResponse>`,
            ),
          );
        }
        if (body.includes('<met:retrieve>')) {
          retrieveBodies.push(body);
          return new Response(
            soapEnvelope(
              `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><id>09S-folder</id><done>false</done><state>Queued</state></result>
               </retrieveResponse>`,
            ),
          );
        }
        if (body.includes('<met:checkRetrieveStatus>')) {
          const zip = Buffer.from(
            zipSync({
              'unpackaged/package.xml': strToU8('<Package/>'),
              'unpackaged/reports/Ops-meta.xml': strToU8(FOLDER_XML),
              'unpackaged/reports/Ops/Weekly.report': strToU8(REPORT_XML),
            }),
          ).toString('base64');
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><done>true</done><status>Succeeded</status><success>true</success>
                   <id>09S-folder</id><zipFile>${zip}</zipFile>
                   ${fileProp('Report', 'Ops/Weekly', 'reports/Ops/Weekly.report')}
                   ${fileProp('ReportFolder', 'Ops', 'reports/Ops')}
                 </result>
               </checkRetrieveStatusResponse>`,
            ),
          );
        }
        return new Response('unexpected SOAP body', { status: 500 });
      }
      if (url.includes('/tooling/query')) {
        return new Response(JSON.stringify({ done: true, records: [] }));
      }
      return new Response('not found', { status: 404 });
    });
  }

  it('couples ReportFolder in, retrieves explicit members, indexes folder-qualified', async () => {
    const retrieveBodies: string[] = [];
    stubFolderedSalesforce(retrieveBodies);
    const conn = db.getConnection(connId)!;
    const outcome = await engine.refresh(conn, ['Report']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;

    // Coupling: the job normalized to both types.
    expect(outcome.summary.types).toContain('ReportFolder');
    expect(outcome.summary.artifact_counts).toMatchObject({ Report: 1, ReportFolder: 1 });

    // Retrieve members: ONE Report types block carrying the folder AND the
    // folder-qualified path; never a wildcard, never a ReportFolder block.
    const body = retrieveBodies[0]!;
    expect(body).toContain('<met:name>Report</met:name>');
    expect(body).toContain('<met:members>Ops</met:members>');
    expect(body).toContain('<met:members>Ops/Weekly</met:members>');
    expect(body).not.toContain('<met:members>*</met:members>');
    expect(body).not.toContain('<met:name>ReportFolder</met:name>');

    // Index: folder-qualified api_name with staleness data, folder row too.
    const report = db.getArtifact(connId, 'Report', 'Ops/Weekly');
    expect(report).toBeTruthy();
    expect(report!.lastModifiedDate).toBe(orgModifiedDate);
    expect(report!.filePath).toBe('reports/Ops/Weekly.report');
    expect(db.getArtifact(connId, 'ReportFolder', 'Ops')).toBeTruthy();
    expect(store.readCurrentFile(connId, 'reports/Ops/Weekly.report')).toContain('reportType');

    // Extractor edge: Report → its report type.
    const uses = db.edgesFrom(connId, 'Report', 'Ops/Weekly');
    expect(uses.some((e) => e.toType === 'ReportType' && e.toName === 'Opportunity')).toBe(true);

    // Staleness joins on the folder-qualified name — nothing falsely stale.
    const clean = await engine.checkStaleness(conn, ['Report']);
    expect(clean.checked_types).toContain('ReportFolder');
    expect(clean.stale).toEqual([]);
    expect(clean.missing_from_index).toBe(0);
  });

  it('a foldered refresh with no listable inventory fails LOUDLY, wiping nothing', async () => {
    stubFolderedSalesforce([], { emptyOrg: true });
    const conn = db.getConnection(connId)!;
    const outcome = await engine.refresh(conn, ['Report']);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toMatch(/nothing retrievable/);
  });

  it('a foldered refresh leaves other types untouched (shared-dir isolation)', async () => {
    stubSalesforce();
    const conn = db.getConnection(connId)!;
    await engine.refresh(conn, TYPES);
    const retrieveBodies: string[] = [];
    stubFolderedSalesforce(retrieveBodies);
    const outcome = await engine.refresh(conn, ['Report']);
    expect(outcome.status).toBe('complete');
    // The Apex/object/flow snapshot and index survive the reports refresh.
    expect(store.readCurrentFile(connId, 'classes/InvoiceService.cls')).toBeTruthy();
    expect(db.getArtifact(connId, 'ApexClass', 'InvoiceService')).toBeTruthy();
    expect(db.getArtifact(connId, 'Report', 'Ops/Weekly')).toBeTruthy();
  });
});

describe('S30: unsupported-type refresh degrade', () => {
  function stubAgentforceSalesforce(): void {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT-stub',
            instance_url: 'https://inst.stub.salesforce.com',
            id: 'https://login.salesforce.com/id/00D1/0051',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.includes('/services/Soap/m/')) {
        const body = String(init?.body ?? '');
        if (body.includes('<met:listMetadata>')) {
          // The org does not know GenAiPlannerBundle (old API version or
          // unlicensed) — the whole chunk faults, then per-query retries.
          if (body.includes('<met:type>GenAiPlannerBundle</met:type>')) {
            return new Response(
              soapEnvelope(
                `<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode>
                 <faultstring>INVALID_TYPE: Cannot use: GenAiPlannerBundle in this version</faultstring></soapenv:Fault>`,
              ),
              { status: 500 },
            );
          }
          return new Response(
            soapEnvelope(
              `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 ${listResult('GenAiPlugin', 'Order_Topic', 'genAiPlugins/Order_Topic.genAiPlugin')}
               </listMetadataResponse>`,
            ),
          );
        }
        if (body.includes('<met:retrieve>')) {
          // The retrieve must never even ASK for the unsupported type.
          if (body.includes('<met:name>GenAiPlannerBundle</met:name>')) {
            return new Response('unsupported type in retrieve', { status: 500 });
          }
          return new Response(
            soapEnvelope(
              `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><id>09S-agent</id><done>false</done><state>Queued</state></result>
               </retrieveResponse>`,
            ),
          );
        }
        if (body.includes('<met:checkRetrieveStatus>')) {
          const zip = Buffer.from(
            zipSync({
              'unpackaged/package.xml': strToU8('<Package/>'),
              'unpackaged/genAiPlugins/Order_Topic.genAiPlugin': strToU8('<GenAiPlugin/>'),
            }),
          ).toString('base64');
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><done>true</done><status>Succeeded</status><success>true</success>
                   <id>09S-agent</id><zipFile>${zip}</zipFile>
                   ${fileProp('GenAiPlugin', 'Order_Topic', 'genAiPlugins/Order_Topic.genAiPlugin')}
                 </result>
               </checkRetrieveStatusResponse>`,
            ),
          );
        }
        return new Response('unexpected SOAP body', { status: 500 });
      }
      if (url.includes('/tooling/query')) {
        return new Response(JSON.stringify({ done: true, records: [] }));
      }
      return new Response('not found', { status: 404 });
    });
  }

  it('one unsupported type warns and drops out; healthy types refresh; its state survives', async () => {
    // Pre-existing planner bundle snapshot state that MUST survive the skip.
    store.writeCurrent(
      connId,
      new Map([
        [
          'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle',
          strToU8('<GenAiPlannerBundle>keep me</GenAiPlannerBundle>'),
        ],
      ]),
    );
    db.replaceArtifactsForTypes(connId, ['GenAiPlannerBundle'], [
      {
        connectionId: connId,
        type: 'GenAiPlannerBundle',
        apiName: 'Agent_v1',
        filePath: 'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle',
        contentHash: 'h',
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt: '2026-09-01T00:00:00.000Z',
        content: '',
      },
    ]);

    stubAgentforceSalesforce();
    const conn = db.getConnection(connId)!;
    const outcome = await engine.refresh(conn, ['GenAiPlugin', 'GenAiPlannerBundle']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;

    expect(outcome.summary.warnings.join(' ')).toMatch(/GenAiPlannerBundle not supported/);
    expect(outcome.summary.artifact_counts).toMatchObject({ GenAiPlugin: 1 });
    expect(db.getArtifact(connId, 'GenAiPlugin', 'Order_Topic')).toBeTruthy();

    // The unsupported type's snapshot file AND index row are untouched.
    expect(
      store.readCurrentFile(connId, 'genAiPlannerBundles/Agent_v1/Agent_v1.genAiPlannerBundle'),
    ).toContain('keep me');
    expect(db.getArtifact(connId, 'GenAiPlannerBundle', 'Agent_v1')).toBeTruthy();
  });

  it('every requested type unsupported fails LOUDLY, wiping nothing', async () => {
    stubAgentforceSalesforce();
    const conn = db.getConnection(connId)!;
    const outcome = await engine.refresh(conn, ['GenAiPlannerBundle']);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toMatch(/nothing retrievable/);
  });
});

describe('S47: a Data Mapper refresh owns omniDataTransforms/', () => {
  const MAPPER_RPT = 'omniDataTransforms/AccountSummaryExtract_1.rpt';
  const MAPPER_PROPS = ['OmniDataTransform', 'AccountSummaryExtract_1', MAPPER_RPT] as const;
  const MAPPER_XML =
    '<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">' +
    '<name>AccountSummaryExtract</name><type>Extract</type>' +
    '<uniqueName>AccountSummaryExtract_1</uniqueName></OmniDataTransform>';

  // The shared stub answers everything except the OmniDataTransform listing
  // and retrieve, which follow `org.mapperListed`.
  function stubMapperSalesforce(org: { mapperListed: boolean }): void {
    stubSalesforce();
    const shared = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (
        body.includes('<met:listMetadata>') &&
        body.includes('<met:type>OmniDataTransform</met:type>')
      ) {
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               ${org.mapperListed ? listResult(...MAPPER_PROPS) : ''}
             </listMetadataResponse>`,
          ),
        );
      }
      if (
        body.includes('<met:retrieve>') &&
        body.includes('<met:name>OmniDataTransform</met:name>')
      ) {
        return new Response(
          soapEnvelope(
            `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>09S-mapper</id><done>false</done><state>Queued</state></result>
             </retrieveResponse>`,
          ),
        );
      }
      if (body.includes('<met:asyncProcessId>09S-mapper</met:asyncProcessId>')) {
        const entries: Record<string, Uint8Array> = {
          'unpackaged/package.xml': strToU8('<Package/>'),
        };
        if (org.mapperListed) entries[`unpackaged/${MAPPER_RPT}`] = strToU8(MAPPER_XML);
        const zip = Buffer.from(zipSync(entries)).toString('base64');
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><done>true</done><status>Succeeded</status><success>true</success>
                 <id>09S-mapper</id><zipFile>${zip}</zipFile>
                 ${org.mapperListed ? fileProp(...MAPPER_PROPS) : ''}
               </result>
             </checkRetrieveStatusResponse>`,
          ),
        );
      }
      return shared(input, init);
    });
  }

  it('an empty Data Mapper retrieve still clears omniDataTransforms/, and only it', async () => {
    const org = { mapperListed: true };
    stubMapperSalesforce(org);
    const conn = db.getConnection(connId)!;
    await engine.refresh(conn, TYPES);
    const first = await engine.refresh(conn, ['OmniDataTransform']);
    expect(first.status).toBe('complete');
    expect(store.readCurrentFile(connId, MAPPER_RPT)).toContain('AccountSummaryExtract');
    expect(db.getArtifact(connId, 'OmniDataTransform', 'AccountSummaryExtract_1')).toBeTruthy();

    // The org now lists none, so the retrieve brings back no omniDataTransforms/
    // entry. TYPE_DIRS names the type's own directory, so it is cleared anyway:
    // without that entry the index row would go while the stale .rpt stayed.
    org.mapperListed = false;
    const second = await engine.refresh(conn, ['OmniDataTransform']);
    expect(second.status).toBe('complete');
    expect(store.readCurrentFile(connId, MAPPER_RPT)).toBeNull();
    expect(db.getArtifact(connId, 'OmniDataTransform', 'AccountSummaryExtract_1')).toBeNull();

    // Every other type's snapshot and index survive.
    expect(store.readCurrentFile(connId, 'classes/InvoiceService.cls')).toContain(
      'InvoiceHelper.process',
    );
    expect(store.readCurrentFile(connId, 'flows/Send_Invoice.flow')).toContain('Send Invoice');
    expect(db.getArtifact(connId, 'ApexClass', 'InvoiceService')).toBeTruthy();
    expect(db.getArtifact(connId, 'CustomField', 'Invoice__c.Amount__c')).toBeTruthy();
  });
});

describe('S47: an empty Data Mapper listing reads the Omnistudio Metadata setting', () => {
  const OFF_WARNING =
    "OmniDataTransform: 0 listed — the org's Omnistudio Metadata setting is off, so its Data " +
    "Mappers are records the Metadata API can't list or retrieve.";
  /** 'absent' = the org's settings file has no enableOmniStudioMetadata field. */
  let setting: 'on' | 'off' | 'absent';
  let mapperListed: boolean;
  /** A listing that names OmniDataTransform faults with this code ('none' = it answers). */
  let listingFault: 'none' | 'INVALID_TYPE' | 'UNKNOWN_EXCEPTION';
  let soapBodies: string[];
  const settingsRetrieves = () =>
    soapBodies.filter(
      (b) => b.includes('<met:retrieve>') && b.includes('<met:name>Settings</met:name>'),
    );

  // The shared stub answers everything except the OmniDataTransform listing,
  // the Settings retrieve and its status.
  beforeEach(() => {
    setting = 'off';
    mapperListed = false;
    listingFault = 'none';
    soapBodies = [];
    const shared = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (String(input).includes('/services/Soap/m/')) soapBodies.push(body);
      if (
        body.includes('<met:listMetadata>') &&
        body.includes('<met:type>OmniDataTransform</met:type>')
      ) {
        if (listingFault !== 'none') {
          const said =
            listingFault === 'INVALID_TYPE'
              ? 'INVALID_TYPE: Cannot use: OmniDataTransform in this version'
              : 'UNKNOWN_EXCEPTION: An unexpected error occurred';
          return new Response(
            soapEnvelope(
              `<soapenv:Fault><faultcode>sf:${listingFault}</faultcode>
               <faultstring>${said}</faultstring></soapenv:Fault>`,
            ),
            { status: 500 },
          );
        }
        const row = listResult(
          'OmniDataTransform',
          'AccountSummaryExtract_1',
          'omniDataTransforms/AccountSummaryExtract_1.rpt',
        );
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               ${mapperListed ? row : ''}
             </listMetadataResponse>`,
          ),
        );
      }
      if (body.includes('<met:retrieve>') && body.includes('<met:name>Settings</met:name>')) {
        return new Response(
          soapEnvelope(
            `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>09S-omni</id><done>false</done><state>Queued</state></result>
             </retrieveResponse>`,
          ),
        );
      }
      if (body.includes('<met:asyncProcessId>09S-omni</met:asyncProcessId>')) {
        const field =
          setting === 'absent'
            ? ''
            : `<enableOmniStudioMetadata>${setting === 'on'}</enableOmniStudioMetadata>`;
        const zip = zipSync({
          'unpackaged/package.xml': strToU8('<Package/>'),
          'unpackaged/settings/OmniStudio.settings': strToU8(
            `<OmniStudioSettings xmlns="http://soap.sforce.com/2006/04/metadata">${field}</OmniStudioSettings>`,
          ),
        });
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><done>true</done><status>Succeeded</status><success>true</success>
                 <id>09S-omni</id><zipFile>${Buffer.from(zip).toString('base64')}</zipFile>
               </result>
             </checkRetrieveStatusResponse>`,
          ),
        );
      }
      return shared(input, init);
    });
  });

  it('0 listed + setting off: the refresh says why, once', async () => {
    const outcome = await engine.refresh(db.getConnection(connId)!, ['OmniDataTransform']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.summary.warnings).toContain(OFF_WARNING);
    expect(outcome.summary.warnings.filter((w) => w.startsWith('OmniDataTransform:'))).toHaveLength(
      1,
    );
    expect(settingsRetrieves()).toHaveLength(1);
    expect(settingsRetrieves()[0]).toContain(
      '<met:types><met:members>OmniStudio</met:members><met:name>Settings</met:name></met:types>',
    );
  });

  it('0 listed + setting on: no warning (0 then means none)', async () => {
    setting = 'on';
    const outcome = await engine.refresh(db.getConnection(connId)!, ['OmniDataTransform']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.summary.warnings.filter((w) => /omnistudio/i.test(w))).toEqual([]);
    expect(settingsRetrieves()).toHaveLength(1);
  });

  it('0 listed + setting unreadable: a neutral note naming the reason', async () => {
    setting = 'absent';
    const outcome = await engine.refresh(db.getConnection(connId)!, ['OmniDataTransform']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.summary.warnings).toContain(
      "OmniDataTransform: 0 listed, and the org's Omnistudio Metadata setting could not be read " +
        "(the org's OmniStudioSettings has no enableOmniStudioMetadata field (no Omnistudio " +
        "licence?)); where that setting is off, Data Mappers are records the Metadata API can't " +
        'list, so 0 may not mean none.',
    );
    expect(outcome.summary.warnings).not.toContain(OFF_WARNING);
  });

  it('a listing with Data Mappers, or a refresh without the type, reads no setting', async () => {
    mapperListed = true;
    const listed = await engine.refresh(db.getConnection(connId)!, ['OmniDataTransform']);
    expect(listed.status).toBe('complete');
    if (listed.status !== 'complete') return;
    expect(listed.summary.warnings.filter((w) => /omnistudio/i.test(w))).toEqual([]);

    const others = await engine.refresh(db.getConnection(connId)!, TYPES);
    expect(others.status).toBe('complete');
    expect(settingsRetrieves()).toEqual([]);
  });

  it('a FAILED listing reads no setting: nothing was listed, so "0 listed" would be false', async () => {
    listingFault = 'UNKNOWN_EXCEPTION';
    const outcome = await engine.refresh(db.getConnection(connId)!, ['OmniDataTransform']);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    // The listing's own warning stands alone.
    expect(
      outcome.summary.warnings.some(
        (w) => w.startsWith('listMetadata failed (') && w.includes('UNKNOWN_EXCEPTION'),
      ),
    ).toBe(true);
    expect(
      outcome.summary.warnings.filter((w) => w.startsWith('OmniDataTransform: 0 listed')),
    ).toEqual([]);
    expect(outcome.summary.warnings.filter((w) => /omnistudio/i.test(w))).toEqual([]);
    expect(settingsRetrieves()).toEqual([]);
  });

  it('a type the org refuses (INVALID_TYPE) reads no setting: "not supported" stands alone', async () => {
    listingFault = 'INVALID_TYPE';
    // An org without the licence: its settings would not answer either.
    setting = 'absent';
    const outcome = await engine.refresh(db.getConnection(connId)!, [
      'ApexClass',
      'OmniDataTransform',
    ]);
    expect(outcome.status).toBe('complete');
    if (outcome.status !== 'complete') return;
    expect(outcome.summary.warnings).toContain(
      'OmniDataTransform not supported by this org/API version — skipped ' +
        '(feature not licensed, or salesforce.apiVersion too old).',
    );
    expect(outcome.summary.warnings.filter((w) => /omnistudio/i.test(w))).toEqual([]);
    expect(settingsRetrieves()).toEqual([]);
    // The healthy type still refreshed.
    expect(db.getArtifact(connId, 'ApexClass', 'InvoiceService')).toBeTruthy();
  });
});

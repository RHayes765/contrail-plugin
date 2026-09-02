import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import httpMod from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { buildDeployZip } from '../deploy/package.js';
import { generateConfirmationCode } from '../deploy/codes.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import { INVOICE_OBJECT_XML } from './fixtures.js';

/**
 * P0.4 write-safety tests. The invariant under test: no execution without a
 * code that only the approval page carries; codes are single-use, expire,
 * and die on re-validation; every refusal is audited.
 */

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let client: Client;
let connId: string;
let presentedPages: string[];
let openedUrls: string[];
let deployCounter: { validations: number; realDeploys: number; quickDeploys: number };
let lastQuickValidationId = '';
let failNextQuickDeploy = false;
let lastDeployBody = '';
let failNextValidation = false;
let failCompositeRef: string | null = null;
let lastCompositeBody: {
  allOrNone: boolean;
  compositeRequest: Array<{ method: string; url: string; referenceId: string; body?: unknown }>;
} | null = null;

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://deploy.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        lastDeployBody = body;
        const checkOnly = body.includes('<met:checkOnly>true</met:checkOnly>');
        if (checkOnly) deployCounter.validations += 1;
        else deployCounter.realDeploys += 1;
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af-${checkOnly ? 'check' : 'real'}-${deployCounter.validations}-${deployCounter.realDeploys}</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:deployRecentValidation>')) {
        if (failNextQuickDeploy) {
          failNextQuickDeploy = false;
          return new Response(
            soapEnvelope(
              `<soapenv:Fault><faultcode>INVALID_ID_FIELD</faultcode>
               <faultstring>The validation is no longer available for quick deployment</faultstring>
               </soapenv:Fault>`,
            ),
            { status: 500 },
          );
        }
        deployCounter.quickDeploys += 1;
        lastQuickValidationId =
          /<met:validationId>([^<]+)<\/met:validationId>/.exec(body)?.[1] ?? '';
        return new Response(
          soapEnvelope(
            `<deployRecentValidationResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>0Af-quick-${deployCounter.quickDeploys}</result>
             </deployRecentValidationResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        const failed = failNextValidation;
        failNextValidation = false;
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>
                 <done>true</done><status>${failed ? 'Failed' : 'Succeeded'}</status>
                 <success>${!failed}</success><checkOnly>false</checkOnly>
                 <numberComponentsTotal>2</numberComponentsTotal>
                 <numberComponentsDeployed>${failed ? 0 : 2}</numberComponentsDeployed>
                 <numberComponentErrors>${failed ? 1 : 0}</numberComponentErrors>
                 <numberTestsTotal>3</numberTestsTotal>
                 <numberTestsCompleted>${failed ? 2 : 3}</numberTestsCompleted>
                 <numberTestErrors>${failed ? 1 : 0}</numberTestErrors>
                 <details>
                   ${
                     failed
                       ? `<componentFailures><componentType>ApexClass</componentType>
                          <fullName>Broken</fullName><problemType>Error</problemType>
                          <problem>Compile error at line 3</problem></componentFailures>
                          <runTestResult><numTestsRun>3</numTestsRun><numFailures>1</numFailures>
                          <failures><name>InvoiceServiceTest</name><methodName>testRun</methodName>
                          <message>Assertion failed: expected 5, got 4</message>
                          <stackTrace>Class.InvoiceServiceTest.testRun: line 12</stackTrace></failures>
                          </runTestResult>`
                       : `<runTestResult><numTestsRun>3</numTestsRun><numFailures>0</numFailures></runTestResult>`
                   }
                 </details>
               </result>
             </checkDeployStatusResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    if (url.includes('/composite/sobjects')) {
      const method = init?.method ?? 'GET';
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
    // The FULL Composite API (ordered subrequests + @{ref.id} substitution).
    // Must stay AFTER the more specific /composite/sobjects branch above.
    if (url.endsWith('/composite')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        allOrNone: boolean;
        compositeRequest: Array<{ method: string; url: string; referenceId: string; body?: unknown }>;
      };
      lastCompositeBody = body;
      const subs = body.compositeRequest;
      const failing = failCompositeRef !== null && subs.some((s) => s.referenceId === failCompositeRef);
      let minted = 0;
      const compositeResponse = subs.map((sub) => {
        if (sub.referenceId === failCompositeRef) {
          return {
            referenceId: sub.referenceId,
            httpStatusCode: 400,
            body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'blocked by validation rule' }],
          };
        }
        // Realistic PROCESSING_HALTED semantics: with allOrNone every sibling
        // of the failure halts; without it, only steps that REFERENCE the
        // failed ref halt (the org can't resolve their token).
        const referencesFailed =
          failCompositeRef !== null &&
          (JSON.stringify(sub.body ?? {}).includes(`@{${failCompositeRef}.id}`) ||
            sub.url.includes(`@{${failCompositeRef}.id}`));
        if (failing && (body.allOrNone || referencesFailed)) {
          return {
            referenceId: sub.referenceId,
            httpStatusCode: 400,
            body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
          };
        }
        if (sub.method === 'POST') {
          minted += 1;
          return {
            referenceId: sub.referenceId,
            httpStatusCode: 201,
            body: { id: `001PLAN0000000${minted}AAA`, success: true, errors: [] },
          };
        }
        return { referenceId: sub.referenceId, httpStatusCode: 204, body: null };
      });
      // Top-level 200 even with failures — success lives per subrequest.
      return new Response(JSON.stringify({ compositeResponse }));
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM Account')) {
        return new Response(
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [
              {
                attributes: { type: 'Account', url: 'x' },
                Id: '001000000000001AAA',
                Name: 'Old Name',
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    return new Response('not found', { status: 404 });
  });
}

/** Pull the confirmation code out of the presented approval page HTML — the test plays the human. */
function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
}

/** Raw HTTP GET that bypasses the globally-stubbed fetch (used to hit the real approval server). */
function httpGet(urlStr: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = httpMod.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-deploy-'));
  process.env.CONTRAIL_DATA_DIR = tmp; // deploysDir() writes under here
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  presentedPages = [];
  openedUrls = [];
  deployCounter = { validations: 0, realDeploys: 0, quickDeploys: 0 };
  lastQuickValidationId = '';
  failNextQuickDeploy = false;
  failCompositeRef = null;
  lastCompositeBody = null;
  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  grants.data_read = true;
  grants.data_write = true;
  // no diagnostics_read — the withholding test depends on it
  const conn = db.insertConnection({
    alias: 'deploy-org',
    instanceUrl: 'https://deploy.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Deploy Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT');
  // read-only connection for gate tests
  const roGrants = emptyGrantSet();
  roGrants.metadata_read = true;
  db.insertConnection({
    alias: 'read-only',
    instanceUrl: 'https://ro.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'RO',
    orgType: 'production',
    isSandbox: false,
    username: null,
    userId: null,
    grants: roGrants,
  });
  // snapshot with the object so change analysis sees a modify
  store.writeCurrent(connId, new Map([['objects/Invoice__c.object', strToU8(INVOICE_OBJECT_XML)]]));
  db.replaceArtifactsForTypes(connId, ['CustomObject', 'CustomField'], [
    {
      connectionId: connId,
      type: 'CustomObject',
      apiName: 'Invoice__c',
      filePath: 'objects/Invoice__c.object',
      contentHash: 'h',
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt: '2026-08-07T00:00:00.000Z',
      content: INVOICE_OBJECT_XML,
    },
    {
      connectionId: connId,
      type: 'CustomField',
      apiName: 'Invoice__c.Status__c',
      filePath: 'objects/Invoice__c.object',
      contentHash: 'h2',
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt: '2026-08-07T00:00:00.000Z',
      content: '',
    },
  ]);
  db.replaceEdges(connId, 'extractor', ['Flow'], [
    {
      connectionId: connId,
      fromType: 'Flow',
      fromName: 'Send_Invoice',
      toType: 'CustomField',
      toName: 'Invoice__c.Status__c',
      source: 'extractor',
    },
  ]);
  stubSalesforce();

  const approvals = new ApprovalPageServer(async (url) => {
    openedUrls.push(url);
  });
  // capture rendered pages: wrap present()
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
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store,
    approvals,
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
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FIELD_BLOCK = `<fields>
        <fullName>Status__c</fullName>
        <type>Text</type>
    </fields>`;

async function validate(extra: Record<string, unknown> = {}) {
  return client.callTool({
    name: 'validate_deploy',
    arguments: {
      connection: 'deploy-org',
      components: [{ type: 'CustomField', api_name: 'Invoice__c.Status__c', content: FIELD_BLOCK }],
      ...extra,
    },
  });
}

describe('buildDeployZip', () => {
  it('wraps children, generates manifests and meta files', () => {
    const built = buildDeployZip(
      [
        { type: 'ApexClass', api_name: 'Foo', content: 'public class Foo {}' },
        { type: 'CustomField', api_name: 'Invoice__c.Amount__c', content: '<fields><fullName>Amount__c</fullName></fields>' },
      ],
      [{ type: 'Flow', api_name: 'Old_Flow' }],
      '63.0',
      () => null,
    );
    const entries = Object.keys(unzipSync(new Uint8Array(built.zip))).sort();
    expect(entries).toEqual([
      'classes/Foo.cls',
      'classes/Foo.cls-meta.xml',
      'destructiveChangesPost.xml',
      'objects/Invoice__c.object',
      'package.xml',
    ]);
    expect(built.packageXml).toContain('<members>Invoice__c.Amount__c</members>');
    expect(built.packageXml).toContain('<name>CustomField</name>');
    expect(built.destructiveXml).toContain('<members>Old_Flow</members>');
  });

  it('refuses path-traversal component names', () => {
    expect(() =>
      buildDeployZip(
        [{ type: 'ApexClass', api_name: '../../evil', content: 'x' }],
        [],
        '63.0',
        () => null,
      ),
    ).toThrow(/invalid component name/);
  });

  it('supports native Profile, CustomTab, and FlowDefinition deploys', () => {
    const built = buildDeployZip(
      [
        { type: 'Profile', api_name: 'Admin', content: '<Profile xmlns="x"/>' },
        { type: 'CustomTab', api_name: 'Test_Widget__c', content: '<CustomTab xmlns="x"/>' },
        { type: 'FlowDefinition', api_name: 'My_Flow', content: '<FlowDefinition xmlns="x"/>' },
      ],
      [],
      '63.0',
      () => null,
    );
    expect(built.files).toContain('profiles/Admin.profile');
    expect(built.files).toContain('tabs/Test_Widget__c.tab');
    expect(built.files).toContain('flowDefinitions/My_Flow.flowDefinition');
    expect(built.packageXml).toContain('<name>FlowDefinition</name>');
  });
});

describe('deploy SOAP DeployOptions ordering', () => {
  it('emits runTests before singlePackage before testLevel (WSDL sequence)', async () => {
    await validate({ test_level: 'RunSpecifiedTests', run_tests: ['InvoiceServiceTest'] });
    const code = codeFromPage(presentedPages[0]!);
    await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const iRun = lastDeployBody.indexOf('<met:runTests>');
    const iSingle = lastDeployBody.indexOf('<met:singlePackage>');
    const iLevel = lastDeployBody.indexOf('<met:testLevel>');
    expect(iRun).toBeGreaterThan(-1);
    expect(iRun).toBeLessThan(iSingle);
    expect(iSingle).toBeLessThan(iLevel);
  });
});

describe('confirmation codes', () => {
  it('generates unambiguous XXXX-XXXX codes', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateConfirmationCode()).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    }
  });
});

describe('validate_deploy', () => {
  it('returns the full summary WITHOUT the code; the code renders only on the approval page', async () => {
    const result = await validate();
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Validation passed');
    expect(text).toContain('blast_radius');
    expect(text).toContain('Send_Invoice'); // blast radius names the dependent flow
    expect(presentedPages).toHaveLength(1);
    const code = codeFromPage(presentedPages[0]!);
    expect(text).not.toContain(code); // THE invariant
    expect(openedUrls).toHaveLength(1);
    expect(text).not.toContain(openedUrls[0]); // opened browser → URL withheld too
  });

  it('withholds test failure detail without diagnostics_read but keeps the counts', async () => {
    failNextValidation = true;
    const result = await validate();
    const text = textOf(result);
    expect(text).toContain('Validation FAILED');
    expect(text).toContain('"test_failures": 1');
    expect(text).toContain('diagnostics_read');
    expect(text).not.toContain('Assertion failed: expected 5, got 4');
    expect(text).not.toContain('stackTrace');
  });

  it('flags field type changes as possible data loss', async () => {
    const result = await validate(); // Picklist → Text vs snapshot
    expect(textOf(result)).toContain('FIELD TYPE CHANGE Picklist → Text');
  });

  it('warns when a package adds components that need permissions but grants none', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          {
            type: 'CustomObject',
            api_name: 'Test_Widget__c',
            content: '<?xml version="1.0"?><CustomObject xmlns="x"><label>W</label></CustomObject>',
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as {
      permission_warning: string | null;
    };
    expect(parsed.permission_warning).toBeTruthy();
    expect(parsed.permission_warning).toContain('no');
    expect(presentedPages.at(-1)).toContain('invisible or inaccessible');
  });

  it('flags inline object fields that lack FLS even when object perms are granted', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          {
            type: 'CustomObject',
            api_name: 'Gadget__c',
            content:
              '<?xml version="1.0"?><CustomObject xmlns="x"><label>G</label>' +
              '<fields><fullName>Serial__c</fullName><type>Text</type></fields></CustomObject>',
          },
          {
            type: 'PermissionSet',
            api_name: 'G_Access',
            content:
              '<?xml version="1.0"?><PermissionSet xmlns="x"><label>G</label>' +
              '<objectPermissions><allowRead>true</allowRead><object>Gadget__c</object></objectPermissions></PermissionSet>',
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as {
      permission_warning: string | null;
    };
    // Object perms are granted, but the inline Serial__c field has no FLS → warn.
    expect(parsed.permission_warning).toContain('Gadget__c.Serial__c');
  });

  it('does not count a disabled grant (readable=false) as coverage', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          { type: 'CustomField', api_name: 'Account.Foo__c', content: '<fields><fullName>Foo__c</fullName></fields>' },
          {
            type: 'PermissionSet',
            api_name: 'F_Access',
            content:
              '<?xml version="1.0"?><PermissionSet xmlns="x"><label>F</label>' +
              '<fieldPermissions><editable>false</editable><field>Account.Foo__c</field><readable>false</readable></fieldPermissions></PermissionSet>',
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as {
      permission_warning: string | null;
    };
    expect(parsed.permission_warning).toContain('Account.Foo__c');
  });

  it('does not warn when the package grants permissions for the new component', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          {
            type: 'CustomObject',
            api_name: 'Test_Widget__c',
            content: '<?xml version="1.0"?><CustomObject xmlns="x"><label>W</label></CustomObject>',
          },
          {
            type: 'PermissionSet',
            api_name: 'W_Access',
            content:
              '<?xml version="1.0"?><PermissionSet xmlns="x"><label>W</label>' +
              '<objectPermissions><allowRead>true</allowRead><object>Test_Widget__c</object></objectPermissions></PermissionSet>',
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as {
      permission_warning: string | null;
    };
    expect(parsed.permission_warning).toBeNull();
  });

  it('refuses without metadata_write and audits', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'read-only',
        components: [{ type: 'ApexClass', api_name: 'X', content: 'public class X {}' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_write');
    expect(
      db
        .queryAuditEvents({})
        .some((e) => e.eventType === 'grant.refused' && e.tool === 'validate_deploy'),
    ).toBe(true);
  });
});

describe('execute_deploy code lifecycle', () => {
  it('executes with the human-read code exactly once', async () => {
    await validate();
    const code = codeFromPage(presentedPages[0]!);

    const exec = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const text = textOf(exec);
    expect(text).toContain('"deployed": true');
    expect(deployCounter.realDeploys).toBe(1);

    // single-use: the same code cannot drive a SECOND deploy (it returns the
    // stored terminal result, not a fresh execution)
    const again = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(textOf(again)).toContain('already_completed');
    expect(deployCounter.realDeploys).toBe(1);

    const events = db.queryAuditEvents({}).map((e) => e.eventType);
    expect(events).toContain('deploy.validated');
    expect(events).toContain('deploy.executed');
  });

  it('refuses a wrong code without touching the org, and audits', async () => {
    await validate();
    const exec = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: 'XXXX-XXXX' },
    });
    expect(exec.isError).toBe(true);
    expect(deployCounter.realDeploys).toBe(0);
    expect(
      db.queryAuditEvents({}).some(
        (e) => e.eventType === 'deploy.refused' && e.detail?.reason === 'no_matching_code',
      ),
    ).toBe(true);
  });

  it('locks the pending code after too many wrong guesses (brute-force guard)', async () => {
    await validate();
    const code = codeFromPage(presentedPages[0]!);
    // maxFailedAttempts defaults to 5 → the 5th wrong guess locks it.
    for (let i = 0; i < 4; i++) {
      const r = await client.callTool({
        name: 'execute_deploy',
        arguments: { connection: 'deploy-org', confirmation_code: `WRONG-CD${i}` },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/attempt\(s\) remain/);
    }
    const fifth = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: 'WRONG-CDX' },
    });
    expect(textOf(fifth)).toContain('locked');

    // Even the CORRECT code no longer works — the human must re-validate.
    const correct = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(correct.isError).toBe(true);
    expect(textOf(correct)).toContain('locked');
    expect(deployCounter.realDeploys).toBe(0);
    expect(
      db
        .queryAuditEvents({})
        .some((e) => e.eventType === 'deploy.refused' && e.detail?.reason === 'too_many_attempts'),
    ).toBe(true);
  });

  it('a new validation supersedes the previous code', async () => {
    await validate();
    const firstCode = codeFromPage(presentedPages[0]!);
    await validate();
    const exec = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: firstCode },
    });
    expect(exec.isError).toBe(true);
    expect(deployCounter.realDeploys).toBe(0);
    // the fresh code still works
    const secondCode = codeFromPage(presentedPages[1]!);
    const exec2 = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: secondCode },
    });
    expect(textOf(exec2)).toContain('"deployed": true');
  });

  it('expired codes are refused and marked', async () => {
    await validate();
    const code = codeFromPage(presentedPages[0]!);
    const req = db.findRequestByCode(connId, 'deploy', code)!;
    // rewind expires_at directly on the underlying table
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(tmp, 'test.db'));
    raw.prepare(`UPDATE deploy_requests SET expires_at = ? WHERE id = ?`).run(
      '2020-01-01T00:00:00.000Z',
      req.id,
    );
    raw.close();
    const exec = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain('expired');
    expect(deployCounter.realDeploys).toBe(0);
  });

  it('re-executing after completion returns the stored result, not an error or a second deploy', async () => {
    await validate();
    const code = codeFromPage(presentedPages[0]!);
    const first = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(textOf(first)).toContain('"deployed": true');
    expect(deployCounter.realDeploys).toBe(1);
    // A late poll with the same code: terminal result, no error, no re-deploy.
    const late = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(late.isError).not.toBe(true);
    expect(textOf(late)).toContain('already_completed');
    expect(deployCounter.realDeploys).toBe(1);
  });

  it('concurrent execute_deploy with one code dispatches exactly one deploy', async () => {
    await validate();
    const code = codeFromPage(presentedPages[0]!);
    const [a, b] = await Promise.all([
      client.callTool({
        name: 'execute_deploy',
        arguments: { connection: 'deploy-org', confirmation_code: code },
      }),
      client.callTool({
        name: 'execute_deploy',
        arguments: { connection: 'deploy-org', confirmation_code: code },
      }),
    ]);
    expect(deployCounter.realDeploys).toBe(1);
    // neither call errored; at most one reports a fresh deploy
    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
  });
});

describe('approval URL is never handed to the agent', () => {
  it('withholds the approval URL when the browser fails to open', async () => {
    // An approvals server whose browser-open always throws.
    const failing = new ApprovalPageServer(async () => {
      throw new Error('no display');
    });
    const capturedPages: string[] = [];
    const origPresent = failing.present.bind(failing);
    failing.present = async (html: string) => {
      capturedPages.push(html);
      return origPresent(html);
    };
    const tokens2 = new MemoryTokenStore();
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    grants.metadata_write = true;
    const db2 = new ContrailDb(path.join(tmp, 'test2.db'));
    const conn2 = db2.insertConnection({
      alias: 'headless-org',
      instanceUrl: 'https://deploy.stub.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00D9',
      orgName: 'Headless',
      orgType: 'developer',
      isSandbox: false,
      username: null,
      userId: null,
      grants,
    });
    tokens2.setRefreshToken(conn2.id, 'RT');
    const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
      salesforce: { ...DEFAULT_CONFIG.salesforce },
      oauth: { ...DEFAULT_CONFIG.oauth },
      snapshot: { ...DEFAULT_CONFIG.snapshot },
      deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
    };
    const deps2 = createDeps({
      db: db2,
      tokens: tokens2,
      config,
      store: new SnapshotStore(path.join(tmp, 'snap2')),
      approvals: failing,
      flowOps: {
        exchangeCode: async () => {
          throw new Error('x');
        },
        fetchOrgInfo: async () => {
          throw new Error('x');
        },
        fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
        revokeToken: async () => ({ ok: true }),
        openBrowser: async () => {},
      },
    });
    const server2 = createServer(deps2);
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server2.connect(st2);
    const client2 = new Client({ name: 't2', version: '0' });
    await client2.connect(ct2);

    const result = await client2.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'headless-org',
        components: [{ type: 'ApexClass', api_name: 'Foo', content: 'public class Foo {}' }],
      },
    });
    const text = textOf(result);
    expect(text).toContain('"opened": false');
    const code = codeFromPage(capturedPages[0]!);
    // The critical invariant: neither the code nor the localhost URL reaches the agent.
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/http:\/\/localhost:\d+/);
    expect(text).not.toContain('/approve?s=');
    await client2.close();
    db2.close();
  });
});

describe('flow deactivation (P0.6)', () => {
  it('does NOT auto-inject a deactivation when deleting a flow (checkOnly cannot apply it)', async () => {
    // Deleting a flow: the deploy carries only the destructive Flow, no synthetic
    // FlowDefinition. (The stub returns success, so this validates; the point is
    // that no deactivation is injected — that approach never clears checkOnly live.)
    await client.callTool({
      name: 'validate_deploy',
      arguments: { connection: 'deploy-org', destructive: [{ type: 'Flow', api_name: 'My_Flow' }] },
    });
    // The built package has no flowDefinitions entry (proven at the builder level).
    const built = buildDeployZip([], [{ type: 'Flow', api_name: 'My_Flow' }], '63.0', () => null);
    expect(built.files.some((f) => f.startsWith('flowDefinitions/'))).toBe(false);
    expect(built.destructiveXml).toContain('<members>My_Flow</members>');
  });

  it('passes a version-qualified flow member straight through (no invalid FlowDefinition)', async () => {
    // "My_Flow-2" is a specific version, deletable without deactivation; the old
    // auto-injection would have emitted an invalid FlowDefinition for it.
    const built = buildDeployZip([], [{ type: 'Flow', api_name: 'My_Flow-2' }], '63.0', () => null);
    expect(built.files.some((f) => f.startsWith('flowDefinitions/'))).toBe(false);
    expect(built.destructiveXml).toContain('<members>My_Flow-2</members>');
  });

  it('gives honest flow-deletion guidance when a destructive flow delete fails', async () => {
    failNextValidation = true;
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: { connection: 'deploy-org', destructive: [{ type: 'Flow', api_name: 'My_Flow' }] },
    });
    const text = textOf(result);
    expect(text).toContain('Validation FAILED');
    expect(text).toContain('deactivate_flow');
    expect(text).toContain('Setup');
  });

  it('deactivate_flow validates a standalone deactivation and routes through approval', async () => {
    const result = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'deploy-org', flow: 'My_Flow' },
    });
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('validated');
    const parsed = JSON.parse(text.split('\n').slice(1).join('\n')) as {
      changes: Array<{ type: string; api_name: string; warnings: string[] }>;
    };
    const change = parsed.changes.find((c) => c.type === 'FlowDefinition' && c.api_name === 'My_Flow');
    expect(change).toBeTruthy();
    // Clearly labeled as a deactivation, not a mysterious "ADD".
    expect(change!.warnings.join(' ')).toContain('DEACTIVATES flow My_Flow');
    // Code stays on the approval page, not in the tool result.
    const code = codeFromPage(presentedPages.at(-1)!);
    expect(text).not.toContain(code);
  });

  it('deactivate_flow surfaces flow dependents in the blast radius (Flow-typed lookup)', async () => {
    // Something depends on My_Flow (edge stored under type 'Flow').
    db.replaceEdges(connId, 'extractor', ['Flow'], [
      {
        connectionId: connId,
        fromType: 'Flow',
        fromName: 'Caller_Flow',
        toType: 'Flow',
        toName: 'My_Flow',
        source: 'extractor',
      },
    ]);
    const result = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'deploy-org', flow: 'My_Flow' },
    });
    const parsed = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as {
      blast_radius: string[];
    };
    expect(parsed.blast_radius.join(' ')).toContain('Caller_Flow');
  });

  it('deactivate_flow refuses without metadata_write', async () => {
    const result = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'read-only', flow: 'My_Flow' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_write');
  });
});

describe('approval page staleness', () => {
  it('reports active while validated and inactive after execution', async () => {
    await validate();
    const approveUrl = openedUrls.at(-1)!;
    const statusUrl = approveUrl.replace('/approve', '/status');

    const before = JSON.parse((await httpGet(statusUrl)).body);
    expect(before).toMatchObject({ active: true, status: 'validated' });

    // The served page carries the self-invalidation poll.
    const pageHtml = (await httpGet(approveUrl)).body;
    expect(pageHtml).toContain("fetch('/status'");

    const code = codeFromPage(presentedPages.at(-1)!);
    await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });

    const after = JSON.parse((await httpGet(statusUrl)).body);
    expect(after).toMatchObject({ active: false, status: 'executed' });
  });
});

describe('dml two-step', () => {
  it('proposes with before/after preview and executes with the page code', async () => {
    const propose = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'update',
        object: 'Account',
        records: [{ Id: '001000000000001AAA', Name: 'New Name' }],
      },
    });
    const proposeText = textOf(propose);
    // JSON-encoded label: quotes inside are escaped
    expect(proposeText).toContain('Old Name');
    expect(proposeText).toContain('New Name');
    expect(proposeText).toContain('→');
    const code = codeFromPage(presentedPages.at(-1)!);
    expect(proposeText).not.toContain(code);

    const exec = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const execText = textOf(exec);
    expect(execText).toContain('"executed": true');
    expect(execText).toContain('"rows": 1');
    expect(db.queryAuditEvents({}).map((e) => e.eventType)).toContain('dml.executed');
  });

  it('refuses __mdt objects on the flat path with a pointer to the metadata route (S19)', async () => {
    const result = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'insert',
        object: 'Trigger_Action__mdt',
        records: [{ Label: 'Nope' }],
      },
    });
    const text = textOf(result);
    expect(text).toMatch(/METADATA, not data/);
    expect(text).toMatch(/CustomMetadata/);
    expect(text).toMatch(/<Type>\.<Record>/);
  });

  it('deletes render in the destructive section of the approval page', async () => {
    await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'delete',
        object: 'Account',
        ids: ['001000000000001AAA'],
      },
    });
    const page = presentedPages.at(-1)!;
    expect(page).toContain('Destructive changes');
    expect(page).toContain('DELETE Account 001000000000001AAA');
  });

  it('refuses dml_propose without data_write', async () => {
    const result = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'read-only',
        operation: 'insert',
        object: 'Account',
        records: [{ Name: 'X' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('data_write');
  });
});

/**
 * Deploy-from-file. The motivating failure: a 133 KB flow cannot be re-emitted
 * as a tool argument byte-exactly, and one transposed character in flow XML is
 * either a failed deploy or a silently wrong behaviour. So the bytes travel by
 * path instead — and the tests below check the bytes that reach the package,
 * not just that the call succeeded.
 */
describe('validate_deploy from a file on disk', () => {
  function stagingFile(name: string, content: string): string {
    const dir = path.join(tmp, 'staging');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  /** The exact bytes the built package holds for one member. */
  function deployedFile(entryName: string): string {
    const b64 = /<met:ZipFile>([^<]+)<\/met:ZipFile>/.exec(lastDeployBody)?.[1] ?? '';
    const entries = unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));
    const key = Object.keys(entries).find((k) => k.endsWith(entryName));
    return key ? Buffer.from(entries[key]!).toString('utf8') : '';
  }

  it('deploys the file’s bytes exactly — including the characters a model would mangle', async () => {
    // Non-ASCII, tabs, CRLF, trailing space: everything that survives a file
    // read and does not reliably survive being retyped.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
      '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\r\n' +
      '\t<label>Fáçade — “quoted”   </label>\r\n' +
      `\t<description>${'long '.repeat(2000)}</description>\r\n` +
      '</CustomObject>';
    const file = stagingFile('Test_Widget__c.object', xml);

    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          { type: 'CustomObject', api_name: 'Test_Widget__c', content_file: file },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(deployedFile('Test_Widget__c.object')).toBe(xml);
  });

  it('shows the human which file and fingerprint they are approving', async () => {
    const file = stagingFile('Approve_Me__c.object', '<CustomObject><label>A</label></CustomObject>');
    await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [{ type: 'CustomObject', api_name: 'Approve_Me__c', content_file: file }],
      },
    });
    const page = presentedPages.at(-1) ?? '';
    // The approver did not type these bytes, so the page must say where they came from.
    expect(page).toContain('staging');
    expect(page).toContain('Approve_Me__c.object');
    expect(page).toMatch(/sha256 [0-9a-f]{16}/);
  });

  it('refuses a path outside the allowed roots rather than deploying it', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-elsewhere-'));
    const secret = path.join(elsewhere, 'secrets.object');
    fs.writeFileSync(secret, 'ANTHROPIC_API_KEY=sk-ant-real', 'utf8');
    try {
      const result = await client.callTool({
        name: 'validate_deploy',
        arguments: {
          connection: 'deploy-org',
          components: [{ type: 'CustomObject', api_name: 'Test_Widget__c', content_file: secret }],
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/outside every allowed deploy source root/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses both content and content_file — it will not guess which one you meant', async () => {
    const file = stagingFile('Both__c.object', '<CustomObject/>');
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [
          {
            type: 'CustomObject',
            api_name: 'Test_Widget__c',
            content: '<CustomObject><label>different</label></CustomObject>',
            content_file: file,
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not both/);
  });

  it('refuses a component carrying neither, and points at the staging directory', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [{ type: 'CustomObject', api_name: 'Test_Widget__c' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/content or content_file/);
    expect(textOf(result)).toContain('staging');
  });

  it('freezes the bytes at validation — editing the file afterwards cannot change the deploy', async () => {
    const file = stagingFile('Frozen__c.object', '<CustomObject><label>APPROVED</label></CustomObject>');
    await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'deploy-org',
        components: [{ type: 'CustomObject', api_name: 'Frozen__c', content_file: file }],
      },
    });
    const code = codeFromPage(presentedPages.at(-1)!);

    // Swap the file for something the human never saw.
    fs.writeFileSync(file, '<CustomObject><label>SWAPPED</label></CustomObject>', 'utf8');

    const executed = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(executed.isError).not.toBe(true);
    // execute replays the stored package; the swap is invisible to it.
    expect(deployedFile('Frozen__c.object')).toContain('APPROVED');
    expect(deployedFile('Frozen__c.object')).not.toContain('SWAPPED');
  });
});

/**
 * Quick deploy (S10 parity with the desktop engine). A tests-ran validation
 * executes via deployRecentValidation — the zip is not re-sent; NoTestRun is
 * ineligible; an org-side refusal falls back to the full deploy and says so.
 * The approval ritual (code, page, claim machinery) is untouched.
 */
describe('quick deploy of a validated package', () => {
  async function approvedCode(extra: Record<string, unknown> = {}) {
    const result = await validate(extra);
    expect(result.isError).not.toBe(true);
    return codeFromPage(presentedPages.at(-1)!);
  }

  it('a tests-ran validation deploys via deployRecentValidation, not a fresh zip', async () => {
    const code = await approvedCode({ test_level: 'RunSpecifiedTests', run_tests: ['InvoiceServiceTest'] });
    const before = deployCounter.realDeploys;
    const result = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(result.isError).not.toBe(true);
    expect(deployCounter.quickDeploys).toBe(1);
    expect(deployCounter.realDeploys).toBe(before);
    expect(lastQuickValidationId).toMatch(/^0Af-check/);
    expect(textOf(result)).toContain('"quick_deploy": true');
  });

  it('a NoTestRun validation deploys the stored zip classically', async () => {
    const code = await approvedCode();
    await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(deployCounter.quickDeploys).toBe(0);
    expect(deployCounter.realDeploys).toBe(1);
  });

  it('an org-side refusal falls back to the zip and reports it — never a dead end', async () => {
    const code = await approvedCode({ test_level: 'RunSpecifiedTests', run_tests: ['InvoiceServiceTest'] });
    failNextQuickDeploy = true;
    const result = await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(result.isError).not.toBe(true);
    expect(deployCounter.realDeploys).toBe(1);
    expect(textOf(result)).toContain('"quick_deploy": false');
    expect(textOf(result)).toContain('quick_deploy_fallback');
  });
});

/**
 * S14 — multi-step DML plans. The invariant set: ONE code approves an ordered
 * chain; reference tokens reach the org VERBATIM (the org substitutes, ids
 * never transit the agent); the approval page tells the truth about the
 * atomicity mode; delete steps land in the danger card; and the reference
 * grammar is validated shut before anything is staged.
 */
describe('multi-step dml plans', () => {
  const FIVE_STEP_PLAN = [
    { ref: 'acct', operation: 'insert', object: 'Account', record: { Name: 'Plan Test Account' } },
    {
      ref: 'con',
      operation: 'insert',
      object: 'Contact',
      record: { LastName: 'PlanTest', AccountId: '@{acct.id}' },
    },
    {
      ref: 'opp',
      operation: 'insert',
      object: 'Opportunity',
      record: { Name: 'Plan Opp', StageName: 'Prospecting', AccountId: '@{acct.id}' },
    },
    {
      operation: 'insert',
      object: 'OpportunityContactRole',
      record: { OpportunityId: '@{opp.id}', ContactId: '@{con.id}', Role: 'Decision Maker' },
    },
    {
      operation: 'update',
      object: 'Opportunity',
      id: '@{opp.id}',
      record: { StageName: 'Qualification' },
    },
  ];

  async function proposePlan(extra: Record<string, unknown> = {}) {
    return client.callTool({
      name: 'dml_propose',
      arguments: { connection: 'deploy-org', steps: FIVE_STEP_PLAN, ...extra },
    });
  }

  it('the 5-step use case: one page, one code, tokens sent verbatim, ids returned', async () => {
    const propose = await proposePlan();
    expect(propose.isError).not.toBe(true);
    const proposeText = textOf(propose);
    const page = presentedPages.at(-1)!;
    const code = codeFromPage(page);
    expect(proposeText).not.toContain(code); // THE invariant
    // The page walks every step, symbolically for references.
    expect(page).toContain('Step 1 · INSERT Account');
    expect(page).toContain('Step 4 · INSERT OpportunityContactRole');
    expect(page).toContain('Step 5 · UPDATE Opportunity');
    expect(page).toContain('new Account from step 1');
    expect(page).toContain('all-or-none (any failure rolls back every step)');

    const exec = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const execText = textOf(exec);
    expect(execText).toContain('"executed": true');
    // The org received the tokens UNRESOLVED — substitution is Salesforce's.
    const sent = JSON.stringify(lastCompositeBody);
    expect(sent).toContain('@{acct.id}');
    expect(sent).toContain('@{opp.id}');
    expect(lastCompositeBody!.compositeRequest.map((s) => s.referenceId).slice(0, 3)).toEqual([
      'acct',
      'con',
      'opp',
    ]);
    // Created ids come back, keyed by ref.
    expect(execText).toContain('"acct"');
    expect(execText).toContain('001PLAN0000000');
    expect(db.queryAuditEvents({}).map((e) => e.eventType)).toContain('dml.executed');
  });

  it('the page is honest about continue-on-failure mode', async () => {
    await proposePlan({ all_or_none: false });
    const page = presentedPages.at(-1)!;
    expect(page).toContain('continue-on-failure');
    expect(page).toContain('KEPT');
    expect(page).not.toContain('rolls back every step');
    expect(page).toContain('NOT atomic');
  });

  it('a mixed plan routes delete steps to the destructive card', async () => {
    await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'Keep' } },
          { operation: 'delete', object: 'Account', id: '001000000000001AAA' },
        ],
      },
    });
    const page = presentedPages.at(-1)!;
    expect(page).toContain('Destructive changes');
    expect(page).toContain('Step 2 · DELETE Account');
    expect(page).toContain('Step 1 · INSERT Account');
  });

  it('all-or-none failure: everything reports rolled back, nothing "executed"', async () => {
    await proposePlan();
    const code = codeFromPage(presentedPages.at(-1)!);
    failCompositeRef = 'opp';
    const exec = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const text = textOf(exec);
    expect(text).toContain('"executed": false');
    expect(text).toContain('rolled_back');
    expect(text).toContain('rolled back');
    expect(text).not.toContain('"id": "001PLAN'); // no ids from a rolled-back plan
  });

  it('continue-on-failure: independent steps keep their ids, dependents fail honestly', async () => {
    await proposePlan({ all_or_none: false });
    const code = codeFromPage(presentedPages.at(-1)!);
    failCompositeRef = 'opp';
    const exec = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    const text = textOf(exec);
    expect(text).toContain('"executed": false');
    // Account + Contact (independent of opp) succeeded and kept their ids…
    expect(text).toContain('"acct"');
    expect(text).toContain('"con"');
    // …while the OCR and the update, which reference opp, are dependent failures.
    expect(text).toContain('dependent_failed');
    expect(text).toContain('KEPT');
  });

  it('the reference grammar is validated shut', async () => {
    const cases: Array<{ steps: unknown[]; want: RegExp }> = [
      {
        // forward reference
        steps: [
          { operation: 'insert', object: 'Contact', record: { AccountId: '@{acct.id}' } },
          { ref: 'acct', operation: 'insert', object: 'Account', record: { Name: 'X' } },
        ],
        want: /not an EARLIER insert/,
      },
      {
        // ref to a non-insert step
        steps: [
          { ref: 'upd', operation: 'update', object: 'Account', id: '001000000000001AAA', record: { Name: 'Y' } },
          { operation: 'insert', object: 'Contact', record: { AccountId: '@{upd.id}' } },
        ],
        want: /not an EARLIER insert/,
      },
      {
        // unknown ref
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { operation: 'insert', object: 'Contact', record: { AccountId: '@{ghost.id}' } },
        ],
        want: /not an EARLIER insert/,
      },
      {
        // Id inside an update record
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { operation: 'update', object: 'Account', id: '@{a.id}', record: { Id: '001000000000001AAA', Name: 'Y' } },
        ],
        want: /never put Id inside record/,
      },
      {
        // stray non-token @{…} value
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { operation: 'insert', object: 'Contact', record: { Description: 'see @{a.id} above', LastName: 'Z' } },
        ],
        want: /whole-value/,
      },
      {
        // custom metadata records are metadata, not data (S19)
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { operation: 'insert', object: 'Trigger_Action__mdt', record: { Label: 'Y' } },
        ],
        want: /METADATA, not data.*CustomMetadata/,
      },
      {
        // duplicate ref
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'Y' } },
        ],
        want: /duplicate ref/,
      },
    ];
    for (const c of cases) {
      const result = await client.callTool({
        name: 'dml_propose',
        arguments: { connection: 'deploy-org', steps: c.steps },
      });
      expect(result.isError, JSON.stringify(c.steps).slice(0, 80)).toBe(true);
      expect(textOf(result)).toMatch(c.want);
    }
  });

  it('tokens are refused in the FLAT shape, and plan+flat fields cannot mix', async () => {
    const flat = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'insert',
        object: 'Contact',
        records: [{ LastName: 'X', AccountId: '@{acct.id}' }],
      },
    });
    expect(flat.isError).toBe(true);
    expect(textOf(flat)).toMatch(/only valid inside a plan/);

    const mixed = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'insert',
        object: 'Account',
        steps: [
          { ref: 'a', operation: 'insert', object: 'Account', record: { Name: 'X' } },
          { operation: 'insert', object: 'Contact', record: { LastName: 'Y' } },
        ],
      },
    });
    expect(mixed.isError).toBe(true);
    expect(textOf(mixed)).toMatch(/not both/);
  });

  it('a plan supersedes a pending flat DML — one pending write per connection', async () => {
    await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'update',
        object: 'Account',
        records: [{ Id: '001000000000001AAA', Name: 'Flat Change' }],
      },
    });
    const flatCode = codeFromPage(presentedPages.at(-1)!);
    await proposePlan();
    const planCode = codeFromPage(presentedPages.at(-1)!);
    // The flat code died with the supersede; the plan code works.
    const stale = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: flatCode },
    });
    expect(stale.isError).toBe(true);
    const fresh = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: planCode },
    });
    expect(textOf(fresh)).toContain('"executed": true');
  });

  it('flat inserts now return created ids (the cleanup path needs them)', async () => {
    await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'deploy-org',
        operation: 'insert',
        object: 'Account',
        records: [{ Name: 'Flat Insert' }],
      },
    });
    const code = codeFromPage(presentedPages.at(-1)!);
    const exec = await client.callTool({
      name: 'dml_execute',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    expect(textOf(exec)).toContain('"created_ids"');
    expect(textOf(exec)).toContain('001NEW00000000');
  });
});

describe('test level: unspecified means OMITTED, never defaulted (prod NoTestRun trap)', () => {
  it('an omitted test_level sends NO <met:testLevel> element, at validate AND execute', async () => {
    const res = await validate();
    expect(textOf(res)).toContain('"test_level": null');
    expect(lastDeployBody).not.toContain('<met:testLevel>');

    const code = codeFromPage(presentedPages[0]!);
    await client.callTool({
      name: 'execute_deploy',
      arguments: { connection: 'deploy-org', confirmation_code: code },
    });
    // The execute replayed the same unspecified level — still no element.
    expect(lastDeployBody).not.toContain('<met:testLevel>');
    expect(deployCounter.realDeploys).toBe(1);
  });

  it('an explicit test_level still travels verbatim', async () => {
    const res = await validate({ test_level: 'RunLocalTests' });
    expect(res.isError ?? false).toBe(false);
    expect(lastDeployBody).toContain('<met:testLevel>RunLocalTests</met:testLevel>');
    expect(textOf(res)).toContain('"test_level": "RunLocalTests"');
  });

  it('deactivate_flow omits the level too — an explicit NoTestRun would brick prod deactivation', async () => {
    const res = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'deploy-org', flow: 'Old_Flow' },
    });
    expect(res.isError ?? false).toBe(false);
    expect(lastDeployBody).not.toContain('<met:testLevel>');
    expect(lastDeployBody).toContain('<met:checkOnly>true</met:checkOnly>');
  });
});
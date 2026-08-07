import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
let deployCounter: { validations: number; realDeploys: number };
let lastDeployBody = '';
let failNextValidation = false;

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
  const m = html.match(/class="code">([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
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
  deployCounter = { validations: 0, realDeploys: 0 };
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
  approvals.present = async (html: string) => {
    presentedPages.push(html);
    return origPresent(html);
  };

  const config: ContrailConfig = {
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

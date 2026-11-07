import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { ApprovalPageOptions } from '../connect/pages.js';

/**
 * S42: the phone ritual end to end. What these pin: a minted code goes to the
 * notifier with the SAME view the approval page rendered, the agent learns
 * only `phone_notification.status`, and the code stays out of every tool
 * result exactly as before; a dry run (no code) notifies nobody; a notifier
 * that throws cannot fail the proposal; the audit trail records outcome
 * categories only.
 */

class RecordingNotifier implements ApprovalNotifier {
  calls: Array<{ view: ApprovalPageOptions; includeCode: boolean }> = [];
  behaviour: 'sent' | 'throw' | 'fail' = 'sent';
  async notify(view: ApprovalPageOptions, opts: { includeCode: boolean }): Promise<NotifyOutcome> {
    this.calls.push({ view, includeCode: opts.includeCode });
    if (this.behaviour === 'throw') throw new Error(`boom ${view.code}`);
    if (this.behaviour === 'fail') return { status: 'failed', reason: 'rejected' };
    return { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: 'pushover' as const, configured: true };
  }
  resetCircuit() {}
}

let tmp: string;
let db: ContrailDb;
let client: Client;
let presentedPages: string[];
let notifier: RecordingNotifier;

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function stubSalesforce(): void {
  let deploys = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://phone.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DP/005P',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        deploys += 1;
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af-phone-${deploys}</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>
                 <done>true</done><status>Succeeded</status>
                 <success>true</success><checkOnly>true</checkOnly>
                 <numberComponentsTotal>1</numberComponentsTotal>
                 <numberComponentsDeployed>1</numberComponentsDeployed>
                 <numberComponentErrors>0</numberComponentErrors>
                 <numberTestsTotal>0</numberTestsTotal>
                 <numberTestsCompleted>0</numberTestsCompleted>
                 <numberTestErrors>0</numberTestErrors>
                 <details><runTestResult><numTestsRun>0</numTestsRun>
                   <numFailures>0</numFailures></runTestResult></details>
               </result>
             </checkDeployStatusResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    if (url.includes('/composite/sobjects') || url.includes('/sobjects/')) {
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    if (url.includes('/query')) {
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-phone-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presentedPages = [];
  notifier = new RecordingNotifier();

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  grants.data_read = true;
  grants.data_write = true;
  const conn = db.insertConnection({
    alias: 'phone-org',
    instanceUrl: 'https://phone.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DP',
    orgName: 'Phone',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  stubSalesforce();

  const approvals = new ApprovalPageServer(async () => {});
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (html: string, statusCheck?: () => { active: boolean; status: string }) => {
    presentedPages.push(html);
    return origPresent(html, statusCheck);
  };

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5 },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
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
  client = new Client({ name: 'phone-test', version: '0.0.0' });
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

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code on page');
  return m[1]!;
}

async function validate(extra: Record<string, unknown> = {}) {
  return client.callTool({
    name: 'validate_deploy',
    arguments: {
      connection: 'phone-org',
      components: [{ type: 'FlexiPage', api_name: 'Phone_Page', content: '<FlexiPage/>' }],
      ...extra,
    },
  });
}

describe('S42: the phone copy of a minted code', () => {
  it('validate → the notifier gets the SAME view as the page, with the code; the agent gets status only', async () => {
    const result = await validate();
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(presentedPages).toHaveLength(1);
    const code = codeFromPage(presentedPages[0]!);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.includeCode).toBe(true); // plugin presents a PAGE, so the phone carries the code
    expect(notifier.calls[0]!.view.code).toBe(code);
    expect(notifier.calls[0]!.view.kind).toBe('deploy');
    expect(notifier.calls[0]!.view.org.alias).toBe('phone-org');
    expect(notifier.calls[0]!.view.changes[0]!.label).toContain('FlexiPage:Phone_Page');

    expect(text).toContain('"phone_notification"');
    expect(text).toContain('"status": "sent"');
    expect(text).not.toContain(code); // THE invariant, unchanged by S42
    expect(text).toContain('still only counts when the human types it');

    const events = db.queryAuditEvents({}).map((e) => e.eventType);
    expect(events).toContain('approval.notified');
    expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(code);
  });

  it('a dry run mints no code and notifies nobody', async () => {
    const result = await validate({ dry_run: true });
    expect(result.isError ?? false).toBe(false);
    expect(presentedPages).toHaveLength(0);
    expect(notifier.calls).toHaveLength(0);
    expect(textOf(result)).not.toContain('phone_notification');
  });

  it('a notifier that throws cannot fail the proposal; the failure is a category, never its message', async () => {
    notifier.behaviour = 'throw';
    const result = await validate();
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(text).toContain('"status": "failed"');
    expect(text).toContain('"reason": "network"');
    expect(text).not.toContain('boom'); // the thrown message (which carried the code) stays in the log
    expect(text).not.toContain(codeFromPage(presentedPages[0]!));
    const failures = db.queryAuditEvents({}).filter((e) => e.eventType === 'approval.notify_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.detail).toMatchObject({ kind: 'deploy', reason: 'network' });
  });

  it('a rejected send reports its reason and points the agent at open_settings', async () => {
    notifier.behaviour = 'fail';
    const text = textOf(await validate());
    expect(text).toContain('"reason": "rejected"');
    expect(text).toContain('open_settings');
    expect(text).toContain("The code is only on the approval page in the human's browser.");
  });

  it('dml_propose notifies too — every code-minting kind rides the same seam', async () => {
    const result = await client.callTool({
      name: 'dml_propose',
      arguments: {
        connection: 'phone-org',
        operation: 'insert',
        object: 'Account',
        records: [{ Name: 'Phone Co' }],
      },
    });
    expect(result.isError ?? false).toBe(false);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.view.kind).toBe('dml');
    expect(notifier.calls[0]!.view.code).toBe(codeFromPage(presentedPages[0]!));
    expect(textOf(result)).toContain('"phone_notification"');
    expect(textOf(result)).not.toContain(notifier.calls[0]!.view.code);
  });
});

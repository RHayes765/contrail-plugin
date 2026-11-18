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
import {
  FREEZE_TAIL,
  composePushover,
  type ApprovalNotifier,
  type ApprovalNotifyOptions,
  type NotifyOutcome,
} from '../core/notify.js';
import { RemoteControlProbe } from '../core/remoteControl.js';
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
  calls: Array<{ view: ApprovalPageOptions; includeCode: boolean; opts: ApprovalNotifyOptions }> = [];
  behaviour: 'sent' | 'throw' | 'fail' = 'sent';
  method: 'pushover' | 'none' = 'pushover';
  async notify(view: ApprovalPageOptions, opts: ApprovalNotifyOptions): Promise<NotifyOutcome> {
    this.calls.push({ view, includeCode: opts.includeCode, opts });
    if (this.method === 'none') return { status: 'off' };
    if (this.behaviour === 'throw') throw new Error(`boom ${view.code}`);
    if (this.behaviour === 'fail') return { status: 'failed', reason: 'rejected' };
    return { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: this.method, when: config.notifications.when, configured: true };
  }
  resetCircuit() {}
}

let tmp: string;
let db: ContrailDb;
let client: Client;
let presentedPages: string[];
let notifier: RecordingNotifier;
let config: ContrailConfig;
let probe: RemoteControlProbe;

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

  // S42's cases run with the gate open ('always'); the S43 cases flip it.
  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    notifications: { ...DEFAULT_CONFIG.notifications, when: 'always' },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5 },
  };
  probe = new RemoteControlProbe({ root: tmp, claudeSettingsFile: path.join(tmp, 'claude-home', 'settings.json') });
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals,
    notifier,
    remoteControl: probe,
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

async function validate(extra: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  return client.callTool({
    name: 'validate_deploy',
    arguments: {
      connection: 'phone-org',
      components: [{ type: 'FlexiPage', api_name: 'Phone_Page', content: '<FlexiPage/>' }],
      ...extra,
    },
    ...(meta ? { _meta: meta } : {}),
  });
}

/** What Contrail's PreToolUse hook writes right before the tool call (see hooks/remote-control.mjs). */
function hookReported(opts: { toolUseId?: string; on: boolean; toolName?: string; at?: Date }): void {
  const dir = path.join(tmp, 'remote-control');
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({
    v: 1,
    remote_control: opts.on,
    at: (opts.at ?? new Date()).toISOString(),
    tool_name: opts.toolName ?? 'mcp__plugin_contrail_contrail-engine__validate_deploy',
    tool_use_id: opts.toolUseId ?? '',
  });
  fs.writeFileSync(path.join(dir, 'latest.json'), body);
  if (opts.toolUseId) fs.writeFileSync(path.join(dir, `${opts.toolUseId}.json`), body);
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
    expect(text).toContain('the code still counts only when the human gives it to you as their approval');
    // The result never claims the page is the code's only home (the push carries it too).
    expect(text).toContain('Contrail gives the confirmation code only to the human (their approval page, and their phone');
    expect(text).not.toContain('displayed ONLY on the approval page');

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

describe('S43: the Remote Control gate — a code is pushed only when it could be typed from the phone', () => {
  beforeEach(() => {
    config.notifications.when = 'remote_control';
  });

  it('hook reported ON for this call (per-call marker + _meta tool-use id) → pushed, exactly as before', async () => {
    hookReported({ toolUseId: 'toolu_01on', on: true });
    const result = await validate({}, { 'claudecode/toolUseId': 'toolu_01on' });
    expect(result.isError ?? false).toBe(false);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.view.code).toBe(codeFromPage(presentedPages[0]!));
    expect(textOf(result)).toContain('"status": "sent"');
  });

  it('hook reported OFF → skipped with remote_control_off; the page still has the code, the agent never does', async () => {
    hookReported({ toolUseId: 'toolu_02off', on: false });
    const result = await validate({}, { 'claudecode/toolUseId': 'toolu_02off' });
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(notifier.calls).toHaveLength(0);
    expect(presentedPages).toHaveLength(1);
    expect(text).toContain('"status": "skipped"');
    expect(text).toContain('"reason": "remote_control_off"');
    expect(text).toContain('nothing to do');
    expect(text).not.toContain('open_settings');
    expect(text).not.toContain(codeFromPage(presentedPages[0]!));
    const skipped = db.queryAuditEvents({}).filter((e) => e.eventType === 'approval.notify_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.detail).toMatchObject({ kind: 'deploy', reason: 'remote_control_off' });
    expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(codeFromPage(presentedPages[0]!));
  });

  it('no hook report at all → skipped with remote_control_unknown, and the agent is told how the human fixes it', async () => {
    const text = textOf(await validate({}, { 'claudecode/toolUseId': 'toolu_03none' }));
    expect(notifier.calls).toHaveLength(0);
    expect(text).toContain('"reason": "remote_control_unknown"');
    expect(text).toContain('hook did not report');
    expect(text).toContain('open_settings');
    expect(text).not.toContain(codeFromPage(presentedPages[0]!));
  });

  it('without a tool-use id in _meta, a RECENT same-tool report counts; one for another tool does not', async () => {
    hookReported({ on: true, toolName: 'mcp__Contrail__validate_deploy' }); // latest.json only, Desktop-extension name
    expect(textOf(await validate())).toContain('"status": "sent"');
    expect(notifier.calls).toHaveLength(1);

    hookReported({ on: true, toolName: 'mcp__Contrail__dml_propose' });
    expect(textOf(await validate())).toContain('"reason": "remote_control_unknown"');
    expect(notifier.calls).toHaveLength(1);

    hookReported({ on: true, toolName: 'mcp__Contrail__validate_deploy', at: new Date(Date.now() - 45 * 60_000) }); // stale
    expect(textOf(await validate())).toContain('"reason": "remote_control_unknown"');
    expect(notifier.calls).toHaveLength(1);
  });

  it("'always' pushes with no hook report; method 'none' stays off whatever the hook says", async () => {
    config.notifications.when = 'always';
    expect(textOf(await validate())).toContain('"status": "sent"');
    expect(notifier.calls).toHaveLength(1);

    config.notifications.when = 'remote_control';
    notifier.method = 'none';
    hookReported({ toolUseId: 'toolu_04on', on: true });
    expect(textOf(await validate({}, { 'claudecode/toolUseId': 'toolu_04on' }))).toContain('"status": "off"');
    expect(notifier.calls).toHaveLength(2); // the inner notifier answered 'off' itself
  });

  it('a dry run mints no code and consults nobody, gate or not', async () => {
    hookReported({ toolUseId: 'toolu_05dry', on: true });
    const result = await validate({ dry_run: true }, { 'claudecode/toolUseId': 'toolu_05dry' });
    expect(presentedPages).toHaveLength(0);
    expect(notifier.calls).toHaveLength(0);
    expect(textOf(result)).not.toContain('phone_notification');
  });

  it('list_connections shows the gate setting and the last report the hook made, with no secrets and no paths', async () => {
    hookReported({ toolUseId: 'toolu_06list', on: true, toolName: 'mcp__Contrail__list_connections' });
    const text = textOf(await client.callTool({ name: 'list_connections', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_06list' } }));
    expect(text).toContain('"when": "remote_control"');
    expect(text).toContain('"state": "on"');
    expect(text).toContain('"user_hook": "not_installed"');
    // No settings-file path and no marker path leak (staging_dir legitimately
    // names the data dir, so the data dir itself is not the thing to assert on).
    expect(text).not.toContain('settings.json');
    expect(text).not.toContain('claude-home');
    expect(text).not.toContain('remote-control/');
    expect(text).not.toContain('remote-control\\');
  });

  it('deactivate_flow mints through the same gate: hook ON for its call → pushed; no report → unknown', async () => {
    hookReported({ toolUseId: 'toolu_deact_on', on: true, toolName: 'mcp__Contrail__deactivate_flow' });
    const first = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'phone-org', flow: 'Phone_Flow_A' },
      _meta: { 'claudecode/toolUseId': 'toolu_deact_on' },
    });
    expect(first.isError ?? false).toBe(false);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.view.kind).toBe('deploy');
    expect(notifier.calls[0]!.view.code).toBe(codeFromPage(presentedPages[0]!));
    expect(textOf(first)).toContain('"status": "sent"');
    expect(textOf(first)).not.toContain(notifier.calls[0]!.view.code);

    const second = await client.callTool({
      name: 'deactivate_flow',
      arguments: { connection: 'phone-org', flow: 'Phone_Flow_B' },
      _meta: { 'claudecode/toolUseId': 'toolu_deact_none' },
    });
    expect(textOf(second)).toContain('"reason": "remote_control_unknown"');
    expect(notifier.calls).toHaveLength(1);
  });
});

describe('S46: a change freeze and a policies change on the phone', () => {
  const FREEZE_POLICIES = {
    rules: [
      {
        name: 'phone freeze',
        freezeWindows: [
          { name: 'always', range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' }, timeZone: 'UTC' },
        ],
      },
    ],
  };

  /** The agent's phone_notification, from a validate_deploy result. */
  function phoneOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
    const text = textOf(result);
    const body = JSON.parse(text.startsWith('{') ? text : text.slice(text.indexOf('\n{') + 1)) as {
      approval_page: { phone_notification: Record<string, unknown> };
    };
    return body.approval_page.phone_notification;
  }

  function pendingCode(): string {
    const conn = db.resolveConnection('phone-org')!;
    return db.queryDeployRequests({ connectionId: conn.id, limit: 1 })[0]!.confirmationCode;
  }

  it('frozen at mint: the notifier gets the freeze flag and a view with no code; the agent hears of a code-free push', async () => {
    config.policies = FREEZE_POLICIES;
    const result = await validate();
    expect(result.isError ?? false, textOf(result)).toBe(false);
    const code = pendingCode();
    expect(presentedPages[0]!).not.toMatch(/class="code"/);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.opts).toEqual({ includeCode: false, freeze: true });
    expect(notifier.calls[0]!.view.code).toBe('');
    const msg = composePushover(notifier.calls[0]!.view, { ...notifier.calls[0]!.opts, summary: 'full' });
    expect(msg.message.endsWith(FREEZE_TAIL)).toBe(true);
    expect(msg.message).not.toContain(code);

    expect(phoneOf(result)).toEqual({
      status: 'sent',
      note:
        "A code-free summary was pushed to the human's phone: a change freeze is in effect, and " +
        'while it lasts they can only approve at their desk, after typing an emergency reason there.',
    });
    expect(db.queryAuditEvents({ eventType: 'approval.notified' })[0]!.detail).toEqual({
      requestId: expect.any(String),
      kind: 'deploy',
      method: 'pushover',
      codeIncluded: false,
      freeze: true,
    });
    expect(textOf(result)).not.toContain(code);
    expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(code);
  });

  it('frozen at mint, push failed or held back: each outcome in its freeze wording, pointing at open_settings', async () => {
    config.policies = FREEZE_POLICIES;
    notifier.behaviour = 'fail';
    const failed = phoneOf(await validate());
    expect(failed).toEqual({
      status: 'failed',
      reason: 'rejected',
      note:
        'Phone notification failed (Pushover rejected the stored keys — the human should ' +
        're-check them via open_settings). A change freeze is in effect, so the human approves ' +
        'at their desk either way.',
    });

    notifier.behaviour = 'sent';
    config.notifications.when = 'remote_control';
    hookReported({ toolUseId: 'toolu_frz_off', on: false });
    const off = phoneOf(await validate({}, { 'claudecode/toolUseId': 'toolu_frz_off' }));
    expect(off).toMatchObject({ status: 'skipped', reason: 'remote_control_off' });
    expect(off.note).toContain('A change freeze is in effect, so a push would have carried no code');
    expect(off.note).toContain('after typing an emergency reason on the approval page.');

    const unknown = phoneOf(await validate({}, { 'claudecode/toolUseId': 'toolu_frz_none' }));
    expect(unknown).toMatchObject({ status: 'skipped', reason: 'remote_control_unknown' });
    expect(unknown.note).toContain('cannot be approved until the human types an emergency reason on the approval page');
    expect(unknown.note).toContain('switch delivery to Always via open_settings.');

    for (const p of [failed, off, unknown]) {
      const text = JSON.stringify(p);
      expect(text).not.toContain("the app's Settings");
      expect(text).not.toContain('as always');
      expect(text).not.toContain('The code is only on the approval page');
      expect(text).not.toContain('nothing to do');
    }
  });

  it('a policies change rides the next push as its own line, after the counts', async () => {
    await validate();
    expect(notifier.calls[0]!.opts).toEqual({ includeCode: true });

    config.policies = {
      rules: [{ name: 'phone rule', match: { orgTypes: ['production'] }, requireTicket: true }],
    };
    await validate();
    expect(notifier.calls).toHaveLength(2);
    const { view, opts } = notifier.calls[1]!;
    expect(opts.includeCode).toBe(true);
    expect(opts.policyChangedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(view.code).toBe(pendingCode());
    const lines = composePushover(view, { ...opts, summary: 'minimal' }).message.split('\n');
    expect(lines[1]).toMatch(
      /^Contrail noticed a policies change in config\.json at \d{2}:\d{2} — read the approval page or Deploy Review before approving\.$/,
    );
    expect(lines.at(-1)).toBe(view.code);
  });
});

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

/**
 * S34: agent activation behind the full approval ritual (kind 'activation' on
 * the shared claim machinery). The write is ONE documented Connect REST POST
 * (/connect/bot-versions/{id}/activation) followed by a re-GET — the result
 * reports what the org CONFIRMS, never what was requested. Ritual invariants
 * re-pinned for the new kind: no execution without the page-only code,
 * single-use, supersede, refusals that burn nothing.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;
let presentedPages: string[];

// ── fetch stub knobs ─────────────────────────────────────────────────────
let botVersionRows: Array<{ Id: string; DeveloperName: string; Status: string }>;
let activationPosts: Array<{ id: string; body: Record<string, unknown> }>;
let postResult: { isActivated: boolean; messages: string[]; success: boolean };
let getResult: { isActivated: boolean; messages: string[]; success: boolean };

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://agent.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM BotVersion')) {
        return new Response(
          JSON.stringify({ totalSize: botVersionRows.length, done: true, records: botVersionRows }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    const activation = url.match(/\/connect\/bot-versions\/([^/]+)\/activation$/);
    if (activation) {
      if (method === 'POST') {
        activationPosts.push({
          id: activation[1]!,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(postResult));
      }
      return new Response(JSON.stringify(getResult));
    }
    return new Response('not found', { status: 404 });
  });
}

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-activation-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presentedPages = [];
  botVersionRows = [
    { Id: '0X9000000000001AAA', DeveloperName: 'v1', Status: 'Inactive' },
    { Id: '0X9000000000002AAA', DeveloperName: 'v2', Status: 'Active' },
  ];
  activationPosts = [];
  postResult = { isActivated: false, messages: [], success: true };
  getResult = { isActivated: false, messages: [], success: true };

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias: 'agent-org',
    instanceUrl: 'https://agent.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Agent Org',
    orgType: 'developer',
    isSandbox: false,
    username: 'dev@agent.example',
    userId: '005000000000001AAA',
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  const roGrants = emptyGrantSet();
  roGrants.metadata_read = true;
  const ro = db.insertConnection({
    alias: 'read-only',
    instanceUrl: 'https://agent.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'RO',
    orgType: 'production',
    isSandbox: false,
    username: null,
    userId: null,
    grants: roGrants,
  });
  tokens.setRefreshToken(ro.id, 'RT');

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
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
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

async function propose(
  args: Partial<{ agent: string; version: string; status: string; connection: string }> = {},
) {
  return client.callTool({
    name: 'agent_activation_propose',
    arguments: {
      connection: args.connection ?? 'agent-org',
      agent: args.agent ?? 'Support_Agent',
      version: args.version ?? 'v2',
      status: args.status ?? 'Inactive',
    },
  });
}

async function execute(confirmationCode: string, connection = 'agent-org') {
  return client.callTool({
    name: 'agent_activation_execute',
    arguments: { connection, confirmation_code: confirmationCode },
  });
}

describe('agent activation ritual', () => {
  it('propose → human code → execute; ONE documented POST; the re-GET is the reported truth', async () => {
    const proposed = await propose();
    const proposedText = textOf(proposed);
    expect(proposed.isError ?? false).toBe(false);
    expect(proposedText).toContain('nothing changed yet');
    expect(proposedText).toContain('0X9000000000002AAA');
    // The code lives ONLY on the page.
    expect(proposedText).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(presentedPages).toHaveLength(1);
    const page = presentedPages[0]!;
    expect(page).toContain('Approve this agent activation change');
    expect(page).toContain('LIVE AGENT BEHAVIOR');
    expect(page).toContain('DEACTIVATE Support_Agent v2 (currently Active)');

    // Org will confirm Inactive after the flip.
    getResult = { isActivated: false, messages: [], success: true };
    const executed = await execute(codeFromPage(page));
    const parsed = JSON.parse(textOf(executed)) as Record<string, unknown>;
    expect(parsed.executed).toBe(true);
    expect(parsed.confirmed_status).toBe('Inactive');
    expect(activationPosts).toHaveLength(1);
    expect(activationPosts[0]).toEqual({
      id: '0X9000000000002AAA',
      body: { status: 'Inactive' },
    });
    // Single-use: the code is spent.
    const again = await execute(codeFromPage(page));
    expect(textOf(again)).toMatch(/no .*matches that code|already|spent|superseded|expired/i);
  });

  it('a version already in the requested state is refused WITHOUT burning an approval', async () => {
    const res = await propose({ version: 'v2', status: 'Active' });
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed.proposed).toBe(false);
    expect(String(parsed.note)).toContain('already Active');
    expect(presentedPages).toHaveLength(0);
  });

  it('unknown version lists the real ones; unknown agent points at the enumeration query', async () => {
    const badVersion = await propose({ version: 'v9' });
    expect(badVersion.isError).toBe(true);
    expect(textOf(badVersion)).toContain('v1 (Inactive), v2 (Active)');

    botVersionRows = [];
    const badAgent = await propose({ agent: 'No_Such_Agent' });
    expect(badAgent.isError).toBe(true);
    expect(textOf(badAgent)).toContain('BotDefinition');
  });

  it('an org that does not confirm the change reports execution_failed with messages verbatim', async () => {
    const proposed = await propose();
    // The POST "succeeds" but the org keeps the version Active (e.g. platform refusal).
    postResult = { isActivated: true, messages: ['Version cannot be deactivated: reasons.'], success: false };
    getResult = { isActivated: true, messages: [], success: true };
    const executed = await execute(codeFromPage(presentedPages[0]!));
    const parsed = JSON.parse(textOf(executed)) as Record<string, unknown>;
    expect(parsed.executed).toBe(false);
    expect(parsed.confirmed_status).toBe('Active');
    expect(JSON.stringify(parsed.messages)).toContain('Version cannot be deactivated');
  });

  it('a new propose supersedes the pending code', async () => {
    await propose();
    const first = codeFromPage(presentedPages[0]!);
    await propose({ version: 'v1', status: 'Active' });
    const res = await execute(first);
    expect(textOf(res)).toMatch(/superseded/i);
    expect(activationPosts).toHaveLength(0);
  });

  it('metadata_write gates both tools', async () => {
    const proposed = await propose({ connection: 'read-only' });
    expect(proposed.isError).toBe(true);
    expect(textOf(proposed)).toContain('metadata_write');
    const executed = await execute('AAAA-AAAA', 'read-only');
    expect(executed.isError).toBe(true);
    expect(textOf(executed)).toContain('metadata_write');
  });
});

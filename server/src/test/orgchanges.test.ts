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
 * S24: the consultant's "what changed under me" pair. get_org_changes = live
 * listMetadata vs the local index, honestly bucketed (modified / new-in-org /
 * gone-from-org, managed skipped, child types excluded); get_setup_audit =
 * SetupAuditTrail, the config changes that never surface as metadata — and
 * gated as metadata-class information on BOTH its tool and raw SOQL.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;
let connId: string;
let lastSoql: string | null;

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

interface OrgItem {
  type: string;
  fullName: string;
  lastModifiedDate: string;
  lastModifiedByName: string;
  manageableState?: string;
}

/** The live org inventory the stub serves, keyed nowhere — filtered per requested type. */
let orgInventory: OrgItem[];
let auditRows: Array<Record<string, unknown>>;
let auditTotal: number;

function listResult(i: OrgItem): string {
  return `<result><fullName>${i.fullName}</fullName><type>${i.type}</type>
    <fileName>x</fileName><id>1</id>
    <lastModifiedDate>${i.lastModifiedDate}</lastModifiedDate>
    <lastModifiedByName>${i.lastModifiedByName}</lastModifiedByName>
    ${i.manageableState ? `<manageableState>${i.manageableState}</manageableState>` : ''}</result>`;
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://drift.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:listMetadata>')) {
        // Honour the per-call type queries — listMetadata chunks by 3, and a
        // stub that returns everything to every chunk would double-count.
        const requested = new Set(
          [...body.matchAll(/<met:type>([^<]+)<\/met:type>/g)].map((m) => m[1]!),
        );
        const items = orgInventory.filter((i) => requested.has(i.type));
        return new Response(
          soapEnvelope(
            `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               ${items.map(listResult).join('\n')}
             </listMetadataResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url.split('?q=')[1] ?? '');
      lastSoql = q;
      if (q.includes('FROM SetupAuditTrail')) {
        return new Response(
          JSON.stringify({ totalSize: auditTotal, done: true, records: auditRows }),
        );
      }
      return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    }
    return new Response('not found', { status: 404 });
  });
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function artifact(type: string, apiName: string, lastModifiedDate: string | null) {
  return {
    connectionId: connId,
    type,
    apiName,
    filePath: null,
    contentHash: 'h',
    lastModifiedDate,
    lastModifiedBy: null,
    retrievedAt: '2026-08-10T00:00:00.000Z',
    content: '',
  };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-drift-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  lastSoql = null;
  orgInventory = [];
  auditRows = [];
  auditTotal = 0;

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.data_read = true;
  const conn = db.insertConnection({
    alias: 'drift-org',
    instanceUrl: 'https://drift.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Drift Org',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT');

  const dataOnly = emptyGrantSet();
  dataOnly.data_read = true;
  const d = db.insertConnection({
    alias: 'data-only',
    instanceUrl: 'https://drift.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Data Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: dataOnly,
  });
  tokens.setRefreshToken(d.id, 'RT');

  stubSalesforce();

  const config: ContrailConfig = {
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
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

function seedIndex(): void {
  db.replaceArtifactsForTypes(
    connId,
    ['ApexClass', 'Flow'],
    [
      artifact('ApexClass', 'Alpha', '2026-08-01T00:00:00.000Z'),
      artifact('ApexClass', 'Beta', '2026-08-01T00:00:00.000Z'),
      artifact('ApexClass', 'Ghost', '2026-08-01T00:00:00.000Z'),
      // No org-reported date at snapshot time — baseline falls back to retrievedAt.
      artifact('Flow', 'Old_Flow', null),
    ],
  );
}

describe('get_org_changes', () => {
  it('buckets modified / new / gone against the snapshot, skips managed, groups by user', async () => {
    seedIndex();
    orgInventory = [
      // Alpha edited in the org AFTER the snapshot baseline.
      { type: 'ApexClass', fullName: 'Alpha', lastModifiedDate: '2026-08-20T10:00:00.000Z', lastModifiedByName: 'Jane Admin' },
      // Beta untouched (older than baseline).
      { type: 'ApexClass', fullName: 'Beta', lastModifiedDate: '2026-07-01T00:00:00.000Z', lastModifiedByName: 'Jane Admin' },
      // Ghost is GONE from the org (absent here).
      // Brand new in the org:
      { type: 'ApexClass', fullName: 'Fresh', lastModifiedDate: '2026-08-21T09:00:00.000Z', lastModifiedByName: 'Sam Dev' },
      // Managed-package item — never drift.
      { type: 'ApexClass', fullName: 'pkg__Thing', lastModifiedDate: '2026-08-22T00:00:00.000Z', lastModifiedByName: 'Vendor', manageableState: 'installed' },
      // Flow edited after its retrievedAt fallback baseline (2026-08-10).
      { type: 'Flow', fullName: 'Old_Flow', lastModifiedDate: '2026-08-15T00:00:00.000Z', lastModifiedByName: 'Jane Admin' },
    ];

    const result = await client.callTool({
      name: 'get_org_changes',
      arguments: { connection: 'drift-org' },
    });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body.totals).toEqual({
      modified: 2,
      new_in_org: 1,
      gone_from_org: 1,
      managed_package_items_skipped: 1,
    });
    const modified = body.modified as Array<Record<string, unknown>>;
    expect(modified.map((m) => m.api_name).sort()).toEqual(['Alpha', 'Old_Flow']);
    // The null-date artifact's baseline honestly falls back to its retrieval time.
    expect(modified.find((m) => m.api_name === 'Old_Flow')?.baseline).toBe('2026-08-10T00:00:00.000Z');
    expect((body.new_in_org as Array<Record<string, unknown>>)[0]?.api_name).toBe('Fresh');
    expect((body.gone_from_org as Array<Record<string, unknown>>)[0]?.api_name).toBe('Ghost');
    expect(body.by_user).toEqual({
      'Jane Admin': { modified: 2, new_in_org: 0 },
      'Sam Dev': { modified: 0, new_in_org: 1 },
    });
  });

  it('since narrows modified/new but gone stays snapshot-relative', async () => {
    seedIndex();
    orgInventory = [
      { type: 'ApexClass', fullName: 'Alpha', lastModifiedDate: '2026-08-20T10:00:00.000Z', lastModifiedByName: 'Jane Admin' },
      { type: 'ApexClass', fullName: 'Fresh', lastModifiedDate: '2026-08-12T09:00:00.000Z', lastModifiedByName: 'Sam Dev' },
      { type: 'ApexClass', fullName: 'Beta', lastModifiedDate: '2026-07-01T00:00:00.000Z', lastModifiedByName: 'Jane Admin' },
      { type: 'Flow', fullName: 'Old_Flow', lastModifiedDate: '2026-08-15T00:00:00.000Z', lastModifiedByName: 'Jane Admin' },
    ];
    const result = await client.callTool({
      name: 'get_org_changes',
      arguments: { connection: 'drift-org', since: '2026-08-18T00:00:00.000Z' },
    });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    // Only Alpha beats the since cutoff; Fresh (Aug 12) and Old_Flow (Aug 15) do not.
    expect((body.totals as Record<string, number>).modified).toBe(1);
    expect((body.totals as Record<string, number>).new_in_org).toBe(0);
    expect((body.totals as Record<string, number>).gone_from_org).toBe(1);
  });

  it('refuses without a snapshot, on child types, and without metadata_read', async () => {
    const noSnap = await client.callTool({
      name: 'get_org_changes',
      arguments: { connection: 'drift-org' },
    });
    expect(noSnap.isError).toBe(true);
    expect(textOf(noSnap)).toContain('refresh_snapshot');

    seedIndex();
    const childOnly = await client.callTool({
      name: 'get_org_changes',
      arguments: { connection: 'drift-org', types: ['CustomField'] },
    });
    expect(childOnly.isError).toBe(true);

    const ungranted = await client.callTool({
      name: 'get_org_changes',
      arguments: { connection: 'data-only' },
    });
    expect(ungranted.isError).toBe(true);
    expect(textOf(ungranted)).toContain('metadata_read');
  });
});

describe('get_setup_audit', () => {
  it('reads SetupAuditTrail with LAST_N_DAYS, groups by section and admin, truncation-honest', async () => {
    auditRows = [
      {
        Action: 'changedPassword',
        Section: 'Manage Users',
        Display: 'Changed password for user Sam Dev',
        CreatedDate: '2026-08-28T01:00:00.000Z',
        CreatedBy: { Name: 'Jane Admin', Username: 'jane@x.example' },
        DelegateUser: null,
      },
      {
        Action: 'PermSetAssign',
        Section: 'Manage Users',
        Display: 'Assigned permission set X to Sam Dev',
        CreatedDate: '2026-08-27T01:00:00.000Z',
        CreatedBy: { Name: 'Jane Admin', Username: 'jane@x.example' },
        DelegateUser: null,
      },
      {
        Action: 'filteredLookups',
        Section: 'Customize Opportunities',
        Display: 'Changed lookup filter',
        CreatedDate: '2026-08-26T01:00:00.000Z',
        CreatedBy: null,
        DelegateUser: 'admin@x.example',
      },
    ];
    auditTotal = 12;
    const result = await client.callTool({
      name: 'get_setup_audit',
      arguments: { connection: 'drift-org', days: 14, limit: 3 },
    });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(lastSoql).toContain('FROM SetupAuditTrail');
    expect(lastSoql).toContain('LAST_N_DAYS:14');
    expect(body.total_size).toBe(12);
    expect(body.returned).toBe(3);
    expect(body.truncated).toBe(true);
    expect(body.by_section).toEqual({ 'Manage Users': 2, 'Customize Opportunities': 1 });
    expect(body.by_user).toEqual({ 'Jane Admin': 2, '(system)': 1 });
    const events = body.events as Array<Record<string, unknown>>;
    expect(events[2]?.as_delegate_of).toBe('admin@x.example');
  });

  it('is metadata-class: the tool and raw SOQL both require metadata_read', async () => {
    const tool = await client.callTool({
      name: 'get_setup_audit',
      arguments: { connection: 'data-only' },
    });
    expect(tool.isError).toBe(true);
    expect(textOf(tool)).toContain('metadata_read');

    const soql = await client.callTool({
      name: 'soql_query',
      arguments: { connection: 'data-only', query: 'SELECT Id FROM SetupAuditTrail' },
    });
    expect(soql.isError).toBe(true);
    expect(textOf(soql)).toContain('metadata_read');
  });
});

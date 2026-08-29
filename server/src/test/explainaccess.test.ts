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
 * S25: explain_access — effective CRUD/FLS with WHO-grants-it attribution.
 * The honesty contract under test: rollup is the OR across the user's
 * permission containers, each bit names its grantors, zero FLS rows are
 * explained (required/system fields carry none), and the v1 scope note
 * (no record-level sharing) is always present.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;

let userRows: Array<Record<string, unknown>>;
let objPermRows: Array<Record<string, unknown>>;
let fieldPermRows: Array<Record<string, unknown>>;
let assignmentCounts: Array<{ PermissionSetId: string; n: number }>;

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://access.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url.split('?q=')[1] ?? '');
      const respond = (records: unknown[]) =>
        new Response(JSON.stringify({ totalSize: records.length, done: true, records }));
      if (/FROM User\b/.test(q)) return respond(userRows);
      if (q.includes('FROM ObjectPermissions')) return respond(objPermRows);
      if (q.includes('FROM FieldPermissions')) return respond(fieldPermRows);
      if (q.includes('GROUP BY PermissionSetId')) return respond(assignmentCounts);
      return respond([]);
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

const JANE = {
  Id: '005000000000001AAA',
  Name: 'Jane Admin',
  Username: 'jane@x.example',
  IsActive: true,
  Profile: { Name: 'Sys Admin Lite' },
};

const PROFILE_PARENT = {
  Id: '0PS000000000001AAA',
  Label: 'X_Profile_Owned',
  IsOwnedByProfile: true,
  Profile: { Name: 'Sys Admin Lite' },
};
const PERMSET_PARENT = {
  Id: '0PS000000000002AAA',
  Label: 'Invoice Managers',
  IsOwnedByProfile: false,
  Profile: null,
};

function objPerm(parent: unknown, perms: Partial<Record<string, boolean>>): Record<string, unknown> {
  return {
    Parent: parent,
    PermissionsRead: false,
    PermissionsCreate: false,
    PermissionsEdit: false,
    PermissionsDelete: false,
    PermissionsViewAllRecords: false,
    PermissionsModifyAllRecords: false,
    ...perms,
  };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-access-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  userRows = [JANE];
  objPermRows = [];
  fieldPermRows = [];
  assignmentCounts = [];

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.data_read = true;
  const conn = db.insertConnection({
    alias: 'access-org',
    instanceUrl: 'https://access.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Access Org',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  const metaOnly = emptyGrantSet();
  metaOnly.metadata_read = true;
  const m = db.insertConnection({
    alias: 'meta-only',
    instanceUrl: 'https://access.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Meta Only',
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: metaOnly,
  });
  tokens.setRefreshToken(m.id, 'RT');

  stubSalesforce();

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
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

async function explain(args: Record<string, unknown>) {
  return client.callTool({
    name: 'explain_access',
    arguments: { connection: 'access-org', user: 'jane@x.example', object: 'Invoice__c', ...args },
  });
}

describe('explain_access', () => {
  it('rolls up CRUD across containers, attributes each bit, counts co-assignees', async () => {
    objPermRows = [
      objPerm(PROFILE_PARENT, { PermissionsRead: true, PermissionsEdit: true }),
      objPerm(PERMSET_PARENT, { PermissionsRead: true, PermissionsDelete: true }),
    ];
    assignmentCounts = [
      { PermissionSetId: PROFILE_PARENT.Id, n: 14 },
      { PermissionSetId: PERMSET_PARENT.Id, n: 3 },
    ];
    const body = JSON.parse(textOf(await explain({}))) as Record<string, unknown>;
    const access = body.object_access as Record<string, { granted: boolean; via: string[] }>;
    expect(access.read).toEqual({
      granted: true,
      via: ['Profile: Sys Admin Lite', 'Invoice Managers'],
    });
    expect(access.edit).toEqual({ granted: true, via: ['Profile: Sys Admin Lite'] });
    expect(access.delete).toEqual({ granted: true, via: ['Invoice Managers'] });
    expect(access.create.granted).toBe(false);
    expect(access.modify_all_records.granted).toBe(false);
    expect(body.grantors).toEqual([
      { name: 'Profile: Sys Admin Lite', assignees: 14 },
      { name: 'Invoice Managers', assignees: 3 },
    ]);
    expect(String(body.note)).toContain('sharing');
    expect((body.user as Record<string, unknown>).profile).toBe('Sys Admin Lite');
  });

  it('answers field-level FLS, and explains ZERO rows instead of asserting denial', async () => {
    objPermRows = [objPerm(PROFILE_PARENT, { PermissionsRead: true })];
    fieldPermRows = [
      {
        Parent: PERMSET_PARENT,
        PermissionsRead: true,
        PermissionsEdit: false,
      },
    ];
    const withRows = JSON.parse(
      textOf(await explain({ field: 'Amount__c' })),
    ) as Record<string, unknown>;
    const fa = withRows.field_access as Record<string, unknown>;
    expect(fa.field).toBe('Invoice__c.Amount__c');
    expect(fa.read).toEqual({ granted: true, via: ['Invoice Managers'] });
    expect(fa.edit).toEqual({ granted: false, via: [] });
    expect(fa.note).toBeUndefined();

    fieldPermRows = [];
    const noRows = JSON.parse(
      textOf(await explain({ field: 'Invoice__c.Name' })),
    ) as Record<string, unknown>;
    expect(String((noRows.field_access as Record<string, unknown>).note)).toContain(
      'carry no FLS',
    );
  });

  it('refuses ambiguity and unknown users rather than guessing', async () => {
    userRows = [JANE, { ...JANE, Id: '005000000000002AAA', Username: 'jane2@x.example' }];
    const ambiguous = await explain({ user: 'Jane Admin' });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain('jane2@x.example');

    userRows = [];
    const missing = await explain({ user: 'nobody@x.example' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No user matches');
  });

  it('warns on inactive users and gates on data_read', async () => {
    userRows = [{ ...JANE, IsActive: false }];
    objPermRows = [objPerm(PROFILE_PARENT, { PermissionsRead: true })];
    const body = JSON.parse(textOf(await explain({}))) as Record<string, unknown>;
    expect(String(body.warning)).toContain('INACTIVE');

    const gated = await client.callTool({
      name: 'explain_access',
      arguments: { connection: 'meta-only', user: 'jane@x.example', object: 'Invoice__c' },
    });
    expect(gated.isError).toBe(true);
    expect(textOf(gated)).toContain('data_read');
  });
});

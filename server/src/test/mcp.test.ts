import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet, TOOL_GRANT_MAP } from '../core/grants.js';
import { SnapshotStore } from '../snapshot/store.js';

let tmp: string;
let db: ContrailDb;
let client: Client;
let opened: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-mcp-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  opened = [];
  const deps = createDeps({
    db,
    tokens: new MemoryTokenStore(),
    config: { ...DEFAULT_CONFIG },
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    // Stubbed externals — no real browser or Salesforce in tests.
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised in MCP tests');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised in MCP tests');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async (url: string) => {
        opened.push(url);
      },
    },
  });
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('MCP surface', () => {
  it('exposes exactly the current tool set, all classified in TOOL_GRANT_MAP', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'connect_org',
      'deactivate_flow',
      'describe_schema',
      'diff_artifact',
      'diff_orgs',
      'disconnect_org',
      'dml_execute',
      'dml_propose',
      'execute_deploy',
      'get_audit_log',
      'get_debug_logs',
      'get_dependencies',
      'get_flow_errors',
      'get_permissions',
      'get_record',
      'list_connections',
      'list_metadata',
      'manage_connection',
      'refresh_snapshot',
      'retrieve_metadata',
      'search_metadata',
      'soql_query',
      'validate_deploy',
    ]);
    for (const name of names) {
      expect(TOOL_GRANT_MAP, `${name} must be grant-classified`).toHaveProperty(name);
    }
  });

  it('refuses a metadata tool without the metadata_read grant, and audits the refusal', async () => {
    db.insertConnection({
      alias: 'no-grants',
      instanceUrl: 'https://locked.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dxx0000000009EAA',
      orgName: 'Locked',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants: emptyGrantSet(),
    });
    const result = await client.callTool({
      name: 'list_metadata',
      arguments: { connection: 'no-grants' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_read');
    const refusal = db
      .queryAuditEvents({})
      .find((e) => e.eventType === 'grant.refused' && e.tool === 'list_metadata');
    expect(refusal).toBeTruthy();
    expect(refusal!.outcome).toBe('refused');
  });

  it('list_connections returns stored connections without any token material', async () => {
    const grants = emptyGrantSet();
    grants.metadata_read = true;
    db.insertConnection({
      alias: 'acme-uat',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      orgId: '00Dxx0000000001EAA',
      orgName: 'Acme UAT',
      orgType: 'sandbox',
      isSandbox: true,
      username: 'ryley@acme.com.uat',
      userId: null,
      grants,
    });
    const result = await client.callTool({ name: 'list_connections', arguments: {} });
    const text = textOf(result);
    const parsed = JSON.parse(text) as { count: number; connections: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.connections[0]!.alias).toBe('acme-uat');
    expect(text).not.toMatch(/refresh|access_token|RT-|AT-/);
  });

  it('get_permissions reports granted AND not-granted, with the write-invariant note', async () => {
    const grants = emptyGrantSet();
    grants.data_read = true;
    db.insertConnection({
      alias: 'client-prod',
      instanceUrl: 'https://client.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dzz0000000002EAA',
      orgName: 'Client',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants,
    });
    const result = await client.callTool({
      name: 'get_permissions',
      arguments: { connection: 'client-prod' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      granted: string[];
      not_granted: string[];
      notes: string[];
    };
    expect(parsed.granted).toEqual(['data_read']);
    expect(parsed.not_granted.sort()).toEqual(
      ['metadata_read', 'metadata_write', 'diagnostics_read', 'data_write'].sort(),
    );
    expect(parsed.notes.join(' ')).toContain('human approval');
  });

  it('errors cleanly for an unknown connection reference', async () => {
    const result = await client.callTool({
      name: 'get_permissions',
      arguments: { connection: 'nonexistent' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('list_connections');
  });

  it('manage_connection keeps the session-bearing URL out of model context when the browser opens', async () => {
    db.insertConnection({
      alias: 'managed-org',
      instanceUrl: 'https://managed.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dmm0000000003EAA',
      orgName: 'Managed',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants: emptyGrantSet(),
    });
    const result = await client.callTool({
      name: 'manage_connection',
      arguments: { connection: 'managed-org' },
    });
    const text = textOf(result);
    // The browser got the real tokened URL; the model got none of it.
    expect(opened.some((u) => u.includes('/manage?s='))).toBe(true);
    expect(text).not.toContain('?s=');
    expect(text).not.toContain('management_url');
    expect(text).toContain('"page_opened_in_browser": true');
  });

  it('get_audit_log returns events', async () => {
    db.insertAuditEvent({ eventType: 'connection.created', outcome: 'success' });
    const result = await client.callTool({ name: 'get_audit_log', arguments: {} });
    const parsed = JSON.parse(textOf(result)) as { count: number };
    expect(parsed.count).toBeGreaterThanOrEqual(1);
  });
});

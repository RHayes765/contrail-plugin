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
 * S29: get_report_data — the synchronous Analytics REST run behind data_read.
 * Resolution (id / DeveloperName / Folder-qualified), factMap shaping for
 * Tabular and Matrix, and the three distinct truncation signals.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;
let analyticsCalls: string[];
let reportRows: Array<Record<string, unknown>>;
let analyticsBody: Record<string, unknown> | null;
let analyticsStatus: number;

const TABULAR_RUN = {
  allData: true,
  factMap: {
    'T!T': {
      aggregates: [{ label: '$150', value: 150 }],
      rows: [
        { dataCells: [{ label: 'Acme', value: '001x1' }, { label: '$100', value: 100 }] },
        { dataCells: [{ label: 'Globex', value: '001x2' }, { label: '$50', value: 50 }] },
      ],
    },
  },
  reportMetadata: {
    id: '00O000000000001AAA',
    name: 'All Accounts',
    developerName: 'All_Accounts',
    reportFormat: 'TABULAR',
    reportType: { type: 'AccountList', label: 'Accounts' },
    detailColumns: ['ACCOUNT_NAME', 'SALES'],
    aggregates: ['s!SALES'],
  },
  reportExtendedMetadata: {
    detailColumnInfo: {
      ACCOUNT_NAME: { label: 'Account Name' },
      SALES: { label: 'Annual Revenue' },
    },
    aggregateColumnInfo: { 's!SALES': { label: 'Sum of Annual Revenue' } },
  },
};

const MATRIX_RUN = {
  allData: true,
  factMap: {
    'T!T': { aggregates: [{ value: 300 }] },
    '0!0': { aggregates: [{ value: 100 }] },
    '0!1': { aggregates: [{ value: 50 }] },
    '1!0': { aggregates: [{ value: 150 }] },
    '0!T': { aggregates: [{ value: 150 }] },
    'T!0': { aggregates: [{ value: 250 }] },
  },
  groupingsDown: {
    groupings: [
      { label: 'Closed Won', key: '0' },
      { label: 'Open', key: '1' },
    ],
  },
  groupingsAcross: {
    groupings: [
      { label: 'Q1', key: '0' },
      { label: 'Q2', key: '1' },
    ],
  },
  reportMetadata: {
    id: '00O000000000002AAA',
    name: 'Pipeline Matrix',
    developerName: 'Pipeline_Matrix',
    reportFormat: 'MATRIX',
    detailColumns: [],
    aggregates: ['s!AMOUNT'],
  },
  reportExtendedMetadata: {
    aggregateColumnInfo: { 's!AMOUNT': { label: 'Sum of Amount' } },
  },
};

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://rpt.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00D1/0051',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/analytics/reports/')) {
      analyticsCalls.push(url);
      if (analyticsStatus !== 200) {
        return new Response(
          JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]),
          { status: analyticsStatus },
        );
      }
      return new Response(JSON.stringify(analyticsBody ?? TABULAR_RUN));
    }
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url.split('?q=')[1] ?? '');
      if (q.includes('FROM Report')) {
        return new Response(
          JSON.stringify({ totalSize: reportRows.length, done: true, records: reportRows }),
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

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-report-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  analyticsCalls = [];
  reportRows = [];
  analyticsBody = null;
  analyticsStatus = 200;

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.data_read = true;
  const conn = db.insertConnection({
    alias: 'rpt-org',
    instanceUrl: 'https://rpt.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D1',
    orgName: 'Report Org',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');

  const metaOnly = emptyGrantSet();
  metaOnly.metadata_read = true;
  const m = db.insertConnection({
    alias: 'meta-only',
    instanceUrl: 'https://rpt.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D2',
    orgName: 'Meta Only',
    orgType: 'developer',
    isSandbox: false,
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

async function run(args: Record<string, unknown>) {
  const result = await client.callTool({
    name: 'get_report_data',
    arguments: { connection: 'rpt-org', ...args },
  });
  return { result, body: result.isError ? null : (JSON.parse(textOf(result)) as Record<string, unknown>) };
}

describe('get_report_data', () => {
  it('runs by id: columns, label rows, numeric grand totals, honest all_data', async () => {
    const { body } = await run({ report: '00O000000000001AAA' });
    expect(analyticsCalls[0]).toContain('/analytics/reports/00O000000000001AAA?includeDetails=true');
    expect(body!.report).toMatchObject({
      name: 'All Accounts',
      developer_name: 'All_Accounts',
      format: 'TABULAR',
      report_type: 'Accounts',
    });
    expect(body!.columns).toEqual([
      { name: 'ACCOUNT_NAME', label: 'Account Name' },
      { name: 'SALES', label: 'Annual Revenue' },
    ]);
    expect(body!.grand_totals).toEqual({ 'Sum of Annual Revenue': 150 });
    expect(body!.detail_rows).toEqual([
      ['Acme', '$100'],
      ['Globex', '$50'],
    ]);
    expect(body!.all_data).toBe(true);
    expect(body!.truncated).toBe(false);
  });

  it('resolves a DeveloperName via the Report sobject and runs the resolved id', async () => {
    reportRows = [
      { Id: '00O000000000001AAA', Name: 'All Accounts', DeveloperName: 'All_Accounts', FolderName: 'Ops Reports' },
    ];
    const { body } = await run({ report: 'All_Accounts' });
    expect(analyticsCalls[0]).toContain('/analytics/reports/00O000000000001AAA');
    expect(body!.report).toMatchObject({ developer_name: 'All_Accounts' });
  });

  it('a Folder/Name reference disambiguates same-named reports by folder', async () => {
    reportRows = [
      { Id: '00O00000000000aAAA', Name: 'Weekly', DeveloperName: 'Weekly', FolderName: 'Ops Reports' },
      { Id: '00O00000000000bAAA', Name: 'Weekly', DeveloperName: 'Weekly', FolderName: 'Sales Reports' },
    ];
    const { body } = await run({ report: 'Sales_Reports/Weekly' });
    expect(analyticsCalls[0]).toContain('/analytics/reports/00O00000000000bAAA');
    expect(body).toBeTruthy();
  });

  it('ambiguity without a folder fails, listing the candidates', async () => {
    reportRows = [
      { Id: '00O00000000000aAAA', Name: 'Weekly', DeveloperName: 'Weekly', FolderName: 'Ops Reports' },
      { Id: '00O00000000000bAAA', Name: 'Weekly', DeveloperName: 'Weekly', FolderName: 'Sales Reports' },
    ];
    const { result } = await run({ report: 'Weekly' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Ops Reports');
    expect(textOf(result)).toContain('00O00000000000aAAA');
  });

  it('an unknown DeveloperName fails naming BOTH possibilities (missing OR unshared folder)', async () => {
    reportRows = [];
    const { result } = await run({ report: 'Nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not exist or/);
    expect(textOf(result)).toMatch(/folder/i);
  });

  it('all_data=false surfaces the org-side sync cap as a note and truncated=true', async () => {
    analyticsBody = { ...TABULAR_RUN, allData: false };
    const { body } = await run({ report: '00O000000000001AAA' });
    expect(body!.all_data).toBe(false);
    expect(body!.truncated).toBe(true);
    expect(String(body!.note)).toMatch(/2,000 detail rows org-side/);
  });

  it('the caller row cap drops rows with an honest note', async () => {
    const { body } = await run({ report: '00O000000000001AAA', limit: 1 });
    expect(body!.detail_rows).toEqual([['Acme', '$100']]);
    expect(body!.detail_rows_returned).toBe(1);
    expect(body!.truncated).toBe(true);
    expect(String(body!.note)).toMatch(/1 detail rows dropped to the row cap/);
  });

  it('matrix: grouping keys resolve to label paths, aggregates stay numeric', async () => {
    analyticsBody = MATRIX_RUN;
    const { body } = await run({ report: '00O000000000002AAA' });
    expect(body!.grand_totals).toEqual({ 'Sum of Amount': 300 });
    const groups = body!.groups as Array<Record<string, unknown>>;
    expect(groups).toContainEqual({
      down: ['Closed Won'],
      across: ['Q1'],
      aggregates: { 'Sum of Amount': 100 },
    });
    // Partial totals keep only the axis they group.
    expect(groups).toContainEqual({ down: ['Closed Won'], aggregates: { 'Sum of Amount': 150 } });
    expect(groups).toContainEqual({ across: ['Q1'], aggregates: { 'Sum of Amount': 250 } });
  });

  it('a 404 from the analytics API is reframed with the folder-sharing reality', async () => {
    analyticsStatus = 404;
    const { result } = await run({ report: '00O000000000009AAA' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/folder is not shared/);
  });

  it('details:false passes includeDetails=false through', async () => {
    await run({ report: '00O000000000001AAA', details: false });
    expect(analyticsCalls[0]).toContain('includeDetails=false');
  });

  it('refuses without data_read, auditing the refusal', async () => {
    const result = await client.callTool({
      name: 'get_report_data',
      arguments: { connection: 'meta-only', report: '00O000000000001AAA' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('data_read');
    const events = db.queryAuditEvents({}).map((e) => e.eventType);
    expect(events).toContain('grant.refused');
    expect(analyticsCalls).toHaveLength(0);
  });
});

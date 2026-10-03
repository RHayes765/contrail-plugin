import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet, type GrantSet } from '../core/grants.js';
import { INVOICE_OBJECT_XML, INVOICE_SERVICE_APEX } from './fixtures.js';

const INVOICE_OBJECT_XML_B = INVOICE_OBJECT_XML.replace(
  '<type>Picklist</type>',
  '<type>Text</type>',
);

let tmp: string;
let db: ContrailDb;
let store: SnapshotStore;
let client: Client;
let connA: string;
let connB: string;

function grants(metadataRead: boolean): GrantSet {
  const g = emptyGrantSet();
  g.metadata_read = metadataRead;
  return g;
}

function seedConnection(alias: string, orgId: string, metadataRead: boolean): string {
  return db.insertConnection({
    alias,
    instanceUrl: `https://${alias}.my.salesforce.com`,
    loginUrl: 'https://login.salesforce.com',
    orgId,
    orgName: alias,
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: grants(metadataRead),
  }).id;
}

function seedSnapshot(
  connId: string,
  objectXml: string,
  apex: string,
  hashSuffix: string,
  extraFiles: Record<string, string> = {},
): void {
  store.writeCurrent(
    connId,
    new Map([
      ['objects/Invoice__c.object', strToU8(objectXml)],
      ['classes/InvoiceService.cls', strToU8(apex)],
      ...Object.entries(extraFiles).map(
        ([rel, content]) => [rel, strToU8(content)] as [string, Uint8Array],
      ),
    ]),
  );
  const retrievedAt = '2026-08-06T00:00:00.000Z';
  db.replaceArtifactsForTypes(connId, ['CustomObject', 'CustomField', 'ApexClass', 'Flow'], [
    {
      connectionId: connId,
      type: 'CustomObject',
      apiName: 'Invoice__c',
      filePath: 'objects/Invoice__c.object',
      contentHash: `obj-${hashSuffix}`,
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt,
      content: objectXml,
    },
    {
      connectionId: connId,
      type: 'CustomField',
      apiName: 'Invoice__c.Status__c',
      filePath: 'objects/Invoice__c.object',
      contentHash: `fld-${hashSuffix}`,
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt,
      content: '',
    },
    {
      connectionId: connId,
      type: 'ApexClass',
      apiName: 'InvoiceService',
      filePath: 'classes/InvoiceService.cls',
      contentHash: 'apex-same',
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt,
      content: apex,
    },
  ]);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-diff-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
  connA = seedConnection('acme-uat', '00Da000000000AAA', true);
  connB = seedConnection('acme-prod', '00Db000000000BBB', true);
  seedSnapshot(connA, INVOICE_OBJECT_XML, INVOICE_SERVICE_APEX, 'a', {
    'flows/UAT_Only_Flow.flow': '<Flow><label>UAT Only</label></Flow>',
  });
  seedSnapshot(connB, INVOICE_OBJECT_XML_B, INVOICE_SERVICE_APEX, 'b');
  // one artifact only in A
  db.replaceArtifactsForTypes(connA, ['Flow'], [
    {
      connectionId: connA,
      type: 'Flow',
      apiName: 'UAT_Only_Flow',
      filePath: 'flows/UAT_Only_Flow.flow',
      contentHash: 'flow-a',
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt: '2026-08-06T00:00:00.000Z',
      content: '<Flow/>',
    },
  ]);

  const deps = createDeps({
    db,
    tokens: new MemoryTokenStore(),
    config: { ...DEFAULT_CONFIG },
    store,
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('diff_orgs', () => {
  it('buckets identical / changed / only-in by content hash', async () => {
    const result = await client.callTool({
      name: 'diff_orgs',
      arguments: { connection_a: 'acme-uat', connection_b: 'acme-prod' },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.from).toBe('acme-uat');
    const counts = parsed.counts_by_type as Record<string, Record<string, number>>;
    expect(counts.ApexClass).toMatchObject({ identical: 1, changed: 0 });
    expect(counts.CustomObject).toMatchObject({ changed: 1 });
    expect(counts.Flow).toMatchObject({ only_in_a: 1 });
    expect(parsed.changed).toContain('CustomObject:Invoice__c');
    expect(parsed.only_in_a).toContain('Flow:UAT_Only_Flow');
  });

  it('fails cleanly when one side has no snapshot', async () => {
    const empty = seedConnection('empty-org', '00Dc000000000CCC', true);
    void empty;
    const result = await client.callTool({
      name: 'diff_orgs',
      arguments: { connection_a: 'acme-uat', connection_b: 'empty-org' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('refresh_snapshot');
  });
});

describe('diff_artifact', () => {
  it('returns a semantic XML diff for a changed object', async () => {
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'CustomObject',
        name: 'Invoice__c',
      },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('changed');
    expect(parsed.format).toBe('xml');
    const xmlDiff = parsed.xml_diff as { changes: Array<Record<string, unknown>> };
    expect(
      xmlDiff.changes.some(
        (c) => c.path === 'fields[Status__c].type' && c.a === 'Picklist' && c.b === 'Text',
      ),
    ).toBe(true);
  });

  it('diffs a child fragment (CustomField) across orgs', async () => {
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'CustomField',
        name: 'Invoice__c.Status__c',
      },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('changed');
  });

  it('reports one-sided presence without failing', async () => {
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'Flow',
        name: 'UAT_Only_Flow',
      },
    });
    expect(textOf(result)).toContain('only_in_a');
  });

  it('refuses when EITHER connection lacks metadata_read, and audits it', async () => {
    seedConnection('locked-org', '00Dd000000000DDD', false);
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'locked-org',
        type: 'CustomObject',
        name: 'Invoice__c',
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('metadata_read');
    const refusal = db
      .queryAuditEvents({})
      .find((e) => e.eventType === 'grant.refused' && e.tool === 'diff_artifact');
    expect(refusal).toBeTruthy();
  });
});

describe('S36: diff_artifact on bundles', () => {
  // S36 fix pin: diff_orgs hashes the CONCATENATED bundle content, so
  // diff_artifact must read the same concatenation — a main-file-only read
  // made an html-only LWC change show "changed" in diff_orgs and
  // "identical" in diff_artifact.
  function seedLwc(connId: string, html: string, hashSuffix: string): void {
    store.writeCurrent(
      connId,
      new Map([
        ['lwc/navCard/navCard.js', strToU8('export default class NavCard {}')],
        ['lwc/navCard/navCard.html', strToU8(html)],
        ['lwc/navCard/navCard.js-meta.xml', strToU8('<LightningComponentBundle/>')],
      ]),
      { clearDirs: ['lwc'] },
    );
    db.replaceArtifactsForTypes(connId, ['LightningComponentBundle'], [
      {
        connectionId: connId,
        type: 'LightningComponentBundle',
        apiName: 'navCard',
        filePath: 'lwc/navCard/navCard.js',
        contentHash: `lwc-${hashSuffix}`,
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt: '2026-10-02T00:00:00.000Z',
        content: '',
      },
    ]);
  }

  it('sees js-meta-only drift (the lenient-XML trap): isExposed flip diffs as changed TEXT', async () => {
    // The concatenation starts with an XML comment; the lenient parser used
    // to "parse" it (dropping all JS/CSS) and compare only the first root —
    // making exactly this change invisible. Pinned as TEXT format.
    store.writeCurrent(
      connA,
      new Map([
        ['lwc/navCard/navCard.js', strToU8('export default class NavCard {}')],
        [
          'lwc/navCard/navCard.js-meta.xml',
          strToU8('<LightningComponentBundle><isExposed>true</isExposed></LightningComponentBundle>'),
        ],
      ]),
      { clearDirs: ['lwc'] },
    );
    store.writeCurrent(
      connB,
      new Map([
        ['lwc/navCard/navCard.js', strToU8('export default class NavCard {}')],
        [
          'lwc/navCard/navCard.js-meta.xml',
          strToU8('<LightningComponentBundle><isExposed>false</isExposed></LightningComponentBundle>'),
        ],
      ]),
      { clearDirs: ['lwc'] },
    );
    for (const [connId, suffix] of [
      [connA, 'a'],
      [connB, 'b'],
    ] as const) {
      db.replaceArtifactsForTypes(connId, ['LightningComponentBundle'], [
        {
          connectionId: connId,
          type: 'LightningComponentBundle',
          apiName: 'navCard',
          filePath: 'lwc/navCard/navCard.js',
          contentHash: `lwc-${suffix}`,
          lastModifiedDate: null,
          lastModifiedBy: null,
          retrievedAt: '2026-10-02T00:00:00.000Z',
          content: '',
        },
      ]);
    }
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'LightningComponentBundle',
        name: 'navCard',
      },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('changed');
    expect(parsed.format).toBe('text');
  });

  it('reads bundles byte-identically to what the indexer hashed (parity pin)', async () => {
    seedLwc(connA, '<template>v1</template>', 'a');
    const { indexSnapshotFiles } = await import('../snapshot/indexer.js');
    const { readArtifactFromSnapshot } = await import('../tools/metadata.js');
    const indexed = indexSnapshotFiles(
      new Map([
        ['lwc/navCard/navCard.js', strToU8('export default class NavCard {}')],
        ['lwc/navCard/navCard.html', strToU8('<template>v1</template>')],
        ['lwc/navCard/navCard.js-meta.xml', strToU8('<LightningComponentBundle/>')],
      ]),
      [],
      '2026-10-02T00:00:00.000Z',
    ).find((a) => a.type === 'LightningComponentBundle')!;
    const read = readArtifactFromSnapshot(
      { db, store } as never,
      db.getConnection(connA)!,
      'LightningComponentBundle',
      'navCard',
    );
    // A framing/sort/join divergence between the indexer and the diff read
    // would silently re-split diff_orgs from diff_artifact — byte parity is
    // the contract.
    expect(read).toBe(indexed.content);
  });

  it('sees sibling-file drift: an html-only change diffs as changed with the html in hunks', async () => {
    seedLwc(connA, '<template>v1</template>', 'a');
    seedLwc(connB, '<template>v2</template>', 'b');
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'LightningComponentBundle',
        name: 'navCard',
      },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('changed');
    const text = JSON.stringify(parsed);
    expect(text).toContain('v1');
    expect(text).toContain('v2');
  });

  it('identical bundles diff identical (the concatenation is deterministic)', async () => {
    seedLwc(connA, '<template>same</template>', 'a');
    seedLwc(connB, '<template>same</template>', 'b');
    const result = await client.callTool({
      name: 'diff_artifact',
      arguments: {
        connection_a: 'acme-uat',
        connection_b: 'acme-prod',
        type: 'LightningComponentBundle',
        name: 'navCard',
      },
    });
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(parsed.status).toBe('identical');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { queryDependencies } from '../deps/graph.js';
import type { DependencyEdge } from '../core/types.js';

let tmp: string;
let db: ContrailDb;
const CONN = 'conn-1';

function edge(
  fromType: string,
  fromName: string,
  toType: string,
  toName: string,
): DependencyEdge {
  return { connectionId: CONN, fromType, fromName, toType, toName, source: 'extractor' };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-graph-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  db.replaceEdges(CONN, 'extractor', ['Flow', 'ApexClass'], [
    edge('Flow', 'Send_Invoice', 'ApexClass', 'InvoiceService'),
    edge('ApexClass', 'InvoiceService', 'CustomObject', 'Invoice__c'),
    edge('ApexClass', 'InvoiceService', 'ApexClass', 'InvoiceHelper'),
  ]);
  db.replaceEdges(CONN, 'org', ['ApexTrigger'], [
    {
      connectionId: CONN,
      fromType: 'ApexTrigger',
      fromName: 'InvoiceTrigger',
      toType: 'CustomObject',
      toName: 'Invoice__c',
      source: 'org',
    },
  ]);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('queryDependencies', () => {
  it('walks used_by across depths and reports blast radius by type', () => {
    const g = queryDependencies(db, CONN, 'CustomObject', 'Invoice__c', 'used_by', 2);
    const names = g.nodes.map((n) => `${n.type}:${n.name}@${n.depth}`);
    expect(names).toContain('ApexClass:InvoiceService@1');
    expect(names).toContain('ApexTrigger:InvoiceTrigger@1');
    expect(names).toContain('Flow:Send_Invoice@2');
    expect(g.blast_radius).toEqual({ ApexClass: 1, ApexTrigger: 1 });
    expect(g.truncated).toBe(false);
  });

  it('walks uses in the forward direction only', () => {
    const g = queryDependencies(db, CONN, 'ApexClass', 'InvoiceService', 'uses', 1);
    const names = g.nodes.map((n) => `${n.type}:${n.name}`);
    expect(names).toContain('CustomObject:Invoice__c');
    expect(names).toContain('ApexClass:InvoiceHelper');
    expect(names).not.toContain('Flow:Send_Invoice');
  });

  it('blast radius counts a dependent once even when both edge sources record it', () => {
    // The org dependency API sees the same Flow→ApexClass edge the extractor saw.
    db.replaceEdges(CONN, 'org', ['Flow'], [
      {
        connectionId: CONN,
        fromType: 'Flow',
        fromName: 'Send_Invoice',
        toType: 'ApexClass',
        toName: 'InvoiceService',
        source: 'org',
      },
    ]);
    const g = queryDependencies(db, CONN, 'ApexClass', 'InvoiceService', 'used_by', 1);
    expect(g.blast_radius).toEqual({ Flow: 1 });
    expect(g.edges[0]!.sources.sort()).toEqual(['extractor', 'org']);
  });

  it('is case-insensitive on the root name', () => {
    const g = queryDependencies(db, CONN, 'CustomObject', 'invoice__C', 'used_by', 1);
    expect(g.nodes.length).toBe(2);
  });

  it('partial edge replacement keeps other from_types intact', () => {
    // refresh only Flow edges — ApexClass edges must survive
    db.replaceEdges(CONN, 'extractor', ['Flow'], [
      edge('Flow', 'Send_Invoice', 'ApexClass', 'InvoiceHelper'),
    ]);
    const uses = queryDependencies(db, CONN, 'ApexClass', 'InvoiceService', 'uses', 1);
    expect(uses.nodes.map((n) => n.name)).toContain('Invoice__c');
    const flowUses = queryDependencies(db, CONN, 'Flow', 'Send_Invoice', 'uses', 1);
    expect(flowUses.nodes.map((n) => n.name)).toEqual(['InvoiceHelper']);
  });
});

describe('searchArtifacts (FTS + name)', () => {
  beforeEach(() => {
    const retrievedAt = '2026-08-06T00:00:00.000Z';
    db.replaceArtifactsForTypes(CONN, ['ApexClass', 'Flow'], [
      {
        connectionId: CONN,
        type: 'ApexClass',
        apiName: 'InvoiceService',
        filePath: 'classes/InvoiceService.cls',
        contentHash: 'h1',
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt,
        content: 'public class InvoiceService { InvoiceHelper.process(); }',
      },
      {
        connectionId: CONN,
        type: 'Flow',
        apiName: 'Send_Alert',
        filePath: 'flows/Send_Alert.flow',
        contentHash: 'h2',
        lastModifiedDate: null,
        lastModifiedBy: null,
        retrievedAt,
        content: '<Flow><label>Send Alert</label><object>Contact</object></Flow>',
      },
    ]);
  });

  it('matches by name fragment first', () => {
    const r = db.searchArtifacts(CONN, 'invoice', undefined, 10);
    expect(r[0]).toMatchObject({ type: 'ApexClass', apiName: 'InvoiceService', match: 'name' });
  });

  it('matches by content with a snippet', () => {
    const r = db.searchArtifacts(CONN, 'InvoiceHelper', undefined, 10);
    const content = r.find((x) => x.match === 'content');
    expect(content).toBeTruthy();
    expect(content!.snippet).toContain('InvoiceHelper');
  });

  it('respects type filters', () => {
    const r = db.searchArtifacts(CONN, 'Contact', ['ApexClass'], 10);
    expect(r).toEqual([]);
  });

  it('survives FTS-hostile query strings', () => {
    expect(() => db.searchArtifacts(CONN, '"; DROP TABLE -- NEAR(', undefined, 10)).not.toThrow();
    expect(() => db.searchArtifacts(CONN, 'a', undefined, 10)).not.toThrow();
  });

  it('search rows disappear when the connection is deleted', () => {
    // simulate connection removal purging index data
    db.deleteConnection(CONN);
    expect(db.searchArtifacts(CONN, 'invoice', undefined, 10)).toEqual([]);
    expect(db.listArtifacts(CONN)).toEqual([]);
  });
});

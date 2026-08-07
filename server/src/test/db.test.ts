import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { emptyGrantSet } from '../core/grants.js';

let tmp: string;
let db: ContrailDb;

function sampleConnection(alias = 'acme-prod') {
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  return {
    alias,
    instanceUrl: 'https://acme.my.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00D000000000001EAA',
    orgName: 'Acme',
    orgType: 'production' as const,
    isSandbox: false,
    username: 'ryley@acme.com',
    userId: '005000000000001',
    grants,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-db-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('connections', () => {
  it('round-trips a connection record', () => {
    const rec = db.insertConnection(sampleConnection());
    const loaded = db.getConnection(rec.id);
    expect(loaded).toEqual(rec);
    expect(loaded!.grants.metadata_read).toBe(true);
    expect(loaded!.grants.data_write).toBe(false);
  });

  it('resolves by alias case-insensitively, then by id', () => {
    const rec = db.insertConnection(sampleConnection('Acme-UAT'));
    expect(db.resolveConnection('acme-uat')?.id).toBe(rec.id);
    expect(db.resolveConnection(rec.id)?.id).toBe(rec.id);
    expect(db.resolveConnection('nope')).toBeNull();
  });

  it('rejects duplicate aliases', () => {
    db.insertConnection(sampleConnection('dup'));
    expect(() => db.insertConnection(sampleConnection('DUP'))).toThrow();
  });

  it('updates grants and auth fields independently', () => {
    const rec = db.insertConnection(sampleConnection());
    const grants = emptyGrantSet();
    grants.data_read = true;
    db.updateGrants(rec.id, grants);
    expect(db.getConnection(rec.id)!.grants.data_read).toBe(true);
    expect(db.getConnection(rec.id)!.grants.metadata_read).toBe(false);

    const updated = db.updateConnectionAuth(rec.id, {
      ...sampleConnection(),
      orgId: '00DNEW0000000001EAA',
      grants,
    });
    expect(updated.orgId).toBe('00DNEW0000000001EAA');
    expect(updated.alias).toBe('acme-prod');
  });

  it('deletes connections', () => {
    const rec = db.insertConnection(sampleConnection());
    db.deleteConnection(rec.id);
    expect(db.getConnection(rec.id)).toBeNull();
    expect(db.listConnections()).toHaveLength(0);
  });
});

describe('audit events', () => {
  it('stores and filters by connection and time, newest first', () => {
    const a = db.insertAuditEvent({ eventType: 'connection.created', connectionId: 'c1', outcome: 'success' });
    db.insertAuditEvent({ eventType: 'grant.refused', connectionId: 'c2', outcome: 'refused' });
    db.insertAuditEvent({ eventType: 'connection.removed', connectionId: 'c1', outcome: 'success' });

    const forC1 = db.queryAuditEvents({ connectionId: 'c1' });
    expect(forC1).toHaveLength(2);
    expect(forC1.every((e) => e.connectionId === 'c1')).toBe(true);

    const since = db.queryAuditEvents({ since: a.ts });
    expect(since.length).toBeGreaterThanOrEqual(3);

    expect(db.queryAuditEvents({ limit: 1 })).toHaveLength(1);
  });

  it('preserves detail JSON', () => {
    db.insertAuditEvent({
      eventType: 'connection.grants_changed',
      outcome: 'success',
      detail: { before: { data_read: false }, after: { data_read: true } },
    });
    const [evt] = db.queryAuditEvents({});
    expect(evt!.detail).toEqual({ before: { data_read: false }, after: { data_read: true } });
  });
});

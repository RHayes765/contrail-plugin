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

describe('S45: deploy request accessors (void + sweep expiry)', () => {
  function pending(
    connectionId: string,
    code: string,
    expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
    payloadPath: string | null = null,
  ) {
    return db.insertDeployRequest({
      connectionId,
      kind: 'deploy',
      confirmationCode: code,
      expiresAt,
      payloadPath,
      summaryJson: '{}',
    });
  }

  it('voidRequestWithResult voids exactly one still-validated row and stores the reason', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'ABCD-1234');
    const result = JSON.stringify({ executed: false, target_moved: true, refusal: 'TARGET MOVED' });
    expect(db.voidRequestWithResult(req.id, result)).toBe(true);

    const voided = db.findRequestByCode(conn.id, 'deploy', 'ABCD-1234');
    expect(voided?.status).toBe('superseded');
    expect(voided?.resultJson).toBe(result);

    // Already voided: a second void loses, a claim loses, the stored text stays.
    expect(db.voidRequestWithResult(req.id, '{"second":true}')).toBe(false);
    expect(db.claimRequestForExecution(req.id)).toBe(false);
    expect(db.findRequestByCode(conn.id, 'deploy', 'ABCD-1234')?.resultJson).toBe(result);
  });

  it('a claimed request cannot be voided — the claim and the void are mutually exclusive', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'ABCD-5678');
    expect(db.claimRequestForExecution(req.id)).toBe(true);
    expect(db.voidRequestWithResult(req.id, '{"target_moved":true}')).toBe(false);
    expect(db.getDeployRequestStatus(req.id)).toBe('executing');
    expect(db.findRequestByCode(conn.id, 'deploy', 'ABCD-5678')?.resultJson).toBeNull();
    // Unknown id: false, nothing touched.
    expect(db.voidRequestWithResult('no-such-request', '{}')).toBe(false);
  });

  it('expireStaleValidatedRequests flips past-due validated rows on every connection and returns their payload paths (RETURNING)', () => {
    const a = db.insertConnection(sampleConnection('sweep-a'));
    const b = db.insertConnection(sampleConnection('sweep-b'));
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2999-01-01T00:00:00.000Z';
    const stale = pending(a.id, 'AAAA-0001', past, 'C:/deploys/stale.zip');
    const staleNoZip = pending(b.id, 'BBBB-0001', past);
    const fresh = pending(a.id, 'AAAA-0002', future, 'C:/deploys/fresh.zip');
    const executed = pending(b.id, 'BBBB-0002', past, 'C:/deploys/done.zip');
    db.finishDeployRequest(executed.id, 'executed', '{}');
    const claimed = pending(b.id, 'BBBB-0003', past, 'C:/deploys/claimed.zip');
    expect(db.claimRequestForExecution(claimed.id)).toBe(true);

    const expired = db.expireStaleValidatedRequests('2026-06-01T00:00:00.000Z');
    expect(expired.map((r) => r.id).sort()).toEqual([stale.id, staleNoZip.id].sort());
    expect(expired.find((r) => r.id === stale.id)?.payloadPath).toBe('C:/deploys/stale.zip');
    expect(expired.find((r) => r.id === staleNoZip.id)?.payloadPath).toBeNull();
    expect(db.getDeployRequestStatus(stale.id)).toBe('expired');
    expect(db.getDeployRequestStatus(staleNoZip.id)).toBe('expired');
    // Only 'validated' rows are touched: fresh codes, executed and executing rows stay.
    expect(db.getDeployRequestStatus(fresh.id)).toBe('validated');
    expect(db.getDeployRequestStatus(executed.id)).toBe('executed');
    expect(db.getDeployRequestStatus(claimed.id)).toBe('executing');

    // Idempotent, and an expires_at EQUAL to now is not yet past due.
    expect(db.expireStaleValidatedRequests('2026-06-01T00:00:00.000Z')).toEqual([]);
    expect(db.expireStaleValidatedRequests(future)).toEqual([]);
    expect(db.getDeployRequestStatus(fresh.id)).toBe('validated');

    // An expired code can no longer be claimed or voided.
    expect(db.claimRequestForExecution(stale.id)).toBe(false);
    expect(db.voidRequestWithResult(stale.id, '{}')).toBe(false);
  });

  it('expireValidatedRequest (claimCode lazy expiry) touches only a still-validated row', () => {
    const conn = db.insertConnection(sampleConnection());
    const claimed = pending(conn.id, 'CCCC-0001', '2026-01-01T00:00:00.000Z');
    expect(db.claimRequestForExecution(claimed.id)).toBe(true);
    expect(db.expireValidatedRequest(claimed.id)).toBe(false);
    expect(db.getDeployRequestStatus(claimed.id)).toBe('executing');

    const stale = pending(conn.id, 'CCCC-0002', '2026-01-01T00:00:00.000Z');
    expect(db.expireValidatedRequest(stale.id)).toBe(true);
    expect(db.getDeployRequestStatus(stale.id)).toBe('expired');
    expect(db.expireValidatedRequest(stale.id)).toBe(false);
  });

  it('registerFailedAttempt never locks (or reports) a row that is no longer validated — even one claimed between its SELECT and its UPDATE', () => {
    const conn = db.insertConnection(sampleConnection());
    // Plainly claimed first: nothing pending.
    const first = pending(conn.id, 'DDDD-0001');
    expect(db.claimRequestForExecution(first.id)).toBe(true);
    expect(db.registerFailedAttempt(conn.id, 'deploy', 1)).toMatchObject({
      pendingExisted: false,
      locked: false,
    });
    expect(db.getDeployRequestStatus(first.id)).toBe('executing');

    // The cross-process interleaving: another process claims the row right
    // after this call's SELECT found it 'validated'.
    const second = pending(conn.id, 'DDDD-0002');
    const inner = (db as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const prepare = inner.prepare;
    inner.prepare = (sql: string) => {
      const stmt = prepare.call(inner, sql) as { get: (...a: unknown[]) => unknown };
      if (!sql.includes('SELECT id, failed_attempts, payload_path')) return stmt;
      return {
        get: (...args: unknown[]) => {
          const row = stmt.get(...args);
          inner.prepare = prepare;
          expect(db.claimRequestForExecution(second.id)).toBe(true);
          return row;
        },
      };
    };
    try {
      const attempt = db.registerFailedAttempt(conn.id, 'deploy', 1);
      expect(attempt).toMatchObject({ pendingExisted: false, locked: false });
      expect(attempt.payloadPath).toBeUndefined();
    } finally {
      inner.prepare = prepare;
    }
    expect(db.getDeployRequestStatus(second.id)).toBe('executing');

    // A row still pending is counted, then locked at the threshold.
    const third = pending(conn.id, 'DDDD-0003', undefined, 'C:/deploys/third.zip');
    expect(db.registerFailedAttempt(conn.id, 'deploy', 2)).toMatchObject({
      pendingExisted: true,
      locked: false,
      attemptsRemaining: 1,
    });
    expect(db.registerFailedAttempt(conn.id, 'deploy', 2)).toMatchObject({
      pendingExisted: true,
      locked: true,
      requestId: third.id,
      payloadPath: 'C:/deploys/third.zip',
    });
    expect(db.getDeployRequestStatus(third.id)).toBe('locked');
  });
});

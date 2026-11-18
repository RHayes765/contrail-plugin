import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.useRealTimers();
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

describe('S46: governance accessors (B)', () => {
  function pending(connectionId: string, code: string, summary: Record<string, unknown> = { changes: [] }) {
    return db.insertDeployRequest({
      connectionId,
      kind: 'deploy',
      confirmationCode: code,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify(summary),
    });
  }

  it('getDeployRequest returns the row by id, any status; an unknown id is null', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'EEEE-0001');
    expect(db.getDeployRequest(req.id)).toEqual(req);
    expect(db.claimRequestForExecution(req.id)).toBe(true);
    expect(db.getDeployRequest(req.id)?.status).toBe('executing');
    expect(db.getDeployRequest('no-such-request')).toBeNull();
  });

  it('patchDeployRequestSummary merges into a validated row and leaves any other row untouched', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'EEEE-0002', { changes: [1], governance: { v: 1, ticket: 'ACME-1' } });
    expect(
      db.patchDeployRequestSummary(req.id, (s) => ({ ...s, page_view: { v: 1, kind: 'deploy' } })),
    ).toBe(true);
    expect(JSON.parse(db.getDeployRequest(req.id)!.summaryJson)).toEqual({
      changes: [1],
      governance: { v: 1, ticket: 'ACME-1' },
      page_view: { v: 1, kind: 'deploy' },
    });

    // Executing: false, nothing written, the patch function never runs.
    expect(db.claimRequestForExecution(req.id)).toBe(true);
    const before = db.getDeployRequest(req.id)!.summaryJson;
    let ran = false;
    expect(
      db.patchDeployRequestSummary(req.id, (s) => {
        ran = true;
        return { ...s, late: true };
      }),
    ).toBe(false);
    expect(ran).toBe(false);
    expect(db.getDeployRequest(req.id)!.summaryJson).toBe(before);

    // Superseded: false, untouched.
    const other = pending(conn.id, 'EEEE-0003');
    expect(db.supersedePendingRequests(conn.id, 'deploy')).toBe(1);
    expect(db.patchDeployRequestSummary(other.id, (s) => ({ ...s, late: true }))).toBe(false);
    expect(db.getDeployRequest(other.id)!.summaryJson).toBe(JSON.stringify({ changes: [] }));
    expect(db.patchDeployRequestSummary('no-such-request', (s) => s)).toBe(false);
  });

  it('a patch that races a claim cannot overwrite it: the UPDATE is predicated on validated', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'EEEE-0004');
    // The claim lands between the patch's read and its write.
    const result = db.patchDeployRequestSummary(req.id, (s) => {
      expect(db.claimRequestForExecution(req.id)).toBe(true);
      return { ...s, governance: { v: 1, execute_check: { at: 'x' } } };
    });
    expect(result).toBe(false);
    const row = db.getDeployRequest(req.id)!;
    expect(row.status).toBe('executing');
    expect(row.summaryJson).toBe(JSON.stringify({ changes: [] }));
  });

  it('a patch function that throws writes nothing', () => {
    const conn = db.insertConnection(sampleConnection());
    const req = pending(conn.id, 'EEEE-0005');
    expect(() =>
      db.patchDeployRequestSummary(req.id, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.getDeployRequest(req.id)!.summaryJson).toBe(JSON.stringify({ changes: [] }));
    expect(db.patchDeployRequestSummary(req.id, (s) => ({ ...s, ok: true }))).toBe(true);
  });

  it('queryDeployRequests filters by connection, created_at window and id, and clamps the limit', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = db.insertConnection(sampleConnection('acme-prod'));
    const b = db.insertConnection(sampleConnection('acme-uat'));
    vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
    const a1 = pending(a.id, 'AAAA-1001');
    vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z'));
    const b1 = pending(b.id, 'BBBB-1001');
    vi.setSystemTime(new Date('2026-11-03T10:00:00.000Z'));
    const a2 = pending(a.id, 'AAAA-1002');

    expect(db.queryDeployRequests({}).map((r) => r.id)).toEqual([a2.id, b1.id, a1.id]);
    expect(db.queryDeployRequests({ connectionId: a.id }).map((r) => r.id)).toEqual([a2.id, a1.id]);
    expect(db.queryDeployRequests({ since: '2026-11-02T10:00:00.000Z' }).map((r) => r.id)).toEqual([a2.id, b1.id]);
    expect(db.queryDeployRequests({ until: '2026-11-02T10:00:00.000Z' }).map((r) => r.id)).toEqual([b1.id, a1.id]);
    expect(
      db.queryDeployRequests({ since: '2026-11-01T12:00:00.000Z', until: '2026-11-02T12:00:00.000Z' }).map((r) => r.id),
    ).toEqual([b1.id]);
    expect(db.queryDeployRequests({ id: a1.id })).toEqual([a1]);
    expect(db.queryDeployRequests({ id: a1.id, connectionId: b.id })).toEqual([]);
    expect(db.queryDeployRequests({ limit: 0 })).toHaveLength(1);
    expect(db.queryDeployRequests({ limit: -5 })).toHaveLength(1);
    expect(db.queryDeployRequests({ limit: 2 })).toHaveLength(2);

    // Default 200, ceiling 1000.
    vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
    for (let i = 0; i < 1003; i++) pending(a.id, `CCCC-${String(i).padStart(4, '0')}`);
    expect(db.queryDeployRequests({})).toHaveLength(200);
    expect(db.queryDeployRequests({ limit: 5000 })).toHaveLength(1000);
  });

  it('queryDeployRequests offset pages without gaps or repeats under created_at DESC, id DESC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const conn = db.insertConnection(sampleConnection());
    const ids: Array<{ id: string; createdAt: string }> = [];
    // Three instants, several rows each: ties are broken by id.
    for (const at of ['2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-11-03T10:00:00.000Z']) {
      vi.setSystemTime(new Date(at));
      for (let i = 0; i < 5; i++) {
        const r = pending(conn.id, `DDDD-${ids.length}`);
        ids.push({ id: r.id, createdAt: r.createdAt });
      }
    }
    const expected = [...ids]
      .sort((x, y) => (x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1))
      .map((r) => r.id);
    const paged: string[] = [];
    for (let offset = 0; offset < 20; offset += 4) {
      paged.push(...db.queryDeployRequests({ connectionId: conn.id, limit: 4, offset }).map((r) => r.id));
    }
    expect(paged).toEqual(expected);
    expect(new Set(paged).size).toBe(15);
    expect(db.queryDeployRequests({ connectionId: conn.id, offset: -3, limit: 1 })[0]!.id).toBe(expected[0]);
  });

  it('queryAuditEvents: requestId names one request; a malformed id is refused, never matched loosely', () => {
    const r1 = '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a81';
    const r2 = '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a82';
    db.insertAuditEvent({ eventType: 'deploy.validated', outcome: 'success', detail: { requestId: r1 } });
    db.insertAuditEvent({ eventType: 'policy.refused', outcome: 'refused', detail: { requestId: r1, phase: 'execute' } });
    db.insertAuditEvent({ eventType: 'deploy.validated', outcome: 'success', detail: { requestId: r2 } });
    db.insertAuditEvent({ eventType: 'deploy.superseded', outcome: 'success', detail: { count: 1 } });

    expect(db.queryAuditEvents({ requestId: r1 }).map((e) => e.eventType).sort()).toEqual([
      'deploy.validated',
      'policy.refused',
    ]);
    expect(db.queryAuditEvents({ requestId: r1.toUpperCase() })).toHaveLength(2);
    expect(db.queryAuditEvents({ requestId: r2 })).toHaveLength(1);
    expect(() => db.queryAuditEvents({ requestId: '%' })).toThrow(/UUID/);
    expect(() => db.queryAuditEvents({ requestId: '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a8_' })).toThrow(/UUID/);
    expect(() => db.queryAuditEvents({ requestId: '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a8%' })).toThrow(/UUID/);
    expect(() => db.queryAuditEvents({ requestId: '' })).toThrow(/UUID/);
  });

  it('queryAuditEvents: requestId also finds a row whose requestIds list names it (the expiry sweep)', () => {
    const r1 = '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a81';
    const r2 = '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a82';
    const r3 = '3f2b6c1e-8a4d-4f7e-9c2a-1b0d5e6f7a83';
    db.insertAuditEvent({ eventType: 'deploy.validated', outcome: 'success', detail: { requestId: r1 } });
    db.insertAuditEvent({
      eventType: 'deploy.expired',
      tool: 'validate_deploy',
      outcome: 'success',
      detail: { count: 2, requestIds: [r2, r1] },
    });

    expect(db.queryAuditEvents({ requestId: r1 }).map((e) => e.eventType).sort()).toEqual([
      'deploy.expired',
      'deploy.validated',
    ]);
    expect(db.queryAuditEvents({ requestId: r2 }).map((e) => e.eventType)).toEqual(['deploy.expired']);
    expect(db.queryAuditEvents({ requestId: r3 })).toHaveLength(0);
  });

  it('queryAuditEvents: eventType exact or by a dot-terminated prefix; anything else is refused', () => {
    db.insertAuditEvent({ eventType: 'policy.refused', outcome: 'refused' });
    db.insertAuditEvent({ eventType: 'policy.config_seen', outcome: 'success' });
    db.insertAuditEvent({ eventType: 'policyx.other', outcome: 'success' });
    db.insertAuditEvent({ eventType: 'deploy.validated', outcome: 'success' });

    expect(db.queryAuditEvents({ eventType: 'policy.refused' }).map((e) => e.eventType)).toEqual(['policy.refused']);
    expect(db.queryAuditEvents({ eventType: 'policy.' }).map((e) => e.eventType).sort()).toEqual([
      'policy.config_seen',
      'policy.refused',
    ]);
    // '_' in a type is literal, never a wildcard.
    expect(db.queryAuditEvents({ eventType: 'policy.config_seen' })).toHaveLength(1);
    expect(db.queryAuditEvents({ eventType: 'policy.config_se' })).toHaveLength(0);
    expect(() => db.queryAuditEvents({ eventType: 'policy' })).toThrow(/event type/);
    expect(() => db.queryAuditEvents({ eventType: 'policy.%' })).toThrow(/event type/);
    expect(() => db.queryAuditEvents({ eventType: 'Policy.refused' })).toThrow(/event type/);
  });

  it('queryAuditEvents: until is inclusive and combines with since and connection', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
    db.insertAuditEvent({ eventType: 'connection.created', connectionId: 'c1', outcome: 'success' });
    vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z'));
    db.insertAuditEvent({ eventType: 'grant.refused', connectionId: 'c1', outcome: 'refused' });
    vi.setSystemTime(new Date('2026-11-03T10:00:00.000Z'));
    db.insertAuditEvent({ eventType: 'connection.removed', connectionId: 'c2', outcome: 'success' });

    expect(db.queryAuditEvents({ until: '2026-11-02T10:00:00.000Z' }).map((e) => e.eventType)).toEqual([
      'grant.refused',
      'connection.created',
    ]);
    expect(
      db.queryAuditEvents({ since: '2026-11-02T00:00:00.000Z', until: '2026-11-03T23:00:00.000Z' }).map((e) => e.eventType),
    ).toEqual(['connection.removed', 'grant.refused']);
    expect(db.queryAuditEvents({ connectionId: 'c1', until: '2026-11-01T23:00:00.000Z' }).map((e) => e.eventType)).toEqual([
      'connection.created',
    ]);
  });

  it('queryAuditEvents: since and until are compared as the instants they name; a bound that is not a timestamp is refused', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T06:24:24.484Z'));
    db.insertAuditEvent({ eventType: 'connection.created', connectionId: 'c1', outcome: 'success' });

    // No milliseconds: the instant is .000, so an event 484 ms later is after it.
    expect(db.queryAuditEvents({ until: '2026-11-18T06:24:24Z' })).toHaveLength(0);
    expect(db.queryAuditEvents({ since: '2026-11-18T06:24:24Z' })).toHaveLength(1);
    expect(db.queryAuditEvents({ until: '2026-11-18T06:24:25Z' })).toHaveLength(1);
    // An offset names an instant: 07:54:24+02:00 is 05:54:24Z, half an hour before the event.
    expect(db.queryAuditEvents({ until: '2026-11-18T07:54:24+02:00' })).toHaveLength(0);
    expect(db.queryAuditEvents({ since: '2026-11-18T07:54:24+02:00' })).toHaveLength(1);
    expect(db.queryAuditEvents({ until: '2026-11-18T08:24:24.484+02:00' })).toHaveLength(1);
    expect(db.queryAuditEvents({ since: '2026-11-18T08:24:24.485+02:00' })).toHaveLength(0);

    expect(() => db.queryAuditEvents({ until: 'yesterday' })).toThrow(
      'until must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), got "yesterday".',
    );
    expect(() => db.queryAuditEvents({ since: 'not a time' })).toThrow(
      'since must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), got "not a time".',
    );
  });
});

describe('S46: member-refresh accessors (C)', () => {
  function artifact(type: string, apiName: string, filePath: string | null, over: Record<string, unknown> = {}) {
    return {
      connectionId: 'conn-a',
      type,
      apiName,
      filePath,
      contentHash: `hash-${apiName}`,
      lastModifiedDate: '2026-11-01T00:00:00.000Z',
      lastModifiedBy: 'Example User',
      retrievedAt: '2026-11-01T00:00:00.000Z',
      content: `body of ${apiName}`,
      ...over,
    };
  }

  function seed() {
    db.replaceArtifactsForTypes(
      'conn-a',
      ['CustomObject', 'CustomField', 'ApexClass'],
      [
        artifact('CustomObject', 'Invoice__c', 'objects/Invoice__c.object'),
        artifact('CustomField', 'Invoice__c.Amount__c', 'objects/Invoice__c.object'),
        artifact('CustomField', 'Invoice__c.Status__c', 'objects/Invoice__c.object'),
        artifact('ApexClass', 'InvoiceService', 'classes/InvoiceService.cls'),
        artifact('ApexClass', 'InvoiceSelector', 'classes/InvoiceSelector.cls'),
      ],
    );
    db.replaceArtifactsForTypes('conn-b', ['CustomObject'], [
      { ...artifact('CustomObject', 'Invoice__c', 'objects/Invoice__c.object'), connectionId: 'conn-b' },
    ]);
  }

  const idOf = (type: string, name: string) => db.getArtifact('conn-a', type, name)!.id;

  it('listArtifactsByFilePath returns every row stored under one file, on one connection', () => {
    seed();
    expect(
      db.listArtifactsByFilePath('conn-a', 'objects/Invoice__c.object').map((a) => `${a.type}:${a.apiName}`),
    ).toEqual(['CustomField:Invoice__c.Amount__c', 'CustomField:Invoice__c.Status__c', 'CustomObject:Invoice__c']);
    expect(db.listArtifactsByFilePath('conn-b', 'objects/Invoice__c.object')).toHaveLength(1);
    expect(db.listArtifactsByFilePath('conn-a', 'objects/Missing__c.object')).toEqual([]);
  });

  it('replaceArtifactRows replaces named rows only; every other row keeps its id', () => {
    seed();
    const keep = idOf('ApexClass', 'InvoiceSelector');
    const keepB = db.getArtifact('conn-b', 'CustomObject', 'Invoice__c')!.id;
    const oldService = idOf('ApexClass', 'InvoiceService');
    const result = db.replaceArtifactRows(
      'conn-a',
      [
        { type: 'CustomObject', apiName: 'Invoice__c' },
        { type: 'CustomField', apiName: 'Invoice__c.Amount__c' },
        { type: 'CustomField', apiName: 'Invoice__c.Status__c' },
      ],
      [
        artifact('CustomObject', 'Invoice__c', 'objects/Invoice__c.object', { retrievedAt: '2026-11-17T00:00:00.000Z' }),
        artifact('CustomField', 'Invoice__c.Amount__c', 'objects/Invoice__c.object', { retrievedAt: '2026-11-17T00:00:00.000Z' }),
        artifact('ApexClass', 'InvoiceService', 'classes/InvoiceService.cls', {
          retrievedAt: '2026-11-17T00:00:00.000Z',
          content: 'refreshed body',
        }),
      ],
    );
    expect(result).toEqual({ deleted: 4, inserted: 3 });
    expect(idOf('ApexClass', 'InvoiceSelector')).toBe(keep);
    expect(db.getArtifact('conn-b', 'CustomObject', 'Invoice__c')!.id).toBe(keepB);
    expect(idOf('ApexClass', 'InvoiceService')).not.toBe(oldService);
    expect(db.getArtifact('conn-a', 'ApexClass', 'InvoiceService')!.retrievedAt).toBe('2026-11-17T00:00:00.000Z');
    // The dropped child is gone; the selector kept its stamp.
    expect(db.getArtifact('conn-a', 'CustomField', 'Invoice__c.Status__c')).toBeNull();
    expect(db.getArtifact('conn-a', 'ApexClass', 'InvoiceSelector')!.retrievedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(db.countArtifactsByType('conn-a')).toEqual({ ApexClass: 2, CustomField: 1, CustomObject: 1 });
    // FTS follows: the old body is gone, the new one is found, nothing is listed twice.
    expect(db.searchArtifacts('conn-a', 'refreshed', undefined, 10).map((r) => r.apiName)).toEqual(['InvoiceService']);
    expect(db.searchArtifacts('conn-a', 'Status__c', undefined, 10)).toEqual([]);
    expect(
      db.searchArtifacts('conn-a', 'InvoiceService', undefined, 10).filter((r) => r.apiName === 'InvoiceService'),
    ).toHaveLength(1);
  });

  it('replaceArtifactRows matches api names case-insensitively, so a case-changed rename leaves one row', () => {
    seed();
    const result = db.replaceArtifactRows('conn-a', [], [
      artifact('ApexClass', 'invoiceservice', 'classes/invoiceservice.cls'),
    ]);
    expect(result).toEqual({ deleted: 1, inserted: 1 });
    expect(db.listArtifacts('conn-a', 'ApexClass').map((a) => a.apiName)).toEqual(['InvoiceSelector', 'invoiceservice']);
    // The type is matched exactly: a row of another type with the same name stays.
    db.replaceArtifactRows('conn-a', [{ type: 'ApexTrigger', apiName: 'InvoiceSelector' }], []);
    expect(db.getArtifact('conn-a', 'ApexClass', 'InvoiceSelector')).not.toBeNull();
  });

  it('replaceArtifactRows deletes in chunks: 450 named rows and their FTS rows go in one call', () => {
    const many = Array.from({ length: 450 }, (_, i) => artifact('ApexClass', `Bulk${i}`, `classes/Bulk${i}.cls`));
    db.replaceArtifactsForTypes('conn-a', ['ApexClass'], [...many, artifact('ApexClass', 'Survivor', 'classes/Survivor.cls')]);
    const result = db.replaceArtifactRows(
      'conn-a',
      many.map((a) => ({ type: a.type, apiName: a.apiName })),
      [],
    );
    expect(result).toEqual({ deleted: 450, inserted: 0 });
    expect(db.listArtifacts('conn-a').map((a) => a.apiName)).toEqual(['Survivor']);
    expect(db.searchArtifacts('conn-a', 'body', undefined, 1000).map((r) => r.apiName)).toEqual(['Survivor']);
  });

  it('replaceEdgesFromArtifacts: re-read components lose their extractor edges, removed ones every edge; edges TO them stay', () => {
    const edge = (fromType: string, fromName: string, toType: string, toName: string) => ({
      connectionId: 'conn-a',
      fromType,
      fromName,
      toType,
      toName,
      source: 'extractor' as const,
    });
    db.replaceEdges('conn-a', 'extractor', ['ApexClass', 'Flow'], [
      edge('ApexClass', 'InvoiceService', 'CustomObject', 'Invoice__c'),
      edge('ApexClass', 'InvoiceSelector', 'CustomObject', 'Invoice__c'),
      edge('ApexClass', 'OldHelper', 'ApexClass', 'InvoiceService'),
      edge('Flow', 'Invoice_Flow', 'ApexClass', 'InvoiceService'),
    ]);
    db.replaceEdges('conn-a', 'org', ['ApexClass'], [
      { ...edge('ApexClass', 'InvoiceService', 'CustomField', 'Invoice__c.Amount__c'), source: 'org' },
      { ...edge('ApexClass', 'OldHelper', 'CustomObject', 'Invoice__c'), source: 'org' },
    ]);

    db.replaceEdgesFromArtifacts('conn-a', {
      refreshed: [{ type: 'ApexClass', name: 'invoiceservice' }],
      removed: [{ type: 'ApexClass', name: 'OldHelper' }],
      edges: [{ ...edge('ApexClass', 'InvoiceService', 'CustomField', 'Invoice__c.Status__c'), source: 'org' }],
    });

    const from = (name: string) =>
      db.edgesFrom('conn-a', 'ApexClass', name).map((e) => `${e.source}:${e.toType}:${e.toName}`).sort();
    // Re-read: the extractor edge was replaced (the new one stored as extractor); the org edge stays.
    expect(from('InvoiceService')).toEqual([
      'extractor:CustomField:Invoice__c.Status__c',
      'org:CustomField:Invoice__c.Amount__c',
    ]);
    // Removed: both sources gone.
    expect(from('OldHelper')).toEqual([]);
    // Untouched component and edges TO the re-read one stay.
    expect(from('InvoiceSelector')).toEqual(['extractor:CustomObject:Invoice__c']);
    expect(db.edgesTo('conn-a', 'ApexClass', 'InvoiceService').map((e) => `${e.fromType}:${e.fromName}`)).toEqual([
      'Flow:Invoice_Flow',
    ]);
  });

  it('amendDeployRequestResult amends an executed row only, and leaves executed_at unchanged', () => {
    const conn = db.insertConnection(sampleConnection());
    const mk = (code: string) =>
      db.insertDeployRequest({
        connectionId: conn.id,
        kind: 'deploy',
        confirmationCode: code,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        summaryJson: '{}',
      });
    const done = mk('FFFF-0001');
    db.finishDeployRequest(done.id, 'executed', '{"snapshot":{"status":"pending"}}');
    const executedAt = db.getDeployRequest(done.id)!.executedAt;
    expect(executedAt).not.toBeNull();
    expect(db.amendDeployRequestResult(done.id, '{"snapshot":{"status":"complete"}}')).toBe(true);
    const amended = db.getDeployRequest(done.id)!;
    expect(amended.resultJson).toBe('{"snapshot":{"status":"complete"}}');
    expect(amended.status).toBe('executed');
    expect(amended.executedAt).toBe(executedAt);

    const failed = mk('FFFF-0002');
    db.finishDeployRequest(failed.id, 'execution_failed', '{"error":"x"}');
    expect(db.amendDeployRequestResult(failed.id, '{}')).toBe(false);
    expect(db.getDeployRequest(failed.id)!.resultJson).toBe('{"error":"x"}');
    const validated = mk('FFFF-0003');
    expect(db.amendDeployRequestResult(validated.id, '{}')).toBe(false);
    expect(db.getDeployRequest(validated.id)!.resultJson).toBeNull();
    expect(db.amendDeployRequestResult('no-such-request', '{}')).toBe(false);
  });
});

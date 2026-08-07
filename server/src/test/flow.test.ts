import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { AuditLog } from '../core/audit.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { ConnectFlowManager, type FlowOps } from '../connect/flow.js';
import type { TokenResponse } from '../salesforce/oauth.js';

const FAKE_TOKENS: TokenResponse = {
  access_token: 'AT-secret',
  refresh_token: 'RT-secret',
  instance_url: 'https://acme.my.salesforce.com',
  id: 'https://login.salesforce.com/id/00Dxx0000000001EAA/005xx0000000001',
  token_type: 'Bearer',
};

function makeConfig(): ContrailConfig {
  return {
    salesforce: { ...DEFAULT_CONFIG.salesforce, clientId: 'TestClient' },
    oauth: {
      // Port 0 → ephemeral; the bound port comes from activeConnectPort().
      callbackPort: 0,
      callbackPath: '/OauthRedirect',
      flowTimeoutMs: 5_000,
      toolWaitMs: 100,
    },
  };
}

function makeOps(overrides: Partial<FlowOps> = {}): { ops: FlowOps; opened: string[] } {
  const opened: string[] = [];
  const ops: FlowOps = {
    exchangeCode: async () => ({ ...FAKE_TOKENS }),
    fetchOrgInfo: async () => ({
      orgId: '00Dxx0000000001EAA',
      orgName: 'Acme',
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      trialExpirationDate: null,
    }),
    fetchIdentity: async () => ({
      username: 'ryley@acme.com.uat',
      userId: '005xx0000000001',
      displayName: 'Ryley Hayes',
    }),
    revokeToken: async () => ({ ok: true }),
    openBrowser: async (url) => {
      opened.push(url);
    },
    ...overrides,
  };
  return { ops, opened };
}

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let audit: AuditLog;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-flow-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  audit = new AuditLog(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function startFlow(manager: ConnectFlowManager, opened: string[], opts: { login?: string; label?: string } = {}) {
  const outcome = await manager.connectOrg({ login: 'sandbox', ...opts });
  expect(outcome.status).toBe('pending');
  const port = manager.activeConnectPort();
  expect(port).toBeTruthy();
  const authorize = new URL(opened[0]!);
  const state = authorize.searchParams.get('state')!;
  return { port: port!, state };
}

async function completeCallback(port: number, state: string): Promise<string> {
  const cb = await fetch(
    `http://127.0.0.1:${port}/OauthRedirect?code=FAKECODE&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  );
  expect(cb.status).toBe(302);
  const location = cb.headers.get('location')!;
  expect(location).toMatch(/^\/setup\?s=/);
  return location;
}

describe('connect flow (end-to-end with stubbed Salesforce)', () => {
  it('runs callback → grants page → save, persisting connection + token + audit trail', async () => {
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { port, state } = await startFlow(manager, opened);

    const location = await completeCallback(port, state);
    const sessionId = new URL(`http://x${location}`).searchParams.get('s')!;

    const setup = await fetch(`http://127.0.0.1:${port}${location}`);
    expect(setup.status).toBe(200);
    expect(setup.headers.get('x-frame-options')).toBe('DENY');
    expect(setup.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await setup.text();
    expect(html).toContain('Acme');
    expect(html).toContain('00Dxx0000000001EAA');
    expect(html).toContain('sandbox');
    expect(html).not.toContain('RT-secret');

    const save = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session: sessionId,
        label: 'acme-uat',
        metadata_read: 'on',
        diagnostics_read: 'on',
      }).toString(),
    });
    expect(save.status).toBe(200);
    expect(await save.text()).toContain('acme-uat');

    const rec = db.getConnectionByAlias('acme-uat');
    expect(rec).toBeTruthy();
    expect(rec!.orgId).toBe('00Dxx0000000001EAA');
    expect(rec!.orgType).toBe('sandbox');
    expect(rec!.grants).toEqual({
      metadata_read: true,
      metadata_write: false,
      diagnostics_read: true,
      data_read: false,
      data_write: false,
    });
    expect(tokens.getRefreshToken(rec!.id)).toBe('RT-secret');

    const events = db.queryAuditEvents({}).map((e) => e.eventType);
    expect(events).toContain('oauth.flow_started');
    expect(events).toContain('connection.created');
    expect(events).toContain('oauth.flow_completed');
  });

  it('resolves inline when the flow finishes within the tool wait', async () => {
    const { ops, opened } = makeOps();
    const config = makeConfig();
    config.oauth.toolWaitMs = 3_000;
    const manager = new ConnectFlowManager(db, tokens, audit, config, ops);

    const outcomePromise = manager.connectOrg({ login: 'sandbox' });
    await new Promise((r) => setTimeout(r, 150));
    const port = manager.activeConnectPort()!;
    const state = new URL(opened[0]!).searchParams.get('state')!;
    const location = await completeCallback(port, state);
    const sessionId = new URL(`http://x${location}`).searchParams.get('s')!;
    await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ session: sessionId, label: 'fast-org', data_read: 'on' }).toString(),
    });

    const outcome = await outcomePromise;
    expect(outcome.status).toBe('connected');
    if (outcome.status === 'connected') {
      expect(outcome.connection.alias).toBe('fast-org');
      expect(outcome.connection.grants.data_read).toBe(true);
    }
  });

  it('supersedes a pending flow cleanly when connect_org is called again on a fixed port', async () => {
    const { ops, opened } = makeOps();
    const config = makeConfig();
    config.oauth.callbackPort = 43117; // fixed, like production — the EADDRINUSE regression case
    const manager = new ConnectFlowManager(db, tokens, audit, config, ops);

    const first = await manager.connectOrg({ login: 'sandbox' });
    expect(first.status).toBe('pending');

    const second = await manager.connectOrg({ login: 'sandbox' });
    expect(second.status).toBe('pending'); // must not throw EADDRINUSE
    expect(db.queryAuditEvents({}).map((e) => e.eventType)).toContain('oauth.flow_superseded');

    // The replacement flow is live on the same fixed port.
    const state2 = new URL(opened[1]!).searchParams.get('state')!;
    await completeCallback(43117, state2);
  });

  it('ignores the login argument on re-auth — the stored login host wins', async () => {
    db.insertConnection({
      alias: 'uat',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      orgId: '00Dxx0000000001EAA',
      orgName: 'Acme UAT',
      orgType: 'sandbox',
      isSandbox: true,
      username: null,
      userId: null,
      grants: {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const outcome = await manager.connectOrg({ label: 'uat', login: 'production' });
    expect(outcome.status).toBe('pending');
    expect(opened[0]).toMatch(/^https:\/\/test\.salesforce\.com\//);
  });

  it('refuses requests with a non-loopback Host header (DNS-rebinding defense)', async () => {
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { port } = await startFlow(manager, opened);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/setup', headers: { Host: 'attacker.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const refusal = db.queryAuditEvents({}).find((e) => e.eventType === 'local_request.refused');
    expect(refusal).toBeTruthy();
  });

  it('refuses a forged callback (bad state) without killing the flow', async () => {
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { port, state } = await startFlow(manager, opened);

    const forged = await fetch(`http://127.0.0.1:${port}/OauthRedirect?code=EVIL&state=wrong`, {
      redirect: 'manual',
    });
    expect(forged.status).toBe(400);

    // The legitimate callback still works afterwards.
    await completeCallback(port, state);
  });

  it('refuses a save with a wrong session token', async () => {
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { port, state } = await startFlow(manager, opened);
    await completeCallback(port, state);

    const save = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ session: 'forged', label: 'x', data_read: 'on' }).toString(),
    });
    expect(save.status).toBe(403);
    expect(db.listConnections()).toHaveLength(0);
  });

  it('rejects a forged grant set that violates dependencies (server-side gate)', async () => {
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { port, state } = await startFlow(manager, opened);
    const location = await completeCallback(port, state);
    const sessionId = new URL(`http://x${location}`).searchParams.get('s')!;

    const save = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session: sessionId,
        label: 'sneaky',
        metadata_write: 'on', // no metadata_read
      }).toString(),
    });
    expect(save.status).toBe(400);
    expect(await save.text()).toContain('metadata_write requires metadata_read');
    expect(db.listConnections()).toHaveLength(0);
  });

  it('re-authorizes an existing alias in place (sandbox refresh path)', async () => {
    const first = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), first.ops);
    const { port, state } = await startFlow(manager, first.opened);
    const location = await completeCallback(port, state);
    const sessionId = new URL(`http://x${location}`).searchParams.get('s')!;
    await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ session: sessionId, label: 'acme-uat', metadata_read: 'on' }).toString(),
    });
    const original = db.getConnectionByAlias('acme-uat')!;

    // Sandbox refreshed: new org id, new tokens; same alias.
    const second = makeOps({
      exchangeCode: async () => ({ ...FAKE_TOKENS, refresh_token: 'RT-new' }),
      fetchOrgInfo: async () => ({
        orgId: '00Dyy0000000002EAA',
        orgName: 'Acme',
        isSandbox: true,
        organizationType: 'Enterprise Edition',
        trialExpirationDate: null,
      }),
    });
    const manager2 = new ConnectFlowManager(db, tokens, audit, makeConfig(), second.ops);
    const { port: port2, state: state2 } = await startFlow(manager2, second.opened, {
      label: 'acme-uat',
    });
    const location2 = await completeCallback(port2, state2);
    const session2 = new URL(`http://x${location2}`).searchParams.get('s')!;
    const setupHtml = await (await fetch(`http://127.0.0.1:${port2}${location2}`)).text();
    expect(setupHtml).toContain('acme-uat'); // label locked to the existing alias
    await fetch(`http://127.0.0.1:${port2}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ session: session2, label: 'acme-uat', metadata_read: 'on' }).toString(),
    });

    const updated = db.getConnectionByAlias('acme-uat')!;
    expect(updated.id).toBe(original.id); // stable UUID survives the refresh
    expect(updated.orgId).toBe('00Dyy0000000002EAA');
    expect(tokens.getRefreshToken(updated.id)).toBe('RT-new');
    expect(db.queryAuditEvents({}).map((e) => e.eventType)).toContain('connection.reauthorized');
  });

  it('refuses to silently repoint an alias at a different org', async () => {
    db.insertConnection({
      alias: 'taken',
      instanceUrl: 'https://other.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dzz0000000009EAA',
      orgName: 'Other',
      orgType: 'production',
      isSandbox: false,
      username: null,
      userId: null,
      grants: {
        metadata_read: false,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    // No label arg → not a deliberate re-auth; the human types "taken" on the page.
    const { port, state } = await startFlow(manager, opened);
    const location = await completeCallback(port, state);
    const sessionId = new URL(`http://x${location}`).searchParams.get('s')!;
    const save = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ session: sessionId, label: 'taken', metadata_read: 'on' }).toString(),
    });
    expect(save.status).toBe(400);
    expect(await save.text()).toContain('already points at a different org');
  });
});

describe('manage flow', () => {
  it('serves the grants page and applies human-approved changes with an audit diff', async () => {
    const rec = db.insertConnection({
      alias: 'acme-prod',
      instanceUrl: 'https://acme.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dxx0000000001EAA',
      orgName: 'Acme',
      orgType: 'production',
      isSandbox: false,
      username: 'ryley@acme.com',
      userId: null,
      grants: {
        metadata_read: true,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    const { ops, opened } = makeOps();
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);
    const { url } = await manager.manageConnection('acme-prod');
    expect(opened).toContain(url);

    const pageRes = await fetch(url);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('acme-prod');

    const parsed = new URL(url);
    const save = await fetch(`${parsed.origin}/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session: parsed.searchParams.get('s')!,
        metadata_read: 'on',
        metadata_write: 'on',
        data_read: 'on',
      }).toString(),
    });
    expect(save.status).toBe(200);

    const updated = db.getConnection(rec.id)!;
    expect(updated.grants.metadata_write).toBe(true);
    expect(updated.grants.data_read).toBe(true);
    const evt = db.queryAuditEvents({}).find((e) => e.eventType === 'connection.grants_changed');
    expect(evt).toBeTruthy();
    expect(evt!.detail).toMatchObject({ after: expect.objectContaining({ metadata_write: true }) });
  });
});

describe('disconnect', () => {
  it('revokes, clears the token store, deletes the row, and audits', async () => {
    const revoked: string[] = [];
    const { ops } = makeOps({
      revokeToken: async ({ token }) => {
        revoked.push(token);
        return { ok: true };
      },
    });
    const rec = db.insertConnection({
      alias: 'gone-soon',
      instanceUrl: 'https://x.my.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: '00Dxx0000000005EAA',
      orgName: 'X',
      orgType: 'sandbox',
      isSandbox: true,
      username: null,
      userId: null,
      grants: {
        metadata_read: false,
        metadata_write: false,
        diagnostics_read: false,
        data_read: false,
        data_write: false,
      },
    });
    tokens.setRefreshToken(rec.id, 'RT-doomed');
    const manager = new ConnectFlowManager(db, tokens, audit, makeConfig(), ops);

    const result = await manager.disconnectOrg('gone-soon');
    expect(result.revoked).toBe(true);
    expect(revoked).toEqual(['RT-doomed']);
    expect(tokens.getRefreshToken(rec.id)).toBeNull();
    expect(db.getConnection(rec.id)).toBeNull();
    expect(db.queryAuditEvents({}).map((e) => e.eventType)).toContain('connection.removed');
  });
});

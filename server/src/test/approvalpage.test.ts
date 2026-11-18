import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { APPROVAL_NOTICES, type ApprovalNoticeCode, type PolicyConfig } from '../core/policy.js';
import {
  esc,
  renderApprovalPage,
  type ApprovalGovernance,
  type ApprovalPageOptions,
} from '../connect/pages.js';
import { ApprovalPageServer, type ApprovalLivePage, type ApprovalRoute } from '../deploy/approval.js';
import type { DeployEngine } from '../deploy/engine.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';

/**
 * S46 (B): the live approval page. A page presented with a live hook is
 * re-rendered on every GET and takes two POSTs — the human's justification
 * and, during a freeze, an emergency reason — each answered 302 → GET so the
 * page keeps its ?s= address. A refusal (foreign Host, wrong session, an
 * oversized body) reaches the audit log as a reason and a route label only:
 * never the URL, the path text or the session id, because get_audit_log hands
 * audit detail to the agent.
 */

// ── HTTP helper ──────────────────────────────────────────────────────────

interface Answer {
  status: number;
  location: string | undefined;
  body: string;
  /** The connection failed before an answer arrived (an oversized body). */
  error?: string;
}

/**
 * One request to a page server on 127.0.0.1 — node:http, not fetch, so the
 * Host header can be set (and fetch stays stubbed for Salesforce).
 */
function send(
  pageUrl: string,
  opts: { method?: 'GET' | 'POST'; path: string; host?: string; body?: string },
): Promise<Answer> {
  const port = Number(new URL(pageUrl).port);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          Host: opts.host ?? `localhost:${port}`,
          ...(opts.body !== undefined
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(Buffer.byteLength(opts.body)),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) =>
          resolve({ status: 0, location: undefined, body: '', error: String(err) }),
        );
      },
    );
    req.on('error', (err) => resolve({ status: 0, location: undefined, body: '', error: String(err) }));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function sessionOf(pageUrl: string): string {
  return new URL(pageUrl).searchParams.get('s')!;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Wait until `check` holds (the page server records a refusal after the socket is gone). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

// ── the page server alone, with a fake live hook ─────────────────────────

describe('ApprovalPageServer routes', () => {
  let server: ApprovalPageServer;
  let opened: string[];

  beforeEach(() => {
    opened = [];
    server = new ApprovalPageServer(async (url) => {
      opened.push(url);
    });
  });

  afterEach(() => {
    for (const url of opened) server.close(sessionOf(url));
  });

  interface FakeLive extends ApprovalLivePage {
    renders: Array<{ sessionId: string; notice: ApprovalNoticeCode | null }>;
    saved: string[];
    reasons: string[];
    refusals: Array<{ reason: string; route: ApprovalRoute }>;
  }

  function fakeLive(over: Partial<ApprovalLivePage> = {}): FakeLive {
    const live: FakeLive = {
      renders: [],
      saved: [],
      reasons: [],
      refusals: [],
      render(ctx) {
        live.renders.push(ctx);
        return `<p>render ${live.renders.length} notice=${ctx.notice ?? 'none'}</p>`;
      },
      saveJustification(text) {
        live.saved.push(text);
        return 'justification_saved';
      },
      recordFreezeOverride(reason) {
        live.reasons.push(reason);
        return 'override_too_short';
      },
      refused(reason, route) {
        live.refusals.push({ reason, route });
      },
      ...over,
    };
    return live;
  }

  const STATIC = '<p>the first render</p>';

  it('without a live hook: GET serves the string it was given, and the POST routes do not exist', async () => {
    const { url } = await server.present(STATIC);
    const sid = sessionOf(url);
    const page = await send(url, { path: `/approve?s=${sid}` });
    expect(page.status).toBe(200);
    expect(page.body).toBe(STATIC);
    for (const route of ['/justification', '/override']) {
      const res = await send(url, {
        method: 'POST',
        path: route,
        body: form({ session: sid, justification: 'x', reason: 'x' }),
      });
      expect(res.status).toBe(404);
    }
  });

  it('with a live hook every GET re-renders, with the session id and a known notice', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const sid = sessionOf(url);
    const a = await send(url, { path: `/approve?s=${sid}` });
    const b = await send(url, { path: `/approve?s=${sid}&n=justification_saved` });
    expect(a.status).toBe(200);
    expect(a.body).toBe('<p>render 1 notice=none</p>');
    expect(b.body).toBe('<p>render 2 notice=justification_saved</p>');
    expect(live.renders).toEqual([
      { sessionId: sid, notice: null },
      { sessionId: sid, notice: 'justification_saved' },
    ]);
    // The static first render is never served once a live hook exists.
    expect(a.body).not.toContain(STATIC);
  });

  it('an unknown n is ignored', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const sid = sessionOf(url);
    for (const n of ['nope', 'toString', '__proto__', '<script>']) {
      const res = await send(url, { path: `/approve?s=${sid}&n=${encodeURIComponent(n)}` });
      expect(res.status).toBe(200);
    }
    expect(live.renders.map((r) => r.notice)).toEqual([null, null, null, null]);
  });

  it('a GET with the wrong session id is not found, and renders nothing', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const res = await send(url, { path: '/approve?s=00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
    expect(live.renders).toHaveLength(0);
  });

  it('POST /justification with the session answers 302 to the page with the notice; the hook gets the text', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, () => ({ active: true, status: 'validated' }), 60_000, live);
    const sid = sessionOf(url);
    const res = await send(url, {
      method: 'POST',
      path: '/justification',
      body: form({ session: sid, justification: 'The client asked for this before month end.' }),
    });
    expect(res.status).toBe(302);
    expect(res.location).toBe(`/approve?s=${sid}&n=justification_saved`);
    expect(live.saved).toEqual(['The client asked for this before month end.']);
    expect(live.refusals).toEqual([]);

    // The address the page lands on still carries s=, so its /status poll works.
    const landed = new URL(res.location!, url);
    expect(landed.searchParams.get('s')).toBe(sid);
    const status = await send(url, { path: `/status?s=${landed.searchParams.get('s')}` });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ active: true, status: 'validated' });
    const page = await send(url, { path: `${landed.pathname}${landed.search}` });
    expect(page.status).toBe(200);
    expect(live.renders.at(-1)).toEqual({ sessionId: sid, notice: 'justification_saved' });
  });

  it('POST /override with the session answers 302 with the hook\'s notice; the hook gets the reason', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const sid = sessionOf(url);
    const res = await send(url, {
      method: 'POST',
      path: '/override',
      body: form({ session: sid, reason: 'too short' }),
    });
    expect(res.status).toBe(302);
    expect(res.location).toBe(`/approve?s=${sid}&n=override_too_short`);
    expect(live.reasons).toEqual(['too short']);
    expect(live.saved).toEqual([]);
  });

  it('a POST with the wrong session field is refused 403 and recorded as invalid_session_token for its route', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    for (const [route, field] of [
      ['justification', 'justification'],
      ['override', 'reason'],
    ] as const) {
      const res = await send(url, {
        method: 'POST',
        path: `/${route}`,
        body: form({ session: 'not-the-session', [field]: 'text' }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Invalid session token.');
    }
    // A missing session field is the same refusal.
    const missing = await send(url, { method: 'POST', path: '/justification', body: form({ justification: 'x' }) });
    expect(missing.status).toBe(403);
    expect(live.refusals).toEqual([
      { reason: 'invalid_session_token', route: 'justification' },
      { reason: 'invalid_session_token', route: 'override' },
      { reason: 'invalid_session_token', route: 'justification' },
    ]);
    expect(live.saved).toEqual([]);
    expect(live.reasons).toEqual([]);
  });

  it('a foreign Host is refused 403 on every route, GET and POST, and recorded with the route label', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, () => ({ active: true, status: 'validated' }), 60_000, live);
    const sid = sessionOf(url);
    const evil = 'evil.example';
    const get = await send(url, { path: `/approve?s=${sid}`, host: evil });
    const status = await send(url, { path: `/status?s=${sid}`, host: evil });
    const post = await send(url, {
      method: 'POST',
      path: '/justification',
      host: evil,
      body: form({ session: sid, justification: 'x' }),
    });
    const override = await send(url, {
      method: 'POST',
      path: '/override',
      host: evil,
      body: form({ session: sid, reason: 'x'.repeat(20) }),
    });
    for (const res of [get, status, post, override]) {
      expect(res.status).toBe(403);
      expect(res.body).toContain('unexpected Host header');
    }
    expect(live.refusals).toEqual([
      { reason: 'bad_host_header', route: 'approve' },
      { reason: 'bad_host_header', route: 'status' },
      { reason: 'bad_host_header', route: 'justification' },
      { reason: 'bad_host_header', route: 'override' },
    ]);
    expect(live.renders).toEqual([]);
    expect(live.saved).toEqual([]);
    expect(live.reasons).toEqual([]);
  });

  it('a path outside the four routes is labelled other — never its text', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const long = `/${'a'.repeat(300)}/../etc?x=<script>`;
    const res = await send(url, { path: long, host: 'evil.example' });
    expect(res.status).toBe(403);
    // Names an object's own properties carry are not routes either.
    for (const p of ['/__proto__', '/constructor', '/toString']) {
      expect((await send(url, { path: p, host: 'evil.example' })).status).toBe(403);
    }
    expect(live.refusals).toEqual([
      { reason: 'bad_host_header', route: 'other' },
      { reason: 'bad_host_header', route: 'other' },
      { reason: 'bad_host_header', route: 'other' },
      { reason: 'bad_host_header', route: 'other' },
    ]);
  });

  it('an oversized POST gets no answer at all, calls no hook, and is recorded as body_too_large', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const sid = sessionOf(url);
    const res = await send(url, {
      method: 'POST',
      path: '/justification',
      body: form({ session: sid, justification: 'x'.repeat(70 * 1024) }),
    });
    expect(res.status === 0 || res.status >= 400).toBe(true);
    expect(res.status < 200 || res.status >= 400).toBe(true);
    await until(() => live.refusals.length > 0);
    expect(live.refusals).toEqual([{ reason: 'body_too_large', route: 'justification' }]);
    expect(live.saved).toEqual([]);
  });

  it('a render that throws is a 500 error page — never the static first render', async () => {
    const live = fakeLive({
      render: () => {
        throw new Error('render failed');
      },
    });
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let res: Answer;
    try {
      res = await send(url, { path: `/approve?s=${sessionOf(url)}` });
    } finally {
      stderr.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.body).not.toContain(STATIC);
    expect(res.body).toContain('could not be rendered');
  });

  it('a hook that throws is a 500 error page, and no redirect', async () => {
    const live = fakeLive({
      saveJustification: () => {
        throw new Error('db gone');
      },
    });
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let res: Answer;
    try {
      res = await send(url, {
        method: 'POST',
        path: '/justification',
        body: form({ session: sessionOf(url), justification: 'x' }),
      });
    } finally {
      stderr.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.location).toBeUndefined();
  });

  it('GET on a POST route is not found', async () => {
    const live = fakeLive();
    const { url } = await server.present(STATIC, undefined, 60_000, live);
    const res = await send(url, { path: `/justification?s=${sessionOf(url)}` });
    expect(res.status).toBe(404);
    expect(live.saved).toEqual([]);
  });
});

// ── the page's forms and notices (connect/pages.ts) ─────────────────────

describe('the Change record form and the notices', () => {
  const VIEW: ApprovalPageOptions = {
    kind: 'dml',
    code: 'ABCD-EFGH',
    expiresAt: '2026-11-17T15:00:00.000Z',
    org: {
      alias: 'acme-dev',
      orgName: 'Acme',
      orgType: 'developer',
      instanceUrl: 'https://acme.example.invalid',
    },
    changes: [{ label: 'UPDATE Account 001000000000001AAA', warnings: [] }],
    destructive: [],
    results: [],
    blast: [],
    warnings: ['A page-top warning.'],
  };
  const SID = '11111111-2222-3333-4444-555555555555';

  function governance(over: Partial<ApprovalGovernance> = {}): ApprovalGovernance {
    return {
      gate: 'open',
      sessionId: SID,
      ticket: 'INV-42',
      justification: {
        text: 'Month-end invoicing.',
        provenance: 'Drafted by the agent. Edit it if it is not what you would say.',
        required: true,
      },
      policySource: 'config',
      policyLines: ['A justification is required (rule "acme needs a reason").'],
      frozenAtMint: false,
      rev: 'open:::',
      limits: { justificationMax: 1000, reasonMin: 15, reasonMax: 1000 },
      ...over,
    };
  }

  const pageWith = (over: Partial<ApprovalGovernance> = {}) =>
    renderApprovalPage({ ...VIEW, governance: governance(over) });

  it('with a session the justification is a form that posts to /justification with that session', () => {
    const html = pageWith();
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>') + 7);
    expect(form).toBe(
      '<form method="post" action="/justification" id="gov-justification">' +
        `<input type="hidden" name="session" value="${SID}">` +
        '<div class="field"><label for="justification">Justification (required by policy)</label>' +
        '<textarea id="justification" name="justification" rows="3" maxlength="1000">' +
        'Month-end invoicing.</textarea>' +
        '<div class="hint">Drafted by the agent. Edit it if it is not what you would say.</div></div>' +
        '<div class="actions"><button type="submit" class="secondary">Save justification</button></div>' +
        '<p class="note">Saving records the text as typed on this page. It approves nothing and does ' +
        'not change the code.</p></form>',
    );
    // One form only: the ticket stays read-only.
    expect(html.split('<form').length - 1).toBe(1);
    expect(html).toContain('<span class="k">Ticket</span><span class="v">INV-42</span>');
    // Not required: the label says nothing more; the limit comes from the options.
    const optional = pageWith({
      justification: { text: '', provenance: 'None given.', required: false },
      limits: { justificationMax: 500, reasonMin: 15, reasonMax: 1000 },
    });
    expect(optional).toContain('<label for="justification">Justification</label>');
    expect(optional).toContain('rows="3" maxlength="500"></textarea>');
  });

  it('agent-written text cannot leave the text field, and the session value is escaped', () => {
    const html = pageWith({
      sessionId: '"><script>alert(1)</script>',
      justification: {
        text: '</textarea><script>alert(1)</script>',
        provenance: 'Drafted by the agent. Edit it if it is not what you would say.',
        required: false,
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('a notice is shown in its colour, escaped, between the org card and the Change record', () => {
    const ok = pageWith({ notice: APPROVAL_NOTICES.justification_saved });
    const okAt = ok.indexOf(`<div class="success">${esc(APPROVAL_NOTICES.justification_saved.text)}</div>`);
    expect(okAt).toBeGreaterThan(ok.indexOf('>Instance<'));
    expect(okAt).toBeLessThan(ok.indexOf('id="gov-record"'));
    const err = pageWith({ notice: APPROVAL_NOTICES.justification_required });
    expect(err).toContain(`<div class="error">${esc(APPROVAL_NOTICES.justification_required.text)}</div>`);
    const hostile = pageWith({ notice: { kind: 'error', text: '<b>x</b>' } });
    expect(hostile).toContain('<div class="error">&lt;b&gt;x&lt;/b&gt;</div>');
    expect(pageWith()).not.toContain('class="success"');
  });

  it('the inline script drops ?n= from the address before the first poll, keeping ?s=', () => {
    const html = pageWith();
    const script = html.slice(html.lastIndexOf('<script>'));
    expect(script).toContain(
      "history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(s))",
    );
    expect(script).toContain("var s = q.get('s') || '';");
    // Only an address that carries a notice is rewritten.
    expect(script).toContain("if (q.has('n')) {");
    expect(script.indexOf("if (q.has('n')) {")).toBeLessThan(script.indexOf('history.replaceState'));
    expect(script.indexOf('history.replaceState')).toBeLessThan(script.indexOf('setTimeout(check'));
    // The poll still reads the address.
    expect(script).toContain("fetch('/status' + location.search");
  });

  it('with no code, or a gate that is blocked, the code card carries neither the code nor the read-back note', () => {
    const card = (html: string) => html.slice(html.indexOf('id="code-card"'), html.indexOf('id="dead"'));
    const shown = card(pageWith());
    expect(shown).toContain('<div class="code" id="code">ABCD-EFGH</div>');
    expect(shown).toContain('read this code back to');
    const none = card(renderApprovalPage({ ...VIEW, code: '', governance: governance() }));
    const bare = card(renderApprovalPage({ ...VIEW, code: '' }));
    const blocked = card(
      pageWith({ gate: 'blocked', blockedBy: 'violations', blockedLines: ['A ticket is required.'] }),
    );
    for (const c of [none, bare, blocked]) {
      expect(c).toContain('<h2>Confirmation code</h2>');
      expect(c).not.toContain('id="code"');
      expect(c).not.toContain('ABCD-EFGH');
      expect(c).not.toContain('read this code back');
      expect(c).not.toContain('re-validating replaces it');
    }
  });
});

// ── the engine's live page ───────────────────────────────────────────────

describe('the live approval page of a real request', () => {
  let tmp: string;
  let db: ContrailDb;
  let config: ContrailConfig;
  let deploys: DeployEngine;
  let client: Client;
  let presentedPages: string[];
  let pageUrls: string[];
  let approvals: ApprovalPageServer;

  const ORG_ID = '00D000000000001AAA';
  const RULE = 'acme needs a reason';
  const ACME_RULE: PolicyConfig = {
    rules: [{ name: RULE, match: { connections: ['acme-*'] }, requireJustification: true }],
  };
  const WHY = 'The client asked for the invoice fix to reach their org before month end.';
  const SCRIPT = "System.debug('invoice check');";

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-approvalpage-'));
    process.env.CONTRAIL_DATA_DIR = tmp;
    db = new ContrailDb(path.join(tmp, 'test.db'));
    const tokens = new MemoryTokenStore();
    presentedPages = [];
    pageUrls = [];

    const grants = emptyGrantSet();
    grants.data_read = true;
    grants.data_write = true;
    const conn = db.insertConnection({
      alias: 'acme-dev',
      instanceUrl: 'https://acme.example.invalid',
      loginUrl: 'https://login.salesforce.com',
      orgId: ORG_ID,
      orgName: 'Acme',
      orgType: 'developer',
      isSandbox: false,
      username: 'admin@acme.example.invalid',
      userId: '005000000000001AAA',
      grants,
    });
    tokens.setRefreshToken(conn.id, 'RT');

    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return json({
          access_token: 'AT',
          instance_url: 'https://acme.example.invalid',
          id: `https://login.salesforce.com/id/${ORG_ID}/005000000000001AAA`,
          token_type: 'Bearer',
        });
      }
      if (url.includes('/tooling/executeAnonymous/')) {
        return json({
          line: -1,
          column: -1,
          compiled: true,
          success: true,
          compileProblem: null,
          exceptionMessage: null,
          exceptionStackTrace: null,
        });
      }
      return new Response('not found', { status: 404 });
    });

    approvals = new ApprovalPageServer(async (url) => {
      pageUrls.push(url);
    });
    const origPresent = approvals.present.bind(approvals);
    approvals.present = async (html, statusCheck, ttlMs, live) => {
      presentedPages.push(html);
      return origPresent(html, statusCheck, ttlMs, live);
    };

    config = {
      ...DEFAULT_CONFIG,
      salesforce: { ...DEFAULT_CONFIG.salesforce },
      oauth: { ...DEFAULT_CONFIG.oauth },
      snapshot: { ...DEFAULT_CONFIG.snapshot },
      deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
      policies: ACME_RULE,
    };
    const deps = createDeps({
      db,
      tokens,
      config,
      store: new SnapshotStore(path.join(tmp, 'snapshots')),
      approvals,
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
    deploys = deps.deploys;
    const server = createServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(ct);
  });

  afterEach(async () => {
    for (const url of pageUrls) approvals.close(sessionOf(url));
    vi.unstubAllGlobals();
    await client.close();
    db.close();
    delete process.env.CONTRAIL_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  /** Propose an anonymous Apex script; returns the request, its code and its page address. */
  async function propose(args: Record<string, unknown> = { justification: WHY }) {
    const res = await client.callTool({
      name: 'apex_propose',
      arguments: { connection: 'acme-dev', code: SCRIPT, ...args },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const conn = db.resolveConnection('acme-dev')!;
    const request = db.queryDeployRequests({ connectionId: conn.id, limit: 1 })[0]!;
    return { request, code: request.confirmationCode, url: pageUrls.at(-1)! };
  }

  function summaryOf(id: string): Record<string, any> {
    return JSON.parse(db.getDeployRequest(id)!.summaryJson) as Record<string, any>;
  }

  async function getPage(url: string, query = ''): Promise<Answer> {
    return send(url, { path: `/approve?s=${sessionOf(url)}${query}` });
  }

  async function postJustification(url: string, text: string): Promise<Answer> {
    return send(url, {
      method: 'POST',
      path: '/justification',
      body: form({ session: sessionOf(url), justification: text }),
    });
  }

  function noticeOf(res: Answer): string | null {
    return new URL(res.location!, 'http://localhost').searchParams.get('n');
  }

  it('the first render has no form; a live render carries the justification form with this page\'s session', async () => {
    const { url, code } = await propose();
    const sid = sessionOf(url);
    expect(presentedPages.at(-1)!).not.toContain('<form');
    expect(presentedPages.at(-1)!).not.toContain(sid);

    const page = await getPage(url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<form method="post" action="/justification" id="gov-justification">');
    expect(page.body).toContain(`<input type="hidden" name="session" value="${sid}">`);
    expect(page.body).toContain('<label for="justification">Justification (required by policy)</label>');
    expect(page.body).toContain(
      `<textarea id="justification" name="justification" rows="3" maxlength="1000">${esc(WHY)}</textarea>`,
    );
    expect(page.body).toContain(
      '<div class="hint">Drafted by the agent. Edit it if it is not what you would say.</div>',
    );
    expect(page.body).toContain('<button type="submit" class="secondary">Save justification</button>');
    expect(page.body).toContain(
      'Saving records the text as typed on this page. It approves nothing and does not change the code.',
    );
    // The code card is unchanged.
    expect(page.body).toContain(`<div class="code" id="code">${code}</div>`);
    // The inline script drops ?n= from the address before the first poll, keeping ?s=.
    expect(page.body).toContain(
      "history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(s))",
    );
    expect(page.body).toContain("if (q.has('n')) {");
    expect(page.body.indexOf("if (q.has('n')) {")).toBeLessThan(page.body.indexOf('history.replaceState'));
    expect(page.body.indexOf('history.replaceState')).toBeLessThan(page.body.indexOf('setTimeout(check'));
  });

  it('saving a different justification records it as typed on the page; the same code still executes', async () => {
    const { url, code, request } = await propose();
    const typed = 'Month-end invoicing is blocked for the client until this ships.';
    const res = await postJustification(url, typed);
    expect(res.status).toBe(302);
    expect(res.location).toBe(`/approve?s=${sessionOf(url)}&n=justification_saved`);

    const stored = summaryOf(request.id).governance.justification;
    expect(stored).toEqual({
      text: typed,
      source: 'page',
      surface: 'approval_page',
      edited_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      agent_draft: WHY,
    });
    const edited = db.queryAuditEvents({ eventType: 'approval.justification_edited' });
    expect(edited).toHaveLength(1);
    expect(edited[0]!.tool).toBe('approval_page');
    expect(edited[0]!.detail).toEqual({
      requestId: request.id,
      kind: 'apex',
      surface: 'approval_page',
      chars: typed.length,
      had_agent_draft: true,
    });
    // Never the text, never the code.
    expect(JSON.stringify(edited[0])).not.toContain(typed);
    expect(JSON.stringify(edited[0])).not.toContain(code);

    // The page it lands on: the notice, the typed text and its provenance, the same code.
    const page = await getPage(url, '&n=justification_saved');
    expect(page.body).toContain(`<div class="success">${esc(APPROVAL_NOTICES.justification_saved.text)}</div>`);
    expect(page.body).toContain(`>${esc(typed)}</textarea>`);
    expect(page.body).toMatch(/<div class="hint">Typed on the approval page at \d{2}:\d{2}\.<\/div>/);
    expect(page.body).toContain(`<div class="code" id="code">${code}</div>`);
    expect(db.getDeployRequest(request.id)!.confirmationCode).toBe(code);

    const executed = await client.callTool({
      name: 'apex_execute',
      arguments: { connection: 'acme-dev', confirmation_code: code },
    });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(db.getDeployRequest(request.id)!.status).toBe('executed');
    // The record survives the execute.
    expect(summaryOf(request.id).governance.justification.text).toBe(typed);
  });

  it('a browser\'s CR LF line breaks are folded: the untouched draft is unchanged, and nothing is recorded', async () => {
    const draft = 'First line of the reason.\nSecond line of the reason.';
    const { url, request } = await propose({ justification: draft });
    const before = db.getDeployRequest(request.id)!.summaryJson;
    // A browser submits a textarea's line breaks as CR LF (%0D%0A).
    const body = `session=${sessionOf(url)}&justification=First+line+of+the+reason.%0D%0ASecond+line+of+the+reason.`;
    const res = await send(url, { method: 'POST', path: '/justification', body });
    expect(res.status).toBe(302);
    expect(noticeOf(res)).toBe('justification_unchanged');
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })).toHaveLength(0);
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    expect(summaryOf(request.id).governance.justification).toEqual({ text: draft, source: 'agent' });

    // A changed text with CR LF is stored with LF.
    const changed = await send(url, {
      method: 'POST',
      path: '/justification',
      body: `session=${sessionOf(url)}&justification=Line+one.%0D%0ALine+two.%0DLine+three.`,
    });
    expect(noticeOf(changed)).toBe('justification_saved');
    expect(summaryOf(request.id).governance.justification.text).toBe('Line one.\nLine two.\nLine three.');
  });

  it('a request with no justification stored: an empty or blank text is unchanged, and nothing is recorded', async () => {
    config.policies = { rules: [] };
    const { url, request } = await propose({});
    expect(summaryOf(request.id).governance.justification).toBeNull();
    const before = db.getDeployRequest(request.id)!.summaryJson;
    for (const text of ['', '   ', ' \r\n\t ']) {
      const res = await postJustification(url, text);
      expect(res.status).toBe(302);
      expect(noticeOf(res), JSON.stringify(text)).toBe('justification_unchanged');
    }
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })).toHaveLength(0);
    const page = await getPage(url, '&n=justification_unchanged');
    expect(page.body).toContain(
      `<div class="success">${esc(APPROVAL_NOTICES.justification_unchanged.text)}</div>`,
    );
  });

  it('a 1,000-character justification with CR LF breaks is counted after folding and accepted', async () => {
    const { url, request } = await propose();
    const line = 'y'.repeat(99);
    const text = Array.from({ length: 10 }, () => line).join('\r\n'); // 990 + 9 breaks = 999 folded
    const res = await postJustification(url, `${text}z`);
    expect(noticeOf(res)).toBe('justification_saved');
    expect(summaryOf(request.id).governance.justification.text).toHaveLength(1000);
    expect(summaryOf(request.id).governance.justification.text).not.toContain('\r');
  });

  it('clearing where no rule requires one records the clearing; the next render says so', async () => {
    config.policies = { rules: [] };
    const { url, request } = await propose();
    const res = await postJustification(url, '   ');
    expect(noticeOf(res)).toBe('justification_cleared');
    expect(summaryOf(request.id).governance.justification).toMatchObject({
      text: '',
      source: 'page',
      surface: 'approval_page',
      agent_draft: WHY,
    });
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })[0]!.detail).toMatchObject({
      chars: 0,
      had_agent_draft: true,
    });
    const page = await getPage(url, '&n=justification_cleared');
    expect(page.body).toContain(`<div class="success">${esc(APPROVAL_NOTICES.justification_cleared.text)}</div>`);
    expect(page.body).toMatch(/<div class="hint">Cleared on the approval page at \d{2}:\d{2}\.<\/div>/);
    expect(page.body).toContain('<label for="justification">Justification</label>');
  });

  it('a required justification cannot be cleared; too long and control characters are refused; nothing changes', async () => {
    const { url, request } = await propose();
    const before = db.getDeployRequest(request.id)!.summaryJson;
    expect(noticeOf(await postJustification(url, ''))).toBe('justification_required');
    expect(noticeOf(await postJustification(url, 'x'.repeat(1001)))).toBe('justification_too_long');
    expect(noticeOf(await postJustification(url, 'bell \u0007 here'))).toBe('invalid_text');
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })).toHaveLength(0);
    const page = await getPage(url, '&n=justification_required');
    expect(page.body).toContain(`<div class="error">${esc(APPROVAL_NOTICES.justification_required.text)}</div>`);
  });

  it('a request that is no longer pending takes no justification, shows no code, and drops a stale notice', async () => {
    const { url, code, request } = await propose();
    const executed = await client.callTool({
      name: 'apex_execute',
      arguments: { connection: 'acme-dev', confirmation_code: code },
    });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(noticeOf(await postJustification(url, 'Too late to change this one.'))).toBe('request_closed');
    expect(summaryOf(request.id).governance.justification).toEqual({ text: WHY, source: 'agent' });
    const page = await getPage(url, '&n=justification_saved');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(APPROVAL_NOTICES.justification_saved.text);
    expect(page.body).not.toContain(code);
    // No empty code element, and no note telling the human to read a code back.
    expect(page.body).toContain('id="code-card"');
    expect(page.body).not.toContain('id="code"');
    expect(page.body).not.toContain('read this code back');
    const closed = await getPage(url, '&n=request_closed');
    expect(closed.body).toContain(`<div class="error">${esc(APPROVAL_NOTICES.request_closed.text)}</div>`);
  });

  it('an emergency reason on a request with no freeze is not needed, and nothing is recorded', async () => {
    const { url, request } = await propose();
    const res = await send(url, {
      method: 'POST',
      path: '/override',
      body: form({ session: sessionOf(url), reason: 'Checkout is down for every customer.' }),
    });
    expect(noticeOf(res)).toBe('override_not_needed');
    expect(summaryOf(request.id).governance.freeze_override).toBeNull();
    expect(db.queryAuditEvents({ eventType: 'policy.freeze_overridden' })).toHaveLength(0);
  });

  it('during a freeze: a short reason is refused, a real one is recorded once, a second is not', async () => {
    config.policies = {
      rules: [
        {
          name: 'acme freeze',
          match: { connections: ['acme-*'] },
          freezeWindows: [
            { name: 'always', range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' }, timeZone: 'UTC' },
          ],
        },
      ],
    };
    const { url, request, code } = await propose();
    const post = (reason: string) =>
      send(url, { method: 'POST', path: '/override', body: form({ session: sessionOf(url), reason }) });
    expect(noticeOf(await post('x'.repeat(14)))).toBe('override_too_short');
    expect(noticeOf(await post('x'.repeat(1001)))).toBe('override_too_long');
    expect(summaryOf(request.id).governance.freeze_override).toBeNull();

    const reason = 'Checkout is down for every customer.';
    expect(noticeOf(await post(`  ${reason}\r\n`))).toBe('override_recorded');
    expect(summaryOf(request.id).governance.freeze_override).toEqual({
      reason,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      surface: 'approval_page',
      rule: 'acme freeze',
      window: 'always',
    });
    const rows = db.queryAuditEvents({ eventType: 'policy.freeze_overridden' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({
      requestId: request.id,
      kind: 'apex',
      rule: 'acme freeze',
      window: 'always',
      until: '2999-01-01 00:00 UTC',
      surface: 'approval_page',
      reason,
    });
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(deploys.governanceState(request.id)).toMatchObject({
      gate: 'overridden',
      override: { reason },
      frozenAtMint: true,
    });
    const page = await getPage(url, '&n=override_recorded');
    expect(page.body).toContain(`<div class="success">${esc(APPROVAL_NOTICES.override_recorded.text)}</div>`);
    expect(page.body).toContain(`<div class="code" id="code">${code}</div>`);

    expect(noticeOf(await post('A second reason, typed again.'))).toBe('override_already_recorded');
    expect(db.queryAuditEvents({ eventType: 'policy.freeze_overridden' })).toHaveLength(1);

    // Executed, the request stays overridden but its code is no longer shown,
    // so the notice that says it is shown below is dropped.
    const executed = await client.callTool({
      name: 'apex_execute',
      arguments: { connection: 'acme-dev', confirmation_code: code },
    });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(deploys.governanceState(request.id)).toMatchObject({ status: 'executed', gate: 'overridden' });
    const after = await getPage(url, '&n=override_recorded');
    expect(after.status).toBe(200);
    expect(after.body).not.toContain(esc(APPROVAL_NOTICES.override_recorded.text));
    expect(after.body).not.toContain('class="success"');
    expect(after.body).not.toContain(code);
  });

  /** Move a request's expiry into the past directly, as no sweep or claim would: its row stays 'validated'. */
  async function expireUnswept(id: string): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(path.join(tmp, 'test.db'));
    try {
      raw.prepare(`UPDATE deploy_requests SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', id);
    } finally {
      raw.close();
    }
    expect(db.getDeployRequest(id)!.status).toBe('validated');
  }

  it('a frozen request past its expiry but not yet swept takes no emergency reason: request_closed, nothing recorded', async () => {
    config.policies = {
      rules: [
        {
          name: 'acme freeze',
          match: { connections: ['acme-*'] },
          freezeWindows: [
            { name: 'always', range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' }, timeZone: 'UTC' },
          ],
        },
      ],
    };
    const { url, request } = await propose();
    await expireUnswept(request.id);
    const before = db.getDeployRequest(request.id)!.summaryJson;
    const res = await send(url, {
      method: 'POST',
      path: '/override',
      body: form({ session: sessionOf(url), reason: 'Checkout is down for every customer.' }),
    });
    expect(res.status).toBe(302);
    expect(noticeOf(res)).toBe('request_closed');
    expect(db.queryAuditEvents({ eventType: 'policy.freeze_overridden' })).toHaveLength(0);
    expect(summaryOf(request.id).governance.freeze_override).toBeNull();
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    const page = await getPage(url, '&n=request_closed');
    expect(page.body).toContain(`<div class="error">${esc(APPROVAL_NOTICES.request_closed.text)}</div>`);
    expect(page.body).not.toContain(APPROVAL_NOTICES.override_recorded.text);
  });

  it('an open request past its expiry but not yet swept: no code on the page, the poll says expired, no justification is taken', async () => {
    const { url, code, request } = await propose();
    expect((await getPage(url)).body).toContain(`<div class="code" id="code">${code}</div>`);
    const live = await send(url, { path: `/status?s=${sessionOf(url)}` });
    expect(JSON.parse(live.body)).toMatchObject({ active: true, status: 'validated' });

    await expireUnswept(request.id);
    const page = await getPage(url, '&n=justification_saved');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(code);
    expect(page.body).not.toContain('id="code"');
    expect(page.body).not.toContain('read this code back');
    expect(page.body).not.toContain(APPROVAL_NOTICES.justification_saved.text);
    const polled = await send(url, { path: `/status?s=${sessionOf(url)}` });
    expect(JSON.parse(polled.body)).toEqual({ active: false, status: 'expired' });

    const before = db.getDeployRequest(request.id)!.summaryJson;
    expect(noticeOf(await postJustification(url, 'Typed after the code expired.'))).toBe('request_closed');
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })).toHaveLength(0);
  });

  it('a policy that blocks the request hides its code on the live page; it returns once nothing blocks it', async () => {
    const { url, code, request } = await propose();
    const codeElement = `<div class="code" id="code">${code}</div>`;
    expect((await getPage(url)).body).toContain(codeElement);
    const hidden = (body: string) => {
      expect(body).not.toContain(code);
      expect(body).not.toContain('id="code"');
      expect(body).not.toContain('read this code back');
      expect(body).toContain('id="code-card"');
    };

    // A rule added after the mint that the request does not satisfy.
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        { name: 'tickets please', match: { connections: ['acme-*'] }, requireTicket: true },
      ],
    };
    expect(deploys.governanceState(request.id)).toMatchObject({
      gate: 'blocked',
      blockedBy: 'violations',
      violationCodes: ['ticket_required'],
    });
    const violated = await getPage(url);
    expect(violated.status).toBe(200);
    hidden(violated.body);

    // Policies Contrail cannot read.
    deploys.setPolicySource(() => ({ ok: false, problem: 'config.json is not a JSON object' }));
    expect(deploys.governanceState(request.id)).toMatchObject({ gate: 'blocked', blockedBy: 'unreadable' });
    const unreadable = await getPage(url);
    expect(unreadable.status).toBe(200);
    hidden(unreadable.body);

    // Readable and satisfied again: the same code is shown.
    deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    expect((await getPage(url)).body).toContain(codeElement);
    expect(db.getDeployRequest(request.id)!.confirmationCode).toBe(code);
  });

  it('an oversized body is refused before any hook: no answer, nothing saved, one body_too_large row', async () => {
    const { url, request } = await propose();
    const before = db.getDeployRequest(request.id)!.summaryJson;
    const res = await postJustification(url, 'x'.repeat(70 * 1024));
    expect(res.status < 200 || res.status >= 400).toBe(true);
    const refusals = () => db.queryAuditEvents({ eventType: 'local_request.refused' });
    await until(() => refusals().length > 0);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]!.tool).toBe('approval_page');
    expect(refusals()[0]!.outcome).toBe('refused');
    expect(refusals()[0]!.detail).toEqual({ reason: 'body_too_large', route: 'justification' });
    expect(db.getDeployRequest(request.id)!.summaryJson).toBe(before);
    expect(db.queryAuditEvents({ eventType: 'approval.justification_edited' })).toHaveLength(0);
  });

  it('refusals never record or log the session id, the URL or the path text', async () => {
    const { url, code } = await propose();
    const sid = sessionOf(url);
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    const attacker = `/${'steal-'.repeat(60)}${sid}`;
    try {
      // The real session id, with a foreign Host.
      expect((await send(url, { path: `/approve?s=${sid}`, host: 'evil.example' })).status).toBe(403);
      // A POST whose session field is wrong, at the real page address.
      const wrong = await send(url, {
        method: 'POST',
        path: `/justification?s=${sid}`,
        body: form({ session: `${sid}-not`, justification: 'x' }),
      });
      expect(wrong.status).toBe(403);
      // Attacker text in the path, with a foreign Host.
      expect((await send(url, { path: attacker, host: 'evil.example' })).status).toBe(403);
    } finally {
      stderr.mockRestore();
    }
    const rows = db.queryAuditEvents({ eventType: 'local_request.refused' });
    const details = rows.map((r) => r.detail as { reason: string; route: string });
    details.sort((a, b) => `${a.reason}/${a.route}`.localeCompare(`${b.reason}/${b.route}`));
    expect(details).toEqual([
      { reason: 'bad_host_header', route: 'approve' },
      { reason: 'bad_host_header', route: 'other' },
      { reason: 'invalid_session_token', route: 'justification' },
    ]);
    for (const row of rows) {
      expect(row.tool).toBe('approval_page');
      expect(row.outcome).toBe('refused');
    }
    for (const row of db.queryAuditEvents({ limit: 1000 })) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(sid);
      expect(text).not.toContain('steal-');
      expect(text).not.toContain(code);
    }
    for (const line of logged) {
      expect(line).not.toContain(sid);
      expect(line).not.toContain(code);
    }
  });

  it('a request minted before S46 is evaluated from its row, and a justification typed for it starts its record', async () => {
    const conn = db.resolveConnection('acme-dev')!;
    const old = db.insertDeployRequest({
      connectionId: conn.id,
      kind: 'dml',
      confirmationCode: 'ABCD-2345',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      payloadJson: JSON.stringify({ operation: 'delete', object: 'Account', ids: ['001000000000001AAA'] }),
      summaryJson: JSON.stringify({ rows: [], row_count: 1 }),
    });
    config.policies = {
      rules: [{ name: 'no data deletes', match: { connections: ['acme-dev'] }, denyDataDeletes: true }],
    };
    // No record: no ticket, no justification, and the delete read from the payload.
    expect(deploys.governanceState(old.id)).toMatchObject({
      ticket: null,
      justification: null,
      provenance: 'None given.',
      gate: 'blocked',
      blockedBy: 'violations',
      violationCodes: ['data_deletes_denied'],
      frozenAtMint: false,
    });
    config.policies = ACME_RULE;
    expect(deploys.governanceState(old.id)).toMatchObject({
      gate: 'blocked',
      violationCodes: ['justification_required'],
      required: true,
    });
    expect(deploys.saveJustification(old.id, 'Typed for an old request.', 'approval_page')).toBe(
      'justification_saved',
    );
    const record = summaryOf(old.id).governance;
    expect(record).toEqual({
      v: 1,
      justification: {
        text: 'Typed for an old request.',
        source: 'page',
        surface: 'approval_page',
        edited_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(deploys.governanceState(old.id)).toMatchObject({
      gate: 'open',
      justification: { text: 'Typed for an old request.', source: 'page' },
    });
    expect(
      db.queryAuditEvents({ eventType: 'approval.justification_edited' })[0]!.detail,
    ).toMatchObject({ had_agent_draft: false, chars: 'Typed for an old request.'.length });
  });

  it('governanceState is the code-free record and state a human surface reads', async () => {
    const { request, code } = await propose({ justification: WHY, ticket: 'INV-42' });
    const state = deploys.governanceState(request.id)!;
    expect(state).toMatchObject({
      requestId: request.id,
      kind: 'apex',
      status: 'validated',
      ticket: 'INV-42',
      justification: { text: WHY, source: 'agent' },
      provenance: 'Drafted by the agent. Edit it if it is not what you would say.',
      required: true,
      policySource: 'config',
      gate: 'open',
      blockedBy: null,
      violationCodes: [],
      frozenAtMint: false,
      override: null,
      unmatchedRules: [],
      rev: 'open:::',
    });
    expect(JSON.stringify(state)).not.toContain(code);
    expect(deploys.governanceState('00000000-0000-0000-0000-000000000000')).toBeNull();

    // A rule added after the mint that the request no longer satisfies.
    config.policies = {
      rules: [...ACME_RULE.rules, { name: 'tickets please', match: { orgTypes: ['developer'] }, requireTicket: true, ticketPattern: 'ABC-[0-9]+' }],
    };
    expect(deploys.governanceState(request.id)).toMatchObject({
      gate: 'blocked',
      blockedBy: 'violations',
      violationCodes: ['ticket_pattern'],
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import type { PolicyConfig } from '../core/policy.js';
import { ApprovalPageServer, type ApprovalStatusCheck } from '../deploy/approval.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import { stagingDir } from '../core/paths.js';
import type { OrgType } from '../core/types.js';

/**
 * S46 (B): export_change_evidence through the MCP surface — the folder it
 * writes (under the data directory's evidence/, never staging), what the
 * agent gets back (the path and counts only), the evidence.exported row, and
 * the dossier built from real requests: no confirmation code anywhere, the
 * identity recorded at mint, a wrong-code attempt under its request, the
 * ticket filter, and the refusals scoped to the matched connections.
 */

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let config: ContrailConfig;
let client: Client;
let presentedPages: string[];

const ORG_ID = '00D000000000001AAA';
const UAT_ORG_ID = '00D000000000002AAA';
const RULE = 'acme needs a reason';
const ACME_RULE: PolicyConfig = {
  rules: [{ name: RULE, match: { connections: ['acme-*'] }, requireJustification: true }],
};
const WHY = 'The client asked for the invoice fix to reach their org before month end.';

const NO_FILTER =
  'Name at least one of connection, ticket, request_id or since. An unfiltered dossier would ' +
  "mix every connection's changes in one folder.";

const RESULT_PREFIX =
  "Change evidence written to the folder below, on the human's machine and outside staging. " +
  'Give them the path; the files contain no confirmation codes and no record field values.';

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return json({
        access_token: 'AT',
        instance_url: 'https://acme.example.invalid',
        id: `https://login.salesforce.com/id/${ORG_ID}/005000000000001AAA`,
        token_type: 'Bearer',
      });
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af000000000001AAA</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:deployRecentValidation>')) {
        return new Response(
          soapEnvelope(
            `<deployRecentValidationResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>0Af000000000002AAA</result>
             </deployRecentValidationResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>
                 <done>true</done><status>Succeeded</status><success>true</success>
                 <checkOnly>false</checkOnly><numberComponentsTotal>1</numberComponentsTotal>
                 <numberComponentsDeployed>1</numberComponentsDeployed>
                 <numberComponentErrors>0</numberComponentErrors><numberTestsTotal>0</numberTestsTotal>
                 <numberTestsCompleted>0</numberTestsCompleted><numberTestErrors>0</numberTestErrors>
                 <details></details>
               </result>
             </checkDeployStatusResponse>`,
          ),
        );
      }
      // retrieve and listMetadata: the live check and the target guard fail
      // open — neither is what this file is about.
      return new Response('unexpected SOAP body', { status: 500 });
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
    if (url.includes('/query?q=')) return json({ totalSize: 0, done: true, records: [] });
    return new Response('not found', { status: 404 });
  });
}

function addConnection(alias: string, orgType: OrgType, orgId: string): string {
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  grants.data_read = true;
  grants.data_write = true;
  const conn = db.insertConnection({
    alias,
    instanceUrl: 'https://acme.example.invalid',
    loginUrl: 'https://login.salesforce.com',
    orgId,
    orgName: 'Acme',
    orgType,
    isSandbox: orgType === 'sandbox',
    username: 'admin@acme.example.invalid',
    userId: '005000000000001AAA',
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  return conn.id;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** The JSON body of a result whose text is `prefix\n{json}` or `{json}`. */
function bodyOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const text = textOf(result);
  return JSON.parse(text.startsWith('{') ? text : text.slice(text.indexOf('\n{') + 1)) as Record<
    string,
    unknown
  >;
}

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
}

async function call(tool: string, args: Record<string, unknown>) {
  return client.callTool({ name: tool, arguments: args });
}

async function executeCode(execTool: string, code: string, connection = 'acme-dev') {
  for (let i = 0; i < 80; i++) {
    const res = await call(execTool, { connection, confirmation_code: code });
    if (!/still running/.test(textOf(res))) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${execTool} never finished`);
}

function newestRequest(alias = 'acme-dev') {
  const conn = db.resolveConnection(alias)!;
  return db.queryDeployRequests({ connectionId: conn.id, limit: 1 })[0]!;
}

function readDossier(dir: string): { md: string; json: string; parsed: Record<string, unknown> } {
  const md = fs.readFileSync(path.join(dir, 'evidence.md'), 'utf8');
  const raw = fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8');
  return { md, json: raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-evidencetool-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  presentedPages = [];
  addConnection('acme-dev', 'developer', ORG_ID);
  addConnection('acme-uat', 'sandbox', UAT_ORG_ID);
  stubSalesforce();

  const approvals = new ApprovalPageServer(async () => {});
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (html: string, statusCheck?: ApprovalStatusCheck) => {
    presentedPages.push(html);
    return origPresent(html, statusCheck);
  };
  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    // The post-deploy snapshot re-read is not what this file is about.
    snapshot: { ...DEFAULT_CONFIG.snapshot, rebaselineAfterDeploy: false },
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
  const server = createServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('export_change_evidence', () => {
  it('refuses with no filter, an unknown connection, or a request id on another connection', async () => {
    const none = await call('export_change_evidence', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toBe(NO_FILTER);
    const untilOnly = await call('export_change_evidence', { until: '2026-11-17T00:00:00Z' });
    expect(textOf(untilOnly)).toBe(NO_FILTER);

    const unknown = await call('export_change_evidence', { connection: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe('No connection matches "nope". Call list_connections to see what exists.');

    const proposed = await call('apex_propose', {
      connection: 'acme-dev',
      code: "System.debug('invoice check');",
      justification: WHY,
    });
    expect(proposed.isError ?? false, textOf(proposed)).toBe(false);
    const id = newestRequest().id;
    const elsewhere = await call('export_change_evidence', { connection: 'acme-uat', request_id: id });
    expect(elsewhere.isError).toBe(true);
    expect(textOf(elsewhere)).toBe(`No request matches request_id "${id}" on "acme-uat".`);
    // The request exists, but the window excludes it: the refusal names the window.
    const later = new Date(Date.parse(newestRequest().createdAt) + 60_000).toISOString();
    const outside = await call('export_change_evidence', { request_id: id, since: later });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toBe(
      `No request matches request_id "${id}" proposed within the given since/until.`,
    );
    const outsideOn = await call('export_change_evidence', {
      connection: 'acme-dev',
      request_id: id,
      until: '2000-01-01T00:00:00Z',
    });
    expect(textOf(outsideOn)).toBe(
      `No request matches request_id "${id}" on "acme-dev" proposed within the given since/until.`,
    );
    expect(fs.existsSync(path.join(tmp, 'evidence'))).toBe(false);

    const badTime = await call('export_change_evidence', { connection: 'acme-dev', since: 'yesterday' });
    expect(badTime.isError).toBe(true);
    expect(textOf(badTime)).toBe(
      'since must be an ISO 8601 timestamp (for example 2026-11-17T09:00:00Z), got "yesterday".',
    );

    const nothing = await call('export_change_evidence', { ticket: 'NO-SUCH-TICKET' });
    expect(nothing.isError ?? false).toBe(false);
    expect(textOf(nothing)).toBe(
      'Nothing matched those filters — no dossier was written.\n' +
        JSON.stringify({ path: null, requests: 0, policy_refusals: 0 }, null, 2),
    );
    expect(fs.existsSync(path.join(tmp, 'evidence'))).toBe(false);
  });

  it('a validate → execute round trip: the dossier is under evidence/, holds no code, and the agent gets only the path and counts', async () => {
    const validated = await call('validate_deploy', {
      connection: 'acme-dev',
      components: [
        { type: 'ApexClass', api_name: 'Invoice_Service', content: 'public class Invoice_Service {}' },
      ],
      ticket: 'INV-42',
      justification: WHY,
    });
    expect(validated.isError ?? false, textOf(validated)).toBe(false);
    const request = newestRequest();
    const code = codeFromPage(presentedPages.at(-1)!);
    expect(db.getDeployRequest(request.id)!.confirmationCode).toBe(code);

    // A wrong guess first: it is counted against this request and joins its trail.
    const wrong = await call('execute_deploy', { connection: 'acme-dev', confirmation_code: 'ZZZZ-ZZZZ' });
    expect(wrong.isError).toBe(true);
    const executed = await executeCode('execute_deploy', code);
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(db.getDeployRequest(request.id)!.status).toBe('executed');

    const res = await call('export_change_evidence', { connection: 'acme-dev' });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const text = textOf(res);
    expect(text.startsWith(`${RESULT_PREFIX}\n{`)).toBe(true);
    const body = bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(
      ['audit_events', 'by_status', 'files', 'path', 'policy_refusals', 'requests', 'truncated'].sort(),
    );
    expect(body).toMatchObject({
      files: ['evidence.md', 'evidence.json'],
      requests: 1,
      by_status: { executed: 1 },
      policy_refusals: 0,
      truncated: false,
    });
    expect(body.audit_events).toBeGreaterThanOrEqual(3);
    const folder = body.path as string;
    expect(path.dirname(folder)).toBe(path.join(tmp, 'evidence'));
    expect(path.basename(folder)).toMatch(/^\d{8}-\d{6}-acme-dev$/);
    expect(folder.startsWith(stagingDir())).toBe(false);
    expect(fs.readdirSync(folder).sort()).toEqual(['evidence.json', 'evidence.md']);

    const { md, json: raw, parsed } = readDossier(folder);
    // The confirmation code is nowhere: not in either file, not in the result.
    for (const out of [md, raw, text]) expect(out).not.toContain(code);
    expect(md).toContain('## Request `' + request.id + '` — deploy on `acme-dev`');
    expect(md).toContain('- Ticket: `INV-42`');
    expect(md).toContain(
      '- Justification: Drafted by the agent and not edited by the human. Contrail does not record whether the approver read it.',
    );
    expect(md).toContain('```\n' + WHY + '\n```');
    expect(md).toContain('- Policy checks: proposal + execution');
    expect(md).toContain(
      '- Org and acting user at proposal: `acme-dev` · org `Acme` · org id `00D000000000001AAA` (`developer`) · user `admin@acme.example.invalid`',
    );
    expect(md).toContain('- Org and acting user at execution: the same org and user.');
    // The wrong-code attempt is listed under the request it was counted against.
    const entry = (parsed.requests as Array<{ audit_events: Array<{ event_type: string; detail: Record<string, unknown> }> }>)[0]!;
    const refused = entry.audit_events.find((e) => e.event_type === 'deploy.refused');
    expect(refused?.detail).toMatchObject({ requestId: request.id, reason: 'no_matching_code' });
    expect(entry.audit_events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['deploy.validated', 'deploy.refused', 'deploy.executed']),
    );

    // One evidence.exported row: the folder's name, never the path on this machine.
    const rows = db.queryAuditEvents({ eventType: 'evidence.exported' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe('export_change_evidence');
    expect(rows[0]!.detail).toEqual({
      requests: 1,
      policy_refusals: 0,
      folder: path.basename(folder),
      filters: { connection: 'acme-dev', ticket: null, request_id: null, since: null, until: null },
    });
    expect(JSON.stringify(rows[0])).not.toContain(tmp);
  });

  it('the ticket filter is case-insensitive', async () => {
    for (const ticket of ['INV-77', 'INV-78']) {
      const res = await call('apex_propose', {
        connection: 'acme-dev',
        code: `System.debug('${ticket}');`,
        ticket,
        justification: WHY,
      });
      expect(res.isError ?? false, textOf(res)).toBe(false);
    }
    const res = await call('export_change_evidence', { ticket: 'inv-77' });
    expect(bodyOf(res)).toMatchObject({ requests: 1 });
    const { parsed } = readDossier(bodyOf(res).path as string);
    expect((parsed.requests as Array<{ ticket: string }>).map((r) => r.ticket)).toEqual(['INV-77']);
  });

  it('a window with refusals only still writes a dossier', async () => {
    const refused = await call('apex_propose', { connection: 'acme-dev', code: "System.debug('x');" });
    expect(refused.isError).toBe(true);
    const res = await call('export_change_evidence', { connection: 'acme-dev' });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(bodyOf(res)).toMatchObject({ requests: 0, policy_refusals: 1 });
    const { md } = readDossier(bodyOf(res).path as string);
    expect(md).toContain('No request matched.');
    expect(md).toMatch(/\| `acme-dev` \| `policy\.refused` \| `apex_propose` \| `refused` \|/);
  });

  it('a connection re-authorised after the mint: the dossier prints the identity stored at mint', async () => {
    const proposed = await call('apex_propose', {
      connection: 'acme-dev',
      code: "System.debug('x');",
      justification: WHY,
    });
    expect(proposed.isError ?? false, textOf(proposed)).toBe(false);
    const id = newestRequest().id;
    const conn = db.resolveConnection('acme-dev')!;
    db.updateConnectionAuth(conn.id, {
      instanceUrl: conn.instanceUrl,
      loginUrl: conn.loginUrl,
      orgId: '00D000000000009AAA',
      orgName: 'Acme Refreshed',
      orgType: conn.orgType,
      isSandbox: conn.isSandbox,
      username: 'someone-else@acme.example.invalid',
      userId: conn.userId,
      grants: conn.grants,
    });
    const res = await call('export_change_evidence', { request_id: id });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const { md, json: raw } = readDossier(bodyOf(res).path as string);
    expect(md).toContain(
      '- Org and acting user at proposal: `acme-dev` · org `Acme` · org id `00D000000000001AAA` (`developer`) · user `admin@acme.example.invalid`',
    );
    for (const out of [md, raw]) {
      expect(out).not.toContain('someone-else@acme.example.invalid');
      expect(out).not.toContain('00D000000000009AAA');
    }
  });

  it('finds a ticket match at position 1,400 of 1,500 requests', async () => {
    const conn = db.resolveConnection('acme-dev')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let target = '';
    for (let i = 0; i < 1500; i++) {
      vi.setSystemTime(base + i * 1000);
      const rec = db.insertDeployRequest({
        connectionId: conn.id,
        kind: 'apex',
        confirmationCode: `TEST-${String(i).padStart(4, '0')}`,
        expiresAt: '2026-01-02T00:00:00.000Z',
        summaryJson: JSON.stringify({ governance: { v: 1, ticket: i === 100 ? 'OPS-1400' : `OPS-${i}-X` } }),
      });
      if (i === 100) target = rec.id;
    }
    vi.useRealTimers();
    // Newest first, the match is the 1,400th row: past the first page of 1,000.
    const order = db.queryDeployRequests({ connectionId: conn.id, limit: 1000, offset: 1000 });
    expect(order.findIndex((r) => r.id === target)).toBe(399);
    const res = await call('export_change_evidence', { ticket: 'ops-1400' });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(bodyOf(res)).toMatchObject({ requests: 1, truncated: false });
    const { parsed, md } = readDossier(bodyOf(res).path as string);
    expect((parsed.requests as Array<{ id: string }>)[0]!.id).toBe(target);
    expect(md).not.toContain('TEST-0100');
  });

  it('a request with 1,000 audit events: its list is cut, and the result says truncated', async () => {
    const proposed = await call('apex_propose', {
      connection: 'acme-dev',
      code: "System.debug('x');",
      justification: WHY,
    });
    expect(proposed.isError ?? false, textOf(proposed)).toBe(false);
    const id = newestRequest().id;
    for (let i = 0; i < 1000; i++) {
      db.insertAuditEvent({
        eventType: 'approval.notified',
        connectionId: db.resolveConnection('acme-dev')!.id,
        tool: 'apex_propose',
        outcome: 'success',
        detail: { requestId: id, method: 'pushover', n: i },
      });
    }
    const res = await call('export_change_evidence', { request_id: id });
    expect(bodyOf(res)).toMatchObject({ requests: 1, audit_events: 1000, truncated: true });
    const { md, parsed } = readDossier(bodyOf(res).path as string);
    expect(md).toContain('Only the newest 1,000 audit events of this request are listed.');
    expect(parsed.truncated).toBe(true);
    expect((parsed.requests as Array<{ audit_events_truncated: boolean }>)[0]!.audit_events_truncated).toBe(true);
  });

  it("a ticket-only dossier lists no other connection's policy refusals", async () => {
    // A refusal on another connection, and one on the matched request's own.
    expect((await call('apex_propose', { connection: 'acme-uat', code: "System.debug('u');" })).isError).toBe(true);
    expect((await call('apex_propose', { connection: 'acme-dev', code: "System.debug('d');" })).isError).toBe(true);
    const proposed = await call('apex_propose', {
      connection: 'acme-dev',
      code: "System.debug('x');",
      ticket: 'INV-90',
      justification: WHY,
    });
    expect(proposed.isError ?? false, textOf(proposed)).toBe(false);
    const res = await call('export_change_evidence', { ticket: 'INV-90' });
    expect(bodyOf(res)).toMatchObject({ requests: 1, policy_refusals: 1 });
    const { parsed } = readDossier(bodyOf(res).path as string);
    const refusals = parsed.policy_refusals as Array<{ connection: string }>;
    expect(refusals.map((r) => r.connection)).toEqual(['acme-dev']);
    expect(JSON.stringify(parsed.policy_refusals)).not.toContain('acme-uat');
  });
});

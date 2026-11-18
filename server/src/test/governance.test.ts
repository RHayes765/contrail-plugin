import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import {
  DEFAULT_POLICIES,
  freezeBannerText,
  freezeExecuteRefusalText,
  freezePageNotOpenedText,
  freezeProposeNote,
  freezeStartRefusalText,
  justificationProvenance,
  policyChangedText,
  policyRefusalText,
  policyUnreadableText,
  unmatchedRuleText,
  type PolicyConfig,
} from '../core/policy.js';
import {
  esc,
  renderApprovalPage,
  type ApprovalGovernance,
  type ApprovalPageOptions,
} from '../connect/pages.js';
import {
  FREEZE_TAIL,
  composePushover,
  type ApprovalNotifier,
  type ApprovalNotifyOptions,
  type NotifyOutcome,
} from '../core/notify.js';
import { SnapshotStore } from '../snapshot/store.js';
import {
  ApprovalPageServer,
  type ApprovalLivePage,
  type ApprovalStatusCheck,
} from '../deploy/approval.js';
import type { DeployEngine } from '../deploy/engine.js';
import { createDeps, createServer } from '../server.js';
import { emptyGrantSet } from '../core/grants.js';
import { stagingDir } from '../core/paths.js';
import type { OrgType } from '../core/types.js';

/**
 * S46 (B) propose gates: every proposing tool runs the policy check before
 * anything reaches the org and before any pending request is superseded. A
 * refusal is the verbatim policy text, costs no org request, writes one
 * policy.refused row, and leaves a code minted earlier executable. A dry run
 * reports what a real validation would be refused for. The policies come from
 * the injected config (the engine's default source) unless a test hands the
 * engine its own source.
 *
 * Every mint stores its change record (summary_json.governance and the
 * code-free page_view), returns it to the agent and audits it — never with
 * the code — and the approval page shows it on the Change record card.
 */

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let config: ContrailConfig;
let deploys: DeployEngine;
let client: Client;
let presentedPages: string[];
/** What each present() was handed besides the first render: the /status probe and the live hooks. */
let presented: Array<{ statusCheck?: ApprovalStatusCheck; live?: ApprovalLivePage }>;
/** true = the approval page cannot be opened in a browser. */
let browserFails: boolean;
let notifier: RecordingNotifier;

/**
 * S46 (B): the phone seam, recorded. Off by default — it then answers as an
 * unconfigured install does — and 'pushover' answers `outcome`.
 */
class RecordingNotifier implements ApprovalNotifier {
  calls: Array<{ view: ApprovalPageOptions; opts: ApprovalNotifyOptions }> = [];
  method: 'none' | 'pushover' = 'none';
  outcome: NotifyOutcome = { status: 'sent' };
  async notify(view: ApprovalPageOptions, opts: ApprovalNotifyOptions): Promise<NotifyOutcome> {
    this.calls.push({ view, opts });
    return this.method === 'none' ? { status: 'off' } : this.outcome;
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: this.method, when: 'always' as const, configured: true };
  }
  resetCircuit() {}
}

// ── fetch stub ───────────────────────────────────────────────────────────

/** Every URL fetched — "zero org requests" means this stays empty. */
let fetched: string[];
/** true = checkDeployStatus answers "still running" (in-progress and mint-gate tests). */
let holdValidation: boolean;
/** true = a finished deploy reports an org-side component failure. */
let failValidation: boolean;
let checkOnlyDeploys: number;
/** Deploys that would change the org: a checkOnly=false deploy or a quick deploy. */
let realDeploys: number;
let bulkJobs: Array<{ id: string; rows: number }>;
/** true = the live pre-image retrieve succeeds (the validate's re-persist runs). */
let liveRetrieve: boolean;
/** true = a DeployResult carries the org's createdDate, so the execute-time guard reads the org. */
let orgClock: boolean;
/** While set, every listMetadata call waits for it (the target guard's org read, held). */
let listHold: Promise<void> | null;
let listCalls: number;

const ACCOUNT_ID = '001000000000001AAA';
const ORG_ID = '00D000000000001AAA';
const EVAL_RUN_ID = '4KB000000000001AAA';

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function deployStatus(done: boolean, fail = false): string {
  const failed = done && fail;
  const passed = done && !fail;
  return soapEnvelope(
    `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
       <result>
         <done>${done}</done><status>${!done ? 'InProgress' : failed ? 'Failed' : 'Succeeded'}</status>
         <success>${passed}</success><checkOnly>false</checkOnly>${
           orgClock ? '<createdDate>2026-11-17T09:00:00.000Z</createdDate>' : ''
         }
         <numberComponentsTotal>1</numberComponentsTotal>
         <numberComponentsDeployed>${passed ? 1 : 0}</numberComponentsDeployed>
         <numberComponentErrors>${failed ? 1 : 0}</numberComponentErrors>
         <numberTestsTotal>0</numberTestsTotal>
         <numberTestsCompleted>0</numberTestsCompleted>
         <numberTestErrors>0</numberTestErrors>
         <details>${
           failed
             ? `<componentFailures><componentType>ApexClass</componentType>
                <fullName>Invoice_Service</fullName><problemType>Error</problemType>
                <problem>Compile error at line 1</problem></componentFailures>`
             : ''
         }</details>
       </result>
     </checkDeployStatusResponse>`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The org's current Invoice_Service, as a retrieve zip. */
function liveZipB64(): string {
  return Buffer.from(
    zipSync({
      'unpackaged/package.xml': strToU8('<Package/>'),
      'unpackaged/classes/Invoice_Service.cls': strToU8('public class Invoice_Service { /* live */ }'),
      'unpackaged/classes/Invoice_Service.cls-meta.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n',
      ),
    }),
  ).toString('base64');
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetched.push(url);
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
        const checkOnly = body.includes('<met:checkOnly>true</met:checkOnly>');
        if (checkOnly) checkOnlyDeploys += 1;
        else realDeploys += 1;
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af${checkOnly ? 'CHECK' : 'REAL0'}${String(fetched.length).padStart(10, '0')}</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:deployRecentValidation>')) {
        realDeploys += 1;
        return new Response(
          soapEnvelope(
            `<deployRecentValidationResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>0AfQUICK0000000001</result>
             </deployRecentValidationResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        return new Response(deployStatus(!holdValidation, failValidation));
      }
      if (liveRetrieve && body.includes('<met:retrieve>')) {
        return new Response(
          soapEnvelope(
            `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result>
               <id>09S000000000001</id><done>false</done><state>Queued</state>
             </result></retrieveResponse>`,
          ),
        );
      }
      if (liveRetrieve && body.includes('<met:checkRetrieveStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result>
               <done>true</done><id>09S000000000001</id><status>Succeeded</status>
               <success>true</success><zipFile>${liveZipB64()}</zipFile>
             </result></checkRetrieveStatusResponse>`,
          ),
        );
      }
      if (body.includes('<met:listMetadata>')) {
        listCalls += 1;
        if (listHold) await listHold;
      }
      // retrieve (unless liveRetrieve) and listMetadata: the live check and
      // the target guard fail open — neither is what these tests are about.
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
    if (url.includes('/tooling/query?q=')) return json({ totalSize: 0, done: true, records: [] });
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url);
      if (q.includes('FROM BotVersion')) {
        return json({
          totalSize: 1,
          done: true,
          records: [{ Id: '0X9000000000001AAA', DeveloperName: 'v1', Status: 'Inactive' }],
        });
      }
      if (q.includes('FROM Account')) {
        return json({
          totalSize: 1,
          done: true,
          records: [{ attributes: { type: 'Account', url: 'x' }, Id: ACCOUNT_ID, Name: 'Old Name' }],
        });
      }
      return json({ totalSize: 0, done: true, records: [] });
    }
    if (/\/connect\/bot-versions\/[^/]+\/activation$/.test(url)) {
      return json({ isActivated: true, messages: [], success: true });
    }
    // run_agent_eval on the Testing Center runner: a submit, then a poll.
    if (/\/einstein\/ai-evaluations\/runs\/?$/.test(url) && method === 'POST') {
      return json({ runId: EVAL_RUN_ID, status: 'NEW' });
    }
    if (url.includes(`/einstein/ai-evaluations/runs/${EVAL_RUN_ID}`)) {
      return json({ status: 'IN_PROGRESS', startTime: '2026-11-17T10:00:00.000Z' });
    }
    if (url.includes('/composite/sobjects')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { records?: unknown[] };
      return json((payload.records ?? []).map((_, i) => ({ id: `001NEW00000000${i}AAA`, success: true })));
    }
    if (/\/jobs\/ingest\/?$/.test(url) && method === 'POST') {
      const id = `750BULK00000${bulkJobs.length + 1}`;
      bulkJobs.push({ id, rows: 0 });
      return json({ id, state: 'Open', numberRecordsProcessed: 0, numberRecordsFailed: 0 });
    }
    const batches = /\/jobs\/ingest\/([^/]+)\/batches\/?$/.exec(url);
    if (batches && method === 'PUT') {
      const job = bulkJobs.find((j) => j.id === batches[1]);
      if (job) job.rows = String(init?.body ?? '').trim().split(/\r?\n/).length - 1;
      return new Response('', { status: 201 });
    }
    if (/\/jobs\/ingest\/[^/]+\/(successfulResults|failedResults|unprocessedrecords)\/?$/.test(url)) {
      return new Response('"sf__Id","sf__Created","Name"\n');
    }
    const jobUrl = /\/jobs\/ingest\/([^/]+)\/?$/.exec(url);
    if (jobUrl) {
      const job = bulkJobs.find((j) => j.id === jobUrl[1]);
      const state =
        method === 'PATCH'
          ? ((JSON.parse(String(init?.body ?? '{}')) as { state?: string }).state ?? '')
          : 'JobComplete';
      return json({
        id: jobUrl[1],
        state,
        numberRecordsProcessed: job?.rows ?? 0,
        numberRecordsFailed: 0,
        errorMessage: null,
      });
    }
    return new Response('not found', { status: 404 });
  });
}

// ── harness ──────────────────────────────────────────────────────────────

function codeFromPage(html: string): string {
  const m = html.match(/class="code"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  if (!m) throw new Error('no code found in approval page');
  return m[1]!;
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

function addConnection(alias: string, orgType: OrgType, orgId = ORG_ID): string {
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

function writeStagingCsv(name: string, content: string): string {
  const p = path.join(stagingDir(), name);
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-governance-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  presentedPages = [];
  presented = [];
  browserFails = false;
  notifier = new RecordingNotifier();
  fetched = [];
  holdValidation = false;
  failValidation = false;
  checkOnlyDeploys = 0;
  realDeploys = 0;
  bulkJobs = [];
  liveRetrieve = false;
  orgClock = false;
  listHold = null;
  listCalls = 0;

  addConnection('acme-dev', 'developer');
  stubSalesforce();

  const approvals = new ApprovalPageServer(async () => {
    if (browserFails) throw new Error('no display');
  });
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (
    html: string,
    statusCheck?: ApprovalStatusCheck,
    _ttlMs?: number,
    live?: ApprovalLivePage,
  ) => {
    presentedPages.push(html);
    presented.push({ statusCheck, live });
    return origPresent(html, statusCheck);
  };

  config = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    // S46 (C): these stubs model no post-execute listing or retrieve.
    snapshot: { ...DEFAULT_CONFIG.snapshot, rebaselineAfterDeploy: false },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 10, toolWaitMs: 10_000 },
    bulkLoad: { ...DEFAULT_CONFIG.bulkLoad, pollIntervalMs: 5, ingestTimeoutMs: 2000, toolWaitMs: 10_000 },
    policies: ACME_RULE,
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals,
    notifier,
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
  vi.unstubAllGlobals();
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────

const RULE = 'acme needs a reason';
const ACME_RULE: PolicyConfig = {
  rules: [{ name: RULE, match: { connections: ['acme-*'] }, requireJustification: true }],
};
const WHY = 'The client asked for the invoice fix to reach their org before month end.';

const JUSTIFICATION_VIOLATION = (rule: string, alias: string) =>
  `policy rule "${rule}" requires a justification for every change to "${alias}" — pass ` +
  'justification: one or two sentences, drafted from what the human asked for, on why this ' +
  'change is being made now';

const CONFIG_TAIL =
  "These rules are in the policies section of Contrail's config.json. No Contrail tool can " +
  "change the policies, and changing them is the human's decision alone: do not edit " +
  'config.json yourself and do not ask the human to loosen it for this change. Relay this ' +
  'refusal to them as it stands — do not try another tool, connection or route to make the ' +
  'same change.';

function proposeRefusal(alias: string, orgType: string, violation: string, tail = CONFIG_TAIL): string {
  return [
    `POLICY REFUSAL — nothing was validated, proposed or sent to "${alias}" (${orgType}), and ` +
      'any pending approval on it is untouched.',
    `- ${violation}`,
    tail,
  ].join('\n');
}

interface ToolCase {
  tool: string;
  kind: 'deploy' | 'dml' | 'apex' | 'activation' | 'bulk';
  execTool: string;
  args: () => Record<string, unknown>;
}

const CASES: ToolCase[] = [
  {
    tool: 'validate_deploy',
    kind: 'deploy',
    execTool: 'execute_deploy',
    args: () => ({
      components: [
        { type: 'ApexClass', api_name: 'Invoice_Service', content: 'public class Invoice_Service {}' },
      ],
    }),
  },
  {
    tool: 'deactivate_flow',
    kind: 'deploy',
    execTool: 'execute_deploy',
    args: () => ({ flow: 'Invoice_Reminder' }),
  },
  {
    tool: 'dml_propose',
    kind: 'dml',
    execTool: 'dml_execute',
    args: () => ({ operation: 'update', object: 'Account', records: [{ Id: ACCOUNT_ID, Name: 'New Name' }] }),
  },
  {
    tool: 'apex_propose',
    kind: 'apex',
    execTool: 'apex_execute',
    args: () => ({ code: "System.debug('invoice check');" }),
  },
  {
    tool: 'agent_activation_propose',
    kind: 'activation',
    execTool: 'agent_activation_execute',
    args: () => ({ agent: 'Invoice_Agent', version: 'v1', status: 'Active' }),
  },
  {
    tool: 'bulk_load_propose',
    kind: 'bulk',
    execTool: 'bulk_load_execute',
    args: () => ({
      steps: [
        {
          csv_file: writeStagingCsv('invoices.csv', 'Name\nAcme One\nAcme Two\n'),
          object: 'Account',
          operation: 'insert',
        },
      ],
    }),
  },
];

async function call(tool: string, args: Record<string, unknown>, connection = 'acme-dev') {
  return client.callTool({ name: tool, arguments: { connection, ...args } });
}

/** Execute a code until the result is no longer in progress; returns the final result. */
async function executeCode(execTool: string, code: string, connection = 'acme-dev') {
  for (let i = 0; i < 80; i++) {
    const res = await call(execTool, { confirmation_code: code }, connection);
    if (!/still running/.test(textOf(res))) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${execTool} never finished`);
}

function policyRefusals() {
  return db.queryAuditEvents({ eventType: 'policy.refused' });
}

/** The newest request on a connection (the one a propose just minted). */
function newestRequest(connectionAlias = 'acme-dev') {
  const conn = db.resolveConnection(connectionAlias)!;
  return db.queryDeployRequests({ connectionId: conn.id, limit: 1 })[0]!;
}

// ── per tool ─────────────────────────────────────────────────────────────

describe('a proposal that breaks a rule is refused before anything else happens', () => {
  for (const c of CASES) {
    it(`${c.tool}: the refusal verbatim, no org request, one policy.refused row, and the earlier code still executes`, async () => {
      // A code minted beforehand, with a justification — the human may be reading it.
      const first = await call(c.tool, { ...c.args(), justification: WHY });
      expect(first.isError ?? false, textOf(first)).toBe(false);
      const pending = newestRequest();
      expect(pending.kind).toBe(c.kind);
      expect(pending.status).toBe('validated');
      const code = codeFromPage(presentedPages.at(-1)!);
      const pagesBefore = presentedPages.length;
      expect(policyRefusals()).toHaveLength(0);

      fetched = [];
      const refused = await call(c.tool, c.args());
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(
        proposeRefusal('acme-dev', 'developer', JUSTIFICATION_VIOLATION(RULE, 'acme-dev')),
      );
      expect(textOf(refused)).not.toContain(code);
      expect(fetched).toEqual([]);
      expect(presentedPages).toHaveLength(pagesBefore);

      const rows = policyRefusals();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tool).toBe(c.tool);
      expect(rows[0]!.outcome).toBe('refused');
      expect(rows[0]!.connectionId).toBe(db.resolveConnection('acme-dev')!.id);
      expect(rows[0]!.detail).toEqual({
        phase: 'propose',
        kind: c.kind,
        reason: 'violations',
        rules: [RULE],
        violations: ['justification_required'],
        ticket_given: false,
        justification_given: false,
      });
      expect(JSON.stringify(rows[0])).not.toContain(code);

      // Nothing superseded: the earlier request is still pending, and its code runs.
      expect(db.queryAuditEvents({ eventType: `${c.kind}.superseded` })).toHaveLength(0);
      expect(db.getDeployRequest(pending.id)!.status).toBe('validated');
      const executed = await executeCode(c.execTool, code);
      expect(executed.isError ?? false, textOf(executed)).toBe(false);
      expect(db.getDeployRequest(pending.id)!.status).toBe('executed');
    });
  }

  it('the justification is the agent\'s draft: blank or whitespace counts as none', async () => {
    const refused = await call('apex_propose', { code: "System.debug('x');", justification: '   \n  ' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('requires a justification');
    expect(policyRefusals()[0]!.detail).toMatchObject({ justification_given: false });
  });

  it('a malformed ticket is refused as bad input before the policies are read, with no org request', async () => {
    const res = await call('dml_propose', {
      ...CASES[2]!.args(),
      justification: WHY,
      ticket: 'ABC-1\nABC-2',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'ticket must be one line of at most 120 characters with no control characters',
    );
    expect(fetched).toEqual([]);
    expect(policyRefusals()).toHaveLength(0);
  });

  it('a delete under denyDataDeletes is refused; a non-delete passes; Apex gets the POLICY NOTE instead', async () => {
    config.policies = {
      rules: [{ name: 'no data deletes', match: { connections: ['acme-dev'] }, denyDataDeletes: true }],
    };
    const del = await call('dml_propose', { operation: 'delete', object: 'Account', ids: [ACCOUNT_ID] });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toBe(
      proposeRefusal(
        'acme-dev',
        'developer',
        'policy rule "no data deletes" denies data deletes on "acme-dev" — this data change deletes records',
      ),
    );
    expect(fetched).toEqual([]);

    const bulkDelete = await call('bulk_load_propose', {
      steps: [{ csv_file: writeStagingCsv('gone.csv', `Id\n${ACCOUNT_ID}\n`), object: 'Account', operation: 'delete' }],
    });
    expect(bulkDelete.isError).toBe(true);
    expect(textOf(bulkDelete)).toContain('this bulk plan deletes records');
    expect(fetched).toEqual([]);

    const update = await call('dml_propose', CASES[2]!.args());
    expect(update.isError ?? false, textOf(update)).toBe(false);

    const apex = await call('apex_propose', { code: 'delete [SELECT Id FROM Account];' });
    expect(apex.isError ?? false, textOf(apex)).toBe(false);
    expect(presentedPages.at(-1)!).toContain(
      'POLICY NOTE — rule &quot;no data deletes&quot; denies data deletes on this connection through ' +
        'dml_propose and bulk_load_propose. Contrail does not inspect anonymous Apex, so it cannot ' +
        'tell whether this script deletes records — read it.',
    );
  });

  it('denyAnonymousApex refuses every apex_propose, and the page note is not added under it', async () => {
    config.policies = {
      rules: [
        { name: 'no anon apex', match: { orgTypes: ['developer'] }, denyAnonymousApex: true, denyDataDeletes: true },
      ],
    };
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      proposeRefusal('acme-dev', 'developer', 'policy rule "no anon apex" denies anonymous Apex on "acme-dev"'),
    );
    expect(fetched).toEqual([]);
  });

  it('a proposal that satisfies every rule mints as before, and writes no policy.refused row', async () => {
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY, ticket: 'INV-42' });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(presentedPages).toHaveLength(1);
    expect(policyRefusals()).toHaveLength(0);
  });
});

// ── the built-in default and unreadable policies ─────────────────────────

describe('where the rules come from', () => {
  it("Contrail's built-in default holds a production (and an unknown-type) org, and says it is the built-in rule", async () => {
    addConnection('acme-prod', 'production', '00D000000000002AAA');
    addConnection('acme-mystery', 'unknown', '00D000000000003AAA');
    deploys.setPolicySource(() => ({ ok: true, policies: DEFAULT_POLICIES, source: 'default' }));
    const builtIn =
      "This is Contrail's built-in default rule: config.json has no policies section (rules " +
      'written there replace it). No Contrail tool can change the policies, and changing them ' +
      "is the human's decision alone: do not edit config.json yourself and do not ask the human " +
      'to loosen it for this change. Relay this refusal to them as it stands — do not try ' +
      'another tool, connection or route to make the same change.';

    const prod = await call('apex_propose', { code: "System.debug('x');" }, 'acme-prod');
    expect(prod.isError).toBe(true);
    expect(textOf(prod)).toBe(
      proposeRefusal(
        'acme-prod',
        'production',
        JUSTIFICATION_VIOLATION('default: production needs a justification', 'acme-prod'),
        builtIn,
      ),
    );
    expect(textOf(prod)).not.toContain('are in the policies section');

    const mystery = await call('apex_propose', { code: "System.debug('x');" }, 'acme-mystery');
    expect(mystery.isError).toBe(true);
    expect(textOf(mystery)).toContain('"acme-mystery" (unknown)');
    expect(fetched).toEqual([]);

    // A developer org is untouched by the built-in rule.
    const dev = await call('apex_propose', { code: "System.debug('x');" });
    expect(dev.isError ?? false, textOf(dev)).toBe(false);

    // With a justification the production proposal mints.
    const justified = await call('apex_propose', { code: "System.debug('x');", justification: WHY }, 'acme-prod');
    expect(justified.isError ?? false, textOf(justified)).toBe(false);
  });

  const PROBLEM =
    'policies.rules[0]: unknown key "requireTickets" (known: name, match, requireJustification, ' +
    'requireTicket, ticketPattern, denyDestructiveMetadata, denyDataDeletes, denyAnonymousApex, ' +
    'minTestLevel, freezeWindows)';
  const UNREADABLE =
    `POLICY CHECK FAILED CLOSED — nothing was validated, proposed or sent. Contrail could not ` +
    `read the policies in config.json: ${PROBLEM}. Until that file is fixed, no write can be ` +
    'proposed and no agent test run started on any connection (reads still work). No Contrail ' +
    "tool edits config.json, and repairing it is the human's job — do not edit it yourself. " +
    'Relay this message to them exactly — do not try another route.';

  it('unreadable policies refuse every proposing tool, justified or not, with no org request', async () => {
    config.policies = { rules: [{ name: 'typo', requireTickets: true }] } as unknown as PolicyConfig;
    for (const c of CASES) {
      fetched = [];
      const res = await call(c.tool, { ...c.args(), justification: WHY });
      expect(res.isError, c.tool).toBe(true);
      expect(textOf(res), c.tool).toBe(UNREADABLE);
      expect(fetched, c.tool).toEqual([]);
    }
    const rows = policyRefusals();
    expect(rows).toHaveLength(CASES.length);
    expect(rows.map((r) => r.tool).sort()).toEqual(CASES.map((c) => c.tool).sort());
    for (const r of rows) {
      expect(r.detail).toMatchObject({ phase: 'propose', reason: 'config_unreadable' });
    }
    expect(presentedPages).toHaveLength(0);
  });

  it('a source that throws fails closed too', async () => {
    deploys.setPolicySource(() => {
      throw new Error('disk on fire');
    });
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('POLICY CHECK FAILED CLOSED');
    expect(textOf(res)).toContain('config.json could not be read (disk on fire)');
    expect(fetched).toEqual([]);
  });

  it('a dry run with unreadable policies still validates and reports status unreadable', async () => {
    deploys.setPolicySource(() => ({ ok: false, problem: PROBLEM }));
    const res = await call('validate_deploy', { ...CASES[0]!.args(), dry_run: true });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const body = bodyOf(res);
    expect(body.dry_run).toBe(true);
    expect(body.policy_check).toEqual({
      status: 'unreadable',
      problem: PROBLEM,
      rules: [],
      would_refuse: [],
      freeze: null,
      note:
        `Dry run: Contrail could not read the policies in config.json (${PROBLEM}), so none were ` +
        'evaluated. A real validation would be refused until the human fixes that file.',
    });
    expect(String(body.policy_check && (body.policy_check as { note: string }).note)).not.toContain(
      'policies were evaluated',
    );
    expect(checkOnlyDeploys).toBe(1);
    expect(policyRefusals()).toHaveLength(0);
    expect(presentedPages).toHaveLength(0);
  });
});

// ── dry runs ─────────────────────────────────────────────────────────────

describe('dry_run reports what a real validation would be refused for', () => {
  const DENY = 'no deletions on acme';
  const DESTRUCTIVE = {
    components: [{ type: 'ApexClass', api_name: 'Invoice_Service', content: 'public class Invoice_Service {}' }],
    destructive: [{ type: 'ApexClass', api_name: 'Old_Invoice_Service' }],
  };

  beforeEach(() => {
    config.policies = {
      rules: [{ name: DENY, match: { connections: ['acme-dev'] }, denyDestructiveMetadata: true }],
    };
  });

  it('under a deny rule the dry run passes with policy_check.would_refuse and audits no refusal', async () => {
    const res = await call('validate_deploy', { ...DESTRUCTIVE, dry_run: true });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const body = bodyOf(res);
    expect(body.policy_check).toEqual({
      status: 'would_refuse',
      rules: [DENY],
      would_refuse: [
        `policy rule "${DENY}" denies destructive metadata changes on "acme-dev" — this package contains deletions`,
      ],
      freeze: null,
      note:
        'Dry run: policies were evaluated and are reported here, not enforced. A real validation ' +
        'with these arguments would be refused for each entry in would_refuse.',
    });
    expect(checkOnlyDeploys).toBe(1);
    expect(policyRefusals()).toHaveLength(0);
    expect(presentedPages).toHaveLength(0);

    // The same arguments, for real: refused before the org is called.
    fetched = [];
    const real = await call('validate_deploy', DESTRUCTIVE);
    expect(real.isError).toBe(true);
    expect(textOf(real)).toBe(
      proposeRefusal(
        'acme-dev',
        'developer',
        `policy rule "${DENY}" denies destructive metadata changes on "acme-dev" — this package contains deletions`,
      ),
    );
    expect(fetched).toEqual([]);
    expect(policyRefusals()).toHaveLength(1);
  });

  it('a dry run that breaks nothing reports status ok with the rules that apply', async () => {
    const res = await call('validate_deploy', { components: DESTRUCTIVE.components, dry_run: true });
    const body = bodyOf(res);
    expect(body.policy_check).toMatchObject({ status: 'ok', rules: [DENY], would_refuse: [], freeze: null });
  });

  it('a dry run the org fails still reports policy_check.would_refuse', async () => {
    failValidation = true;
    const res = await call('validate_deploy', { ...DESTRUCTIVE, dry_run: true });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(textOf(res)).toMatch(/^Dry run: validation FAILED\./);
    const body = bodyOf(res);
    expect(body.component_failures).toHaveLength(1);
    expect(body.policy_check).toMatchObject({
      status: 'would_refuse',
      rules: [DENY],
      would_refuse: [
        `policy rule "${DENY}" denies destructive metadata changes on "acme-dev" — this package contains deletions`,
      ],
      freeze: null,
    });
    expect(checkOnlyDeploys).toBe(1);
    expect(policyRefusals()).toHaveLength(0);
    expect(presentedPages).toHaveLength(0);
  });

  it('a dry run the org fails reports unreadable policies too', async () => {
    failValidation = true;
    deploys.setPolicySource(() => ({ ok: false, problem: 'config.json is not a JSON object' }));
    const res = await call('validate_deploy', { ...DESTRUCTIVE, dry_run: true });
    const body = bodyOf(res);
    expect(body.policy_check).toMatchObject({
      status: 'unreadable',
      problem: 'config.json is not a JSON object',
      would_refuse: [],
    });
    expect(policyRefusals()).toHaveLength(0);
  });

  it('a real validation the org fails carries no policy_check', async () => {
    failValidation = true;
    const res = await call('validate_deploy', { components: DESTRUCTIVE.components });
    expect(textOf(res)).toMatch(/^Validation FAILED/);
    expect(bodyOf(res)).not.toHaveProperty('policy_check');
  });
});

// ── test level ───────────────────────────────────────────────────────────

describe('deactivate_flow under a minimum test level', () => {
  beforeEach(() => {
    config.policies = {
      rules: [{ name: 'acme tests', match: { connections: ['acme-*'] }, minTestLevel: 'RunLocalTests' }],
    };
  });

  it('omitted test_level is refused; an explicit level at the minimum validates', async () => {
    const omitted = await call('deactivate_flow', { flow: 'Invoice_Reminder' });
    expect(omitted.isError).toBe(true);
    expect(textOf(omitted)).toBe(
      proposeRefusal(
        'acme-dev',
        'developer',
        'policy rule "acme tests" requires test_level RunLocalTests or stricter on "acme-dev" — ' +
          "test_level was omitted, which leaves the choice to the org's own default, so Contrail " +
          'cannot show the minimum is met; pass test_level explicitly',
      ),
    );
    expect(fetched).toEqual([]);

    const weaker = await call('deactivate_flow', {
      flow: 'Invoice_Reminder',
      test_level: 'RunSpecifiedTests',
      run_tests: ['InvoiceTest'],
    });
    expect(textOf(weaker)).toContain('RunSpecifiedTests is weaker');

    const ok = await call('deactivate_flow', { flow: 'Invoice_Reminder', test_level: 'RunLocalTests' });
    expect(ok.isError ?? false, textOf(ok)).toBe(false);
    expect(textOf(ok)).toContain('Deactivation of flow "Invoice_Reminder" validated.');
    expect(presentedPages).toHaveLength(1);
  });

  it('deactivate_flow reuses the local test-level refusals', async () => {
    const noTests = await call('deactivate_flow', { flow: 'Invoice_Reminder', test_level: 'RunSpecifiedTests' });
    expect(noTests.isError).toBe(true);
    expect(textOf(noTests)).toBe('RunSpecifiedTests requires run_tests.');
    addConnection('acme-prod', 'production', '00D000000000002AAA');
    const noTestRun = await call(
      'deactivate_flow',
      { flow: 'Invoice_Reminder', test_level: 'NoTestRun', justification: WHY },
      'acme-prod',
    );
    expect(noTestRun.isError).toBe(true);
    expect(textOf(noTestRun)).toContain('test_level NoTestRun is refused locally on "acme-prod" (production)');
    expect(fetched).toEqual([]);
    expect(policyRefusals()).toHaveLength(0);
  });
});

// ── job identity ─────────────────────────────────────────────────────────

describe('ticket and justification are part of a validation job\'s identity', () => {
  it('a reworded justification is a different job; identical arguments are the same job', async () => {
    const args = CASES[0]!.args();
    const a = bodyOf(await call('validate_deploy', { ...args, justification: WHY, dry_run: true }));
    const b = bodyOf(await call('validate_deploy', { ...args, justification: `${WHY} Again.`, dry_run: true }));
    const a2 = bodyOf(await call('validate_deploy', { ...args, justification: WHY, dry_run: true }));
    const t = bodyOf(await call('validate_deploy', { ...args, justification: WHY, ticket: 'INV-1', dry_run: true }));
    expect(a.job_id).not.toBe(b.job_id);
    expect(a.job_id).not.toBe(t.job_id);
    expect(a.job_id).toBe(a2.job_id);
  });

  it('job_id with ticket or justification is the strict-poll refusal', async () => {
    for (const extra of [{ ticket: 'INV-1' }, { justification: WHY }]) {
      const res = await call('validate_deploy', { job_id: 'val-000000000000', ...extra });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Pass job_id ALONE to poll a running validation');
    }
  });

  it('a running deactivate_flow names its job; a re-send attaches; validate_deploy collects it', async () => {
    config.deploy.toolWaitMs = 60;
    holdValidation = true;
    const first = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(first.isError ?? false, textOf(first)).toBe(false);
    const jobId = String(bodyOf(first).job_id);
    expect(jobId).toMatch(/^val-[0-9a-f]{12}$/);
    expect(textOf(first)).toContain(
      `Still validating (job ${jobId}) — check on it with validate_deploy {connection, job_id: ` +
        `"${jobId}"}, or call deactivate_flow again with EXACTLY the same arguments. ticket, ` +
        "justification and test_level are part of the job's identity: a call that changes any of " +
        'them, a reworded justification included, starts a second validation, and any code it ' +
        "issues replaces this one's.",
    );

    const again = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(bodyOf(again).job_id).toBe(jobId);
    expect(checkOnlyDeploys).toBe(1);

    // validate_deploy's own in-progress answer says the same about identity.
    const poll = await call('validate_deploy', { job_id: jobId });
    expect(textOf(poll)).toContain(
      'ticket and justification are part of that identity — a reworded justification starts a ' +
        "second validation, and any code it issues replaces this one's; poll with job_id.",
    );

    holdValidation = false;
    config.deploy.toolWaitMs = 10_000;
    const collected = await call('validate_deploy', { job_id: jobId });
    expect(collected.isError ?? false, textOf(collected)).toBe(false);
    expect(textOf(collected)).toContain('Validation passed. TARGET: acme-dev (developer).');
    expect(textOf(collected)).toContain('Contrail gives the confirmation code only to the human');
    expect(presentedPages).toHaveLength(1);
    expect(checkOnlyDeploys).toBe(1);
  });
});

// ── the second check, when a validation finishes ─────────────────────────

describe('the deploy mint re-reads the policies', () => {
  it('a rule added while the validation ran refuses at the mint: bare text, nothing superseded, the earlier code still executes', async () => {
    // A code minted beforehand — with a ticket, so it still satisfies the
    // rule added below when its own execute re-checks the policies (P11).
    await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY, ticket: TICKET });
    const pending = newestRequest();
    const code = codeFromPage(presentedPages.at(-1)!);

    config.deploy.toolWaitMs = 60;
    holdValidation = true;
    const started = await call('validate_deploy', {
      components: [{ type: 'ApexClass', api_name: 'Invoice_Batch', content: 'public class Invoice_Batch {}' }],
      justification: WHY,
    });
    const jobId = String(bodyOf(started).job_id);
    expect(textOf(started)).toContain('Validation is still running');

    // While it runs, the human adds a ticket rule this request does not meet.
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        { name: 'acme tickets', match: { connections: ['acme-*'] }, requireTicket: true },
      ],
    };
    holdValidation = false;
    config.deploy.toolWaitMs = 10_000;
    const finished = await call('validate_deploy', { job_id: jobId });
    expect(finished.isError).toBe(true);
    expect(textOf(finished)).toBe(
      [
        'POLICY REFUSAL — the check-only validation ran on "acme-dev" (developer), but no approval ' +
          'was created and any pending approval on it is untouched. Contrail re-read the policies ' +
          'when the validation finished, and they do not allow this request:',
        '- policy rule "acme tickets" requires a ticket for every change to "acme-dev" — pass ' +
          'ticket with the reference the human gave you; if they gave none, ask them (never invent one)',
        CONFIG_TAIL,
      ].join('\n'),
    );
    expect(textOf(finished)).not.toContain('Validation errored');

    const rows = policyRefusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({
      phase: 'mint',
      kind: 'deploy',
      reason: 'violations',
      violations: ['ticket_required'],
      justification_given: true,
    });
    expect(db.queryAuditEvents({ eventType: 'deploy.superseded' })).toHaveLength(0);
    expect(presentedPages).toHaveLength(1);
    expect(db.getDeployRequest(pending.id)!.status).toBe('validated');

    const executed = await executeCode('execute_deploy', code);
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(db.getDeployRequest(pending.id)!.status).toBe('executed');
  });

  for (const c of [CASES[0]!, CASES[1]!]) {
    it(`${c.tool}: a re-send refused while its validation runs says it did not attach and that the validation goes on`, async () => {
      config.deploy.toolWaitMs = 60;
      holdValidation = true;
      const args = { ...c.args(), justification: WHY };
      const started = await call(c.tool, args);
      expect(started.isError ?? false, textOf(started)).toBe(false);
      const jobId = String(bodyOf(started).job_id);
      expect(checkOnlyDeploys).toBe(1);

      // While it runs, the human adds a ticket rule this request does not
      // meet, and the agent re-sends the same arguments.
      const tickets: PolicyConfig = {
        rules: [...ACME_RULE.rules, { name: 'acme tickets', match: { connections: ['acme-*'] }, requireTicket: true }],
      };
      const violation =
        'policy rule "acme tickets" requires a ticket for every change to "acme-dev" — pass ticket with ' +
        'the reference the human gave you; if they gave none, ask them (never invent one)';
      deploys.setPolicySource(() => ({ ok: true, policies: tickets, source: 'config' }));
      const refused = await call(c.tool, args);
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(
        [
          'POLICY REFUSAL — this call was not attached to the validation already running on "acme-dev" ' +
            '(developer) with these arguments; this call sent nothing and left any pending approval ' +
            'untouched. That validation goes on and is checked against the policies again when it ' +
            'finishes — no approval is created unless they then allow it; poll it by job_id to see its ' +
            'outcome. The policies now do not allow this request:',
          `- ${violation}`,
          CONFIG_TAIL,
        ].join('\n'),
      );

      // The file becomes unreadable: the same, in the failed-closed text.
      const problem = 'config.json is not valid JSON (Unexpected end)';
      deploys.setPolicySource(() => ({ ok: false, problem }));
      const unreadable = await call(c.tool, args);
      expect(unreadable.isError).toBe(true);
      expect(textOf(unreadable)).toBe(policyUnreadableText(problem, 'attach'));
      expect(textOf(unreadable)).toContain('this call was not attached to the validation already running');

      // Both audited as first checks; neither touched the org.
      expect(policyRefusals().map((r) => [r.tool, r.detail])).toEqual([
        [c.tool, { phase: 'propose', kind: 'deploy', reason: 'config_unreadable' }],
        [
          c.tool,
          {
            phase: 'propose',
            kind: 'deploy',
            reason: 'violations',
            rules: ['acme tickets'],
            violations: ['ticket_required'],
            ticket_given: false,
            justification_given: true,
          },
        ],
      ]);
      expect(checkOnlyDeploys).toBe(1);

      // The rules are put back before it finishes: the validation the first
      // call started goes on and opens its approval, as the refusal said.
      deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
      holdValidation = false;
      await vi.waitFor(
        () => expect(db.queryAuditEvents({ eventType: 'deploy.validated' })).toHaveLength(1),
        { timeout: 5000 },
      );
      await new Promise((r) => setTimeout(r, 20)); // the job settles
      expect(presentedPages).toHaveLength(1);

      // Finished but not yet collected, so nothing is running: a refusal now
      // is the propose text.
      deploys.setPolicySource(() => ({ ok: true, policies: tickets, source: 'config' }));
      const fresh = await call(c.tool, args);
      expect(textOf(fresh)).toBe(proposeRefusal('acme-dev', 'developer', violation));

      config.deploy.toolWaitMs = 10_000;
      const finished = await call('validate_deploy', { job_id: jobId });
      expect(finished.isError ?? false, textOf(finished)).toBe(false);
      expect(textOf(finished)).toContain('Validation passed. TARGET: acme-dev (developer).');
      expect(presentedPages).toHaveLength(1);
      expect(checkOnlyDeploys).toBe(1);
    });
  }

  it('deactivate_flow returns a mint-time refusal bare as well', async () => {
    config.deploy.toolWaitMs = 60;
    holdValidation = true;
    const started = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(textOf(started)).toContain('Still validating (job ');
    // The re-send's own first check still reads the file; by the time the
    // validation finishes, config.json has been broken.
    let loads = 0;
    deploys.setPolicySource(() => {
      loads += 1;
      if (loads === 1) {
        holdValidation = false;
        return { ok: true, policies: ACME_RULE, source: 'config' };
      }
      return { ok: false, problem: 'config.json is not valid JSON (Unexpected end)' };
    });
    config.deploy.toolWaitMs = 10_000;
    const finished = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(finished.isError).toBe(true);
    expect(textOf(finished)).toBe(
      'POLICY CHECK FAILED CLOSED — the check-only validation ran, but no approval was created ' +
        'and any pending approval is untouched. Contrail could not read the policies in ' +
        'config.json when the validation finished: config.json is not valid JSON (Unexpected end). ' +
        "No Contrail tool edits config.json, and repairing it is the human's job — do not edit it " +
        'yourself. Relay this message to them exactly; once the file is fixed, validate again.',
    );
    expect(policyRefusals().map((r) => r.detail)).toEqual([
      { phase: 'mint', kind: 'deploy', reason: 'config_unreadable' },
    ]);
    expect(policyRefusals()[0]!.tool).toBe('deactivate_flow');
    expect(presentedPages).toHaveLength(0);
  });
});

// ── labels ───────────────────────────────────────────────────────────────

describe('a label rule covers the org, and list_connections names rules that match nothing', () => {
  async function listing() {
    return bodyOf(await client.callTool({ name: 'list_connections', arguments: {} })) as {
      connections: Array<{ alias: string; policy: Record<string, unknown> | null }>;
      policies_status: Record<string, unknown>;
    };
  }

  it('a second connection to the same org under another label inherits the label rule', async () => {
    // The same org by its 15-character id, connected again under a label the rule does not name.
    addConnection('client-second-label', 'developer', ORG_ID.slice(0, 15));
    const res = await call('apex_propose', { code: "System.debug('x');" }, 'client-second-label');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      proposeRefusal(
        'client-second-label',
        'developer',
        JUSTIFICATION_VIOLATION(RULE, 'client-second-label'),
      ),
    );
    expect(fetched).toEqual([]);

    const list = await listing();
    for (const alias of ['acme-dev', 'client-second-label']) {
      expect(list.connections.find((c) => c.alias === alias)!.policy).toMatchObject({
        rules: [RULE],
        requires_justification: true,
      });
    }
    expect(list.policies_status).toEqual({ status: 'ok', source: 'config', unmatched_rules: [] });
  });

  it('a rule whose label or org id matches no stored connection is named in unmatched_rules', async () => {
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        { name: 'old client org', match: { orgIds: ['00D0000000000ZZ'] }, requireTicket: true },
        { name: 'all production', match: { orgTypes: ['production'] }, requireJustification: true },
      ],
    };
    expect((await listing()).policies_status).toEqual({
      status: 'ok',
      source: 'config',
      unmatched_rules: ['old client org'],
    });
    // Both connections to the acme org gone, and the org re-connected under a new label.
    addConnection('client-second-label', 'developer', ORG_ID);
    db.deleteConnection(db.resolveConnection('acme-dev')!.id);
    db.deleteConnection(db.resolveConnection('client-second-label')!.id);
    addConnection('client-renamed', 'developer', ORG_ID);
    const after = await listing();
    expect(after.policies_status).toEqual({
      status: 'ok',
      source: 'config',
      unmatched_rules: [RULE, 'old client org'],
    });
    expect(after.connections.find((c) => c.alias === 'client-renamed')!.policy).toMatchObject({ rules: [] });
  });

  it('list_connections reports each requirement, deny rule, freeze window and the freeze in effect', async () => {
    config.policies = {
      rules: [
        {
          name: 'acme change control',
          match: { connections: ['acme-*'] },
          requireTicket: true,
          ticketPattern: 'INV-[0-9]+',
          denyDestructiveMetadata: true,
          denyDataDeletes: true,
          minTestLevel: 'RunLocalTests',
          freezeWindows: [
            { name: 'always', range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' }, timeZone: 'UTC' },
          ],
        },
      ],
    };
    const list = await listing();
    expect(list.connections.find((c) => c.alias === 'acme-dev')!.policy).toEqual({
      rules: ['acme change control'],
      requires_justification: false,
      requires_ticket: true,
      ticket_patterns: ['INV-[0-9]+'],
      denies: ['destructive_metadata', 'data_deletes'],
      min_test_level: 'RunLocalTests',
      freeze_windows: [
        { rule: 'acme change control', name: 'always', when: '2000-01-01 00:00 to 2999-01-01 00:00', time_zone: 'UTC' },
      ],
      freeze_now: { rule: 'acme change control', window: 'always', until: '2999-01-01 00:00 UTC' },
    });
  });

  it('unreadable policies: no per-connection policy, and policies_status says every proposal is refused', async () => {
    deploys.setPolicySource(() => ({ ok: false, problem: 'config.json is not a JSON object' }));
    const list = await listing();
    expect(list.connections[0]!.policy).toBeNull();
    expect(list.policies_status).toEqual({
      status: 'unreadable',
      problem: 'config.json is not a JSON object',
      note: 'Every write proposal is refused until the human fixes config.json.',
    });
  });

  it('one listing reads the policies once: a config.json change during the call cannot put a policy beside "unreadable"', async () => {
    addConnection('acme-uat', 'sandbox', '00D000000000002AAA');
    const unreadable = { ok: false as const, problem: 'config.json is not a JSON object' };
    const readable = { ok: true as const, policies: ACME_RULE, source: 'config' as const };
    // The file breaks after the first read.
    let loads = 0;
    deploys.setPolicySource(() => {
      loads += 1;
      return loads === 1 ? readable : unreadable;
    });
    const broke = await listing();
    expect(loads).toBe(1);
    expect(broke.connections).toHaveLength(2);
    for (const c of broke.connections) expect(c.policy).toMatchObject({ rules: [RULE] });
    expect(broke.policies_status).toEqual({ status: 'ok', source: 'config', unmatched_rules: [] });

    // The file is fixed after the first read.
    loads = 0;
    deploys.setPolicySource(() => {
      loads += 1;
      return loads === 1 ? unreadable : readable;
    });
    const fixed = await listing();
    expect(loads).toBe(1);
    for (const c of fixed.connections) expect(c.policy).toBeNull();
    expect(fixed.policies_status).toMatchObject({ status: 'unreadable' });
  });
});

// ── the change trail ─────────────────────────────────────────────────────

describe('policy.config_seen', () => {
  function seen() {
    return db.queryAuditEvents({ eventType: 'policy.config_seen' }).reverse();
  }

  it('records the first policies seen, then only a change; a second engine on the database adopts the row', async () => {
    await client.callTool({ name: 'list_connections', arguments: {} });
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(seen()).toHaveLength(1);
    const first = seen()[0]!.detail!;
    expect(first).toMatchObject({ previous_sha256: null, source: 'config', rules: [RULE], status: 'ok', changed: false });

    // An unreadable interlude that ends with the same policies is not a change.
    deploys.setPolicySource(() => ({ ok: false, problem: 'config.json is not a JSON object' }));
    await client.callTool({ name: 'list_connections', arguments: {} });
    deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    await client.callTool({ name: 'list_connections', arguments: {} });
    expect(seen().map((r) => [r.detail!.status, r.detail!.changed])).toEqual([
      ['ok', false],
      ['unreadable', false],
      ['ok', false],
    ]);

    // A second engine on the same database, primed while the old policies stand.
    const other = createDeps({
      db,
      tokens,
      config,
      store: new SnapshotStore(path.join(tmp, 'snapshots')),
    });
    other.deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    other.deploys.policiesStatus();
    expect(seen()).toHaveLength(3);

    // A real change is.
    deploys.setPolicySource(() => ({ ok: true, policies: { rules: [] }, source: 'config' }));
    await client.callTool({ name: 'list_connections', arguments: {} });
    const rows = seen();
    expect(rows).toHaveLength(4);
    expect(rows[3]!.detail).toMatchObject({
      previous_sha256: rows[2]!.detail!.sha256,
      rules: [],
      status: 'ok',
      changed: true,
    });

    // The second engine then sees the new policies: it adopts the row the
    // first one recorded and writes nothing, change cue included.
    other.deploys.setPolicySource(() => ({ ok: true, policies: { rules: [] }, source: 'config' }));
    const status = other.deploys.policiesStatus();
    expect(seen()).toHaveLength(4);
    expect(status).toMatchObject({ status: 'ok' });
  });
});

// ── the change record a mint stores ──────────────────────────────────────

const TICKET = 'INV-42';
const RULE_LINE = `A justification is required (rule "${RULE}").`;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NO_REQUIREMENTS = {
  justification: false,
  ticket: false,
  ticketPatterns: [],
  denyDestructiveMetadata: false,
  denyDataDeletes: false,
  denyAnonymousApex: false,
  minTestLevel: null,
};

/** The audit row each kind's mint writes. */
const MINT_EVENT: Record<ToolCase['kind'], string> = {
  deploy: 'deploy.validated',
  dml: 'dml.proposed',
  apex: 'apex.proposed',
  activation: 'activation.proposed',
  bulk: 'bulk.proposed',
};

/** The request the newest presented page belongs to — found by its code, never by time. */
function mintedRequest(kind: ToolCase['kind'], connectionAlias = 'acme-dev') {
  const conn = db.resolveConnection(connectionAlias)!;
  const request = db.findRequestByCode(conn.id, kind, codeFromPage(presentedPages.at(-1)!));
  if (!request) throw new Error('no request for the newest page');
  return request;
}

function summaryOf(id: string): Record<string, any> {
  return JSON.parse(db.getDeployRequest(id)!.summaryJson) as Record<string, any>;
}

describe('the change record a mint stores', () => {
  for (const c of CASES) {
    it(`${c.tool}: summary_json.governance in its exact shape, the result's governance and the audit detail — and the code in none of them`, async () => {
      const res = await call(c.tool, { ...c.args(), justification: WHY, ticket: TICKET });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const request = mintedRequest(c.kind);
      const code = request.confirmationCode;
      const summary = summaryOf(request.id);

      expect(summary.governance).toEqual({
        v: 1,
        surface: 'page',
        target: {
          alias: 'acme-dev',
          org_id: ORG_ID,
          org_name: 'Acme',
          org_type: 'developer',
          username: 'admin@acme.example.invalid',
        },
        ticket: TICKET,
        justification: { text: WHY, source: 'agent' },
        inputs: { destructive: false, test_level: null },
        policy: {
          evaluated_at: expect.stringMatching(ISO_RE),
          source: 'config',
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          rules: [RULE],
          requirements: { ...NO_REQUIREMENTS, justification: true },
          lines: [RULE_LINE],
        },
        freeze: null,
        freeze_override: null,
        execute_check: null,
      });
      // The fingerprint is the one the change trail recorded for these policies.
      const seen = db.queryAuditEvents({ eventType: 'policy.config_seen' });
      expect(summary.governance.policy.sha256).toBe(seen[0]!.detail!.sha256);
      expect(summary.page_view).toMatchObject({
        v: 1,
        kind: c.kind,
        org: { alias: 'acme-dev', org_name: 'Acme', org_type: 'developer' },
        expires_at: request.expiresAt,
      });

      expect(bodyOf(res).governance).toEqual({
        ticket: TICKET,
        justification: { text: WHY, source: 'agent' },
        policy: { rules: [RULE], lines: [RULE_LINE] },
        freeze: null,
      });

      const mintRows = db.queryAuditEvents({ eventType: MINT_EVENT[c.kind] });
      expect(mintRows).toHaveLength(1);
      expect(mintRows[0]!.detail!.requestId).toBe(request.id);
      expect(mintRows[0]!.detail!.governance).toEqual({
        ticket: TICKET,
        justification_source: 'agent',
        justification_chars: WHY.length,
        rules: [RULE],
        frozen: false,
      });

      // The code is on the page and in the row's own column — nowhere else:
      // not in the result, not in any audit row, not in the summary or its page view.
      expect(textOf(res)).not.toContain(code);
      expect(db.getDeployRequest(request.id)!.summaryJson).not.toContain(code);
      const audit = db.queryAuditEvents({ limit: 1000 });
      expect(audit.length).toBeGreaterThan(0);
      for (const row of audit) {
        expect(JSON.stringify(row)).not.toContain(code);
        // The justification's text is recorded with the request, never in an audit row.
        expect(JSON.stringify(row)).not.toContain(WHY);
      }
    });
  }

  it('the stored justification is the normalised draft — line breaks folded to LF, trimmed — and counted so', async () => {
    const res = await call('apex_propose', {
      code: "System.debug('x');",
      justification: '  First line.\r\nSecond line.\rThird line.  ',
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const request = mintedRequest('apex');
    const text = 'First line.\nSecond line.\nThird line.';
    expect(summaryOf(request.id).governance.justification).toEqual({ text, source: 'agent' });
    expect(bodyOf(res).governance).toMatchObject({ justification: { text, source: 'agent' } });
    expect(db.queryAuditEvents({ eventType: 'apex.proposed' })[0]!.detail!.governance).toMatchObject({
      justification_source: 'agent',
      justification_chars: text.length,
    });
  });

  it('with no rule and no justification the record says so: nulls, no rules, nothing required', async () => {
    config.policies = { rules: [] };
    const res = await call('apex_propose', { code: "System.debug('x');" });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const request = mintedRequest('apex');
    expect(summaryOf(request.id).governance).toMatchObject({
      ticket: null,
      justification: null,
      policy: { source: 'config', rules: [], requirements: NO_REQUIREMENTS, lines: [] },
      freeze: null,
    });
    expect(bodyOf(res).governance).toEqual({
      ticket: null,
      justification: null,
      policy: { rules: [], lines: [] },
      freeze: null,
    });
    expect(db.queryAuditEvents({ eventType: 'apex.proposed' })[0]!.detail!.governance).toEqual({
      ticket: null,
      justification_source: null,
      justification_chars: 0,
      rules: [],
      frozen: false,
    });
  });

  it('inputs record what the policies were evaluated with: deletions and the test level', async () => {
    const deploy = await call('validate_deploy', {
      components: CASES[0]!.args().components,
      destructive: [{ type: 'ApexClass', api_name: 'Old_Invoice_Service' }],
      test_level: 'RunLocalTests',
      justification: WHY,
    });
    expect(deploy.isError ?? false, textOf(deploy)).toBe(false);
    expect(summaryOf(mintedRequest('deploy').id).governance.inputs).toEqual({
      destructive: true,
      test_level: 'RunLocalTests',
    });

    const dml = await call('dml_propose', {
      operation: 'delete',
      object: 'Account',
      ids: [ACCOUNT_ID],
      justification: WHY,
    });
    expect(dml.isError ?? false, textOf(dml)).toBe(false);
    expect(summaryOf(mintedRequest('dml').id).governance.inputs).toEqual({
      destructive: true,
      test_level: null,
    });

    const bulk = await call('bulk_load_propose', {
      steps: [
        {
          csv_file: writeStagingCsv('gone.csv', `Id\n${ACCOUNT_ID}\n`),
          object: 'Account',
          operation: 'delete',
        },
      ],
      justification: WHY,
    });
    expect(bulk.isError ?? false, textOf(bulk)).toBe(false);
    expect(summaryOf(mintedRequest('bulk').id).governance.inputs).toEqual({
      destructive: true,
      test_level: null,
    });
  });

  it('governance.target is the connection as it was at mint — a re-authorisation does not rewrite it', async () => {
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const first = mintedRequest('apex');
    const conn = db.resolveConnection('acme-dev')!;
    db.updateConnectionAuth(conn.id, {
      instanceUrl: conn.instanceUrl,
      loginUrl: conn.loginUrl,
      orgId: '00D000000000009AAA',
      orgName: 'Acme Renamed',
      orgType: 'sandbox',
      isSandbox: true,
      username: 'someone-else@acme.example.invalid',
      userId: '005000000000009AAA',
      grants: conn.grants,
    });
    expect(summaryOf(first.id).governance.target).toEqual({
      alias: 'acme-dev',
      org_id: ORG_ID,
      org_name: 'Acme',
      org_type: 'developer',
      username: 'admin@acme.example.invalid',
    });

    // A request minted afterwards records the connection as it is then.
    await call('apex_propose', { code: "System.debug('y');", justification: WHY });
    const second = mintedRequest('apex');
    expect(second.id).not.toBe(first.id);
    expect(summaryOf(second.id).governance.target).toEqual({
      alias: 'acme-dev',
      org_id: '00D000000000009AAA',
      org_name: 'Acme Renamed',
      org_type: 'sandbox',
      username: 'someone-else@acme.example.invalid',
    });
    expect(summaryOf(first.id).governance.target.org_id).toBe(ORG_ID);
  });

  it('a freeze in effect at mint is recorded once: the stored freeze, the result and the audit detail agree', async () => {
    const FREEZE_RULE = 'acme freeze';
    config.policies = {
      rules: [
        {
          name: FREEZE_RULE,
          match: { connections: ['acme-*'] },
          freezeWindows: [
            {
              name: 'always',
              range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' },
              timeZone: 'UTC',
            },
          ],
        },
      ],
    };
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    // A frozen page carries no code, so the request is found by time here.
    const request = newestRequest();
    expect(request.kind).toBe('apex');
    const freeze = { rule: FREEZE_RULE, window: 'always', until: '2999-01-01 00:00 UTC' };
    const stored = summaryOf(request.id).governance;
    expect(stored.freeze).toEqual({ ...freeze, time_zone: 'UTC' });
    expect(stored.policy.lines).toEqual([
      `Freeze window "always": 2000-01-01 00:00 to 2999-01-01 00:00 UTC (rule "${FREEZE_RULE}").`,
    ]);
    const note = freezeProposeNote('acme-dev', freeze, 'page');
    expect(bodyOf(res).governance).toMatchObject({ freeze: { active: true, ...freeze, note } });
    // The result closes with the freeze note in place of the approval instructions.
    expect(textOf(res)).toContain(
      `Proposed — nothing executed. TARGET: acme-dev (developer). ${note}`,
    );
    expect(textOf(res)).not.toContain(request.confirmationCode);
    expect(db.queryAuditEvents({ eventType: 'apex.proposed' })[0]!.detail!.governance).toMatchObject({
      frozen: true,
      rules: [FREEZE_RULE],
    });
  });

  it('page_view: a data change keeps operation, object and record id; an Apex script is fingerprinted', async () => {
    await call('dml_propose', { ...CASES[2]!.args(), justification: WHY });
    const dml = summaryOf(mintedRequest('dml').id);
    // The guard's own data (the before-values) stays beside the record, untouched.
    expect(dml.before).toBeDefined();
    expect(dml.governance).toBeDefined();
    expect(dml.page_view.changes).toEqual([{ label: `UPDATE Account ${ACCOUNT_ID}`, warnings: [] }]);
    expect(JSON.stringify(dml.page_view)).not.toContain('New Name');
    expect(JSON.stringify(dml.page_view)).not.toContain('Old Name');

    const script = "System.debug('invoice check');";
    await call('apex_propose', { code: script, justification: WHY });
    const apex = summaryOf(mintedRequest('apex').id);
    expect(apex.page_view.changes).toEqual([
      {
        label: `Execute anonymous Apex (1 line, ${script.length} chars)`,
        warnings: [],
        detail_sha256: crypto.createHash('sha256').update(script).digest('hex'),
        detail_chars: script.length,
      },
    ]);
    expect(JSON.stringify(apex)).not.toContain('invoice check');
  });

  it('a deploy whose live check succeeded keeps every key in one summary: the re-persist and the page view merge', async () => {
    liveRetrieve = true;
    const res = await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(bodyOf(res).live_check).toMatchObject({ status: 'ok' });
    const summary = summaryOf(mintedRequest('deploy').id);
    expect(Object.keys(summary).sort()).toEqual([
      'blast',
      'changes',
      'destructive',
      'governance',
      'live_check',
      'page_view',
      'revert_preimages',
    ]);
    expect(summary.governance).toMatchObject({ justification: { text: WHY, source: 'agent' } });
    expect(summary.revert_preimages).toMatchObject({ components: [{ api_name: 'Invoice_Service' }] });
    expect(summary.page_view.changes).toHaveLength(1);
    expect(JSON.stringify(summary.page_view)).not.toContain('/* live */');
  });

  it('the first render carries the read-only Change record card, above the warnings and the code', async () => {
    await call('apex_propose', { code: "System.debug('x');", justification: WHY, ticket: TICKET });
    const page = presentedPages.at(-1)!;
    expect(page).toContain('<div class="card" id="gov-record"><h2>Change record</h2>');
    expect(page).toContain(`<span class="k">Ticket</span><span class="v">${TICKET}</span>`);
    expect(page).toContain('<div class="gov-k">Justification (required by policy)</div>');
    expect(page).toContain(`<div class="gov-text">${esc(WHY)}</div>`);
    expect(page).toContain(
      '<div class="hint">Drafted by the agent. Edit it if it is not what you would say.</div>',
    );
    expect(page).toContain('Policies on this connection (from config.json):');
    expect(page).toContain(`<li>${esc(RULE_LINE)}</li>`);
    expect(page).not.toContain('<form');
    expect(page.indexOf('id="gov-record"')).toBeGreaterThan(page.indexOf('>Instance<'));
    expect(page.indexOf('id="gov-record"')).toBeLessThan(page.indexOf('<div class="warn">'));
    expect(page.indexOf('id="gov-record"')).toBeLessThan(page.indexOf('id="code-card"'));
    // The code card is Part D's, unchanged.
    expect(page).toContain('Contrail itself never gives the agent this page or the code');
  });

  it("the card names the built-in default as the source, and says when no rule applies", async () => {
    deploys.setPolicySource(() => ({ ok: true, policies: DEFAULT_POLICIES, source: 'default' }));
    await call('apex_propose', { code: "System.debug('x');" });
    const page = presentedPages.at(-1)!;
    expect(page).toContain(
      "Policies on this connection (Contrail's built-in default — config.json has no policies section):",
    );
    expect(page).toContain('<p class="note">No policy rule applies to this connection.</p>');
    expect(page).toContain('<span class="v">none given</span>');
    expect(page).toContain('<div class="hint">None given.</div>');
    expect(page).not.toContain('(required by policy)');
    expect(summaryOf(mintedRequest('apex').id).governance.policy).toMatchObject({
      source: 'default',
      rules: [],
      lines: [],
    });
  });

  it('a rule that matches no connection is named on the page, and stored nowhere', async () => {
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        { name: 'old client org', match: { orgIds: ['00D0000000000ZZ'] }, requireTicket: true },
      ],
    };
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(presentedPages.at(-1)!).toContain(
      `<p class="note">${esc(unmatchedRuleText('old client org'))}</p>`,
    );
    const request = mintedRequest('apex');
    expect(request.summaryJson).not.toContain('Not applied to any connection');
    expect(summaryOf(request.id).governance.policy.rules).toEqual([RULE]);
  });
});

// ── the Change record card (connect/pages.ts) ────────────────────────────

describe('the Change record card', () => {
  const CODE = 'ABCD-EFGH';
  const VIEW: ApprovalPageOptions = {
    kind: 'dml',
    code: CODE,
    expiresAt: '2026-11-17T15:00:00.000Z',
    org: {
      alias: 'acme-dev',
      orgName: 'Acme',
      orgType: 'developer',
      instanceUrl: 'https://acme.example.invalid',
    },
    changes: [{ label: `UPDATE Account ${ACCOUNT_ID}`, warnings: [] }],
    destructive: [],
    results: [],
    blast: [],
    warnings: ['A page-top warning.'],
  };

  function governance(over: Partial<ApprovalGovernance> = {}): ApprovalGovernance {
    return {
      gate: 'open',
      ticket: TICKET,
      justification: {
        text: WHY,
        provenance: justificationProvenance({ text: WHY, source: 'agent' }),
        required: true,
      },
      policySource: 'config',
      policyLines: [RULE_LINE],
      frozenAtMint: false,
      rev: 'open:::',
      limits: { justificationMax: 1000, reasonMin: 15, reasonMax: 1000 },
      ...over,
    };
  }

  function pageWith(over: Partial<ApprovalGovernance> = {}): string {
    return renderApprovalPage({ ...VIEW, governance: governance(over) });
  }

  it('is absent without governance, and sits between the org card and the warnings with it', () => {
    expect(renderApprovalPage(VIEW)).not.toContain('gov-record');
    const html = pageWith();
    const at = html.indexOf('<div class="card" id="gov-record"><h2>Change record</h2>');
    expect(at).toBeGreaterThan(html.indexOf('>Instance<'));
    expect(at).toBeLessThan(html.indexOf('<div class="warn">'));
    expect(at).toBeLessThan(html.indexOf('id="code-card"'));
  });

  it('escapes every agent- and config-written value', () => {
    const html = pageWith({
      ticket: '<img src=x onerror=alert(1)>',
      justification: {
        text: '<script>alert(1)</script>\nsecond line',
        provenance: '<b>provenance</b>',
        required: false,
      },
      policyLines: ['A ticket, when given, must match <i>[A-Z]+</i> (rule "x").'],
      unmatchedRules: ['<u>old</u>'],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>provenance</b>');
    expect(html).not.toContain('<i>[A-Z]+</i>');
    expect(html).not.toContain('<u>old</u>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain(
      '<div class="gov-text">&lt;script&gt;alert(1)&lt;/script&gt;\nsecond line</div>',
    );
    expect(html).toContain('<div class="hint">&lt;b&gt;provenance&lt;/b&gt;</div>');
    expect(html).toContain(
      '<li>A ticket, when given, must match &lt;i&gt;[A-Z]+&lt;/i&gt; (rule &quot;x&quot;).</li>',
    );
    expect(html).toContain(esc(unmatchedRuleText('<u>old</u>')));
  });

  it('with no session it is read-only: no form, no text field', () => {
    const html = pageWith();
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
    expect(html).toContain(`<div class="gov-text">${esc(WHY)}</div>`);
  });

  it('the ticket row reads "none given" without a ticket; "(required by policy)" only when required', () => {
    const none = pageWith({
      ticket: null,
      justification: { text: '', provenance: justificationProvenance(null), required: false },
    });
    expect(none).toContain('<span class="k">Ticket</span><span class="v">none given</span>');
    expect(none).toContain('<div class="gov-k">Justification</div>');
    expect(none).not.toContain('class="gov-text"');
    expect(none).toContain('<div class="hint">None given.</div>');
    expect(pageWith()).toContain('<div class="gov-k">Justification (required by policy)</div>');
  });

  it('the policy heading says where the rules come from, or that none applies', () => {
    expect(pageWith()).toContain(
      '<div class="gov-k">Policies on this connection (from config.json):</div>',
    );
    const builtIn = pageWith({ policySource: 'default', policyLines: [] });
    expect(builtIn).toContain(
      "<div class=\"gov-k\">Policies on this connection (Contrail's built-in default — config.json " +
        'has no policies section):</div>',
    );
    expect(builtIn).toContain('<p class="note">No policy rule applies to this connection.</p>');
    expect(builtIn).not.toContain('<ul class="gov-list">');
    expect(pageWith()).toContain(`<ul class="gov-list"><li>${esc(RULE_LINE)}</li></ul>`);
  });

  it('unreadable policies: no policy list at all — nothing is known about what applies', () => {
    const html = pageWith({ gate: 'blocked', blockedBy: 'unreadable', policyLines: [] });
    expect(html).not.toContain('Policies on this connection');
    expect(html).not.toContain('No policy rule applies');
    // The rest of the record still shows.
    expect(html).toContain(`<span class="v">${TICKET}</span>`);
  });

  it('shows the provenance hint as the engine composed it — the Cleared one included', () => {
    const at = '2026-11-17T14:03:00.000Z';
    const cleared = justificationProvenance({
      text: '',
      source: 'page',
      edited_at: at,
      surface: 'approval_page',
    });
    expect(cleared).toMatch(/^Cleared on the approval page at \d{2}:\d{2}\.$/);
    const html = pageWith({ justification: { text: '', provenance: cleared, required: false } });
    expect(html).toContain(`<div class="hint">${cleared}</div>`);
    expect(html).not.toContain('class="gov-text"');

    const typed = justificationProvenance({
      text: 'typed here',
      source: 'page',
      edited_at: at,
      surface: 'approval_page',
    });
    const typedPage = pageWith({
      justification: { text: 'typed here', provenance: typed, required: true },
    });
    expect(typedPage).toContain(`<div class="hint">${typed}</div>`);
  });

  it('the policies-changed sentence appears only when policyChangedAt is set', () => {
    expect(pageWith()).not.toContain('gov-changed');
    const at = '2026-11-17T09:30:00.000Z';
    const html = pageWith({ policyChangedAt: at });
    expect(html).toContain(`<p class="chg-warn" id="gov-changed">${esc(policyChangedText(at))}</p>`);
    // First in the card.
    expect(html.indexOf('id="gov-changed"')).toBeLessThan(html.indexOf('>Ticket<'));
  });

  it('one unmatched-rule line per entry, after the policy list', () => {
    const html = pageWith({ unmatchedRules: ['old client org', 'gone label'] });
    expect(html.split('Not applied to any connection on this machine').length - 1).toBe(2);
    for (const name of ['old client org', 'gone label']) {
      expect(html).toContain(`<p class="note">${esc(unmatchedRuleText(name))}</p>`);
      expect(html.indexOf(esc(unmatchedRuleText(name)))).toBeGreaterThan(
        html.indexOf('<ul class="gov-list">'),
      );
    }
    expect(pageWith()).not.toContain('Not applied to any connection');
  });

  it('with an open gate the code card is unchanged: the code and Part D\'s note', () => {
    const html = pageWith();
    const card = html.slice(html.indexOf('id="code-card"'), html.indexOf('id="dead"'));
    expect(card).toContain(`<div class="code" id="code">${CODE}</div>`);
    expect(card).toContain('Contrail itself never gives the agent this page or the code');
    expect(card).toContain('tell it you do not approve');
    // The Change record itself never carries the code.
    const record = html.slice(html.indexOf('id="gov-record"'), html.indexOf('<div class="warn">'));
    expect(record).not.toContain(CODE);
  });
});

// ── change freezes (P11) ─────────────────────────────────────────────────

const FREEZE_RULE = 'acme freeze';
const ALWAYS_WINDOW = {
  name: 'always',
  range: { from: '2000-01-01T00:00', to: '2999-01-01T00:00' },
  timeZone: 'UTC',
};
const FREEZE = { rule: FREEZE_RULE, window: 'always', until: '2999-01-01 00:00 UTC' };
/** The rev's last part while FREEZE is the named freeze. */
const FREEZE_REV_TAIL = `:${JSON.stringify([FREEZE_RULE, 'always'])}`;
const FROZEN_REV = `frozen:::${FREEZE_REV_TAIL}`;
const FREEZE_POLICIES: PolicyConfig = {
  rules: [
    ...ACME_RULE.rules,
    { name: FREEZE_RULE, match: { connections: ['acme-*'] }, freezeWindows: [ALWAYS_WINDOW] },
  ],
};
const TICKET_RULE = 'acme tickets';
const TICKET_POLICIES: PolicyConfig = {
  rules: [
    ...ACME_RULE.rules,
    { name: TICKET_RULE, match: { connections: ['acme-*'] }, requireTicket: true },
  ],
};
const TICKET_VIOLATION =
  `policy rule "${TICKET_RULE}" requires a ticket for every change to "acme-dev" — pass ticket ` +
  'with the reference the human gave you; if they gave none, ask them (never invent one)';
const FROZEN_AT_MINT_LEAD = 'No confirmation code is shown, and none was sent to your phone.';
const FROZEN_AFTER_LEAD =
  'No confirmation code is shown. This freeze began after the request was proposed, so its code ' +
  'may already have been shown on this page or sent to your phone; while the freeze lasts that ' +
  'code does not execute until an emergency reason is recorded here.';
const REASON = 'Checkout is down for every customer of the client.';

/** The live hooks and the /status probe of the newest presented page. */
function newestPage() {
  const p = presented.at(-1)!;
  return {
    render: (notice: Parameters<ApprovalLivePage['render']>[0]['notice'] = null) =>
      p.live!.render({ sessionId: 'test-session', notice }),
    status: () => p.statusCheck!(),
    live: p.live!,
  };
}

function codeElement(code: string): string {
  return `<div class="code" id="code">${code}</div>`;
}

function wrongCodeFor(code: string): string {
  return code === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH';
}

describe('a change freeze holds a request until the human records an emergency reason', () => {
  for (const c of CASES) {
    it(`${c.tool}: no code on the page or in the push, the code refused at execute until a reason is recorded — then it runs`, async () => {
      config.policies = FREEZE_POLICIES;
      notifier.method = 'pushover';
      const res = await call(c.tool, { ...c.args(), justification: WHY });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const request = newestRequest();
      expect(request.kind).toBe(c.kind);
      const code = request.confirmationCode;

      // The first render: the freeze card, and no code element at all.
      const first = presentedPages.at(-1)!;
      expect(first).not.toMatch(/class="code"/);
      expect(first).not.toContain(code);
      expect(first).toContain('<div class="card danger-card" id="gov-freeze"><h2>CHANGE FREEZE</h2>');
      expect(first).toContain(FROZEN_AT_MINT_LEAD);
      expect(first).not.toContain('This freeze began after the request was proposed');
      expect(first).toContain(
        'Hidden while the change freeze is in effect — record an emergency reason above to show it.',
      );
      expect(first).not.toContain('read this code back');

      // The push: told of the freeze, handed no code.
      expect(notifier.calls).toHaveLength(1);
      expect(notifier.calls[0]!.opts).toEqual({ includeCode: false, freeze: true });
      expect(notifier.calls[0]!.view.code).toBe('');
      const push = composePushover(notifier.calls[0]!.view, {
        ...notifier.calls[0]!.opts,
        summary: 'full',
      });
      expect(push.message.endsWith(FREEZE_TAIL)).toBe(true);
      expect(push.message).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
      expect(db.queryAuditEvents({ eventType: 'approval.notified' })[0]!.detail).toEqual({
        requestId: request.id,
        kind: c.kind,
        method: 'pushover',
        codeIncluded: false,
        freeze: true,
      });

      // The result: the freeze note, the code-free phone note, no code.
      expect(textOf(res)).toContain(freezeProposeNote('acme-dev', FREEZE, 'page'));
      expect(textOf(res)).toContain(
        "A code-free summary was pushed to the human's phone: a change freeze is in effect",
      );
      expect(textOf(res)).not.toContain(code);
      expect(textOf(res)).not.toContain('read the code back');

      // The real code (read from the row) does not execute: no org request,
      // no attempt counted, nothing voided.
      fetched = [];
      const refused = await call(c.execTool, { confirmation_code: code });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(freezeExecuteRefusalText('acme-dev', FREEZE, 'page'));
      expect(fetched).toEqual([]);
      expect(db.getDeployRequest(request.id)!.status).toBe('validated');
      const refusals = policyRefusals();
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.tool).toBe(c.execTool);
      expect(refusals[0]!.detail).toEqual({
        phase: 'execute',
        requestId: request.id,
        kind: c.kind,
        reason: 'freeze',
        rule: FREEZE_RULE,
        window: 'always',
      });

      // A wrong code meets the usual accounting — the first attempt counted.
      const bad = await call(c.execTool, { confirmation_code: wrongCodeFor(code) });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain(
        `${config.deploy.maxFailedAttempts - 1} attempt(s) remain before the pending code is locked.`,
      );
      const wrongRow = db.queryAuditEvents({ eventType: `${c.kind}.refused` })[0]!;
      expect(wrongRow.detail).toMatchObject({
        reason: 'no_matching_code',
        attempts_remaining: config.deploy.maxFailedAttempts - 1,
        requestId: request.id,
      });
      expect(JSON.stringify(wrongRow)).not.toContain(code);

      // The human records an emergency reason on the page.
      const page = newestPage();
      const frozenRev = page.status().rev;
      expect(frozenRev).toBe(FROZEN_REV);
      expect(page.live.recordFreezeOverride('x'.repeat(14))).toBe('override_too_short');
      expect(page.live.recordFreezeOverride(REASON)).toBe('override_recorded');
      const overrides = db.queryAuditEvents({ eventType: 'policy.freeze_overridden' });
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.detail).toMatchObject({ requestId: request.id, reason: REASON });
      expect(page.status().rev).not.toBe(frozenRev);
      expect(page.status().rev).toMatch(/^overridden::\d{4}-/);
      const released = page.render('override_recorded');
      expect(released).toContain(codeElement(code));
      expect(released).toContain('<h2>CHANGE FREEZE — OVERRIDDEN FOR THIS REQUEST</h2>');
      expect(released).toContain('Contrail itself never gives the agent this page or the code');

      // The same code now executes, and the claim recorded the check.
      const executed = await executeCode(c.execTool, code);
      expect(executed.isError ?? false, textOf(executed)).toBe(false);
      expect(db.getDeployRequest(request.id)!.status).toBe('executed');
      expect(summaryOf(request.id).governance.execute_check).toEqual({
        at: expect.stringMatching(ISO_RE),
        rules: [RULE, FREEZE_RULE],
        freeze_active: true,
        overridden: true,
        org_id: ORG_ID,
        username: 'admin@acme.example.invalid',
      });
    });
  }

  it('a freeze that begins after the mint: the page drops the code within one poll, execute refuses, a reason releases it', async () => {
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const request = newestRequest();
    const code = request.confirmationCode;
    const page = newestPage();
    expect(page.render()).toContain(codeElement(code));
    expect(page.status()).toEqual({ active: true, status: 'validated', rev: 'open:::' });

    config.policies = FREEZE_POLICIES;
    const rev = page.status().rev!;
    expect(rev).not.toBe('open:::');
    expect(rev.startsWith('frozen:::')).toBe(true);
    const frozen = page.render();
    expect(frozen).not.toContain(code);
    expect(frozen).not.toContain('id="code"');
    expect(frozen).toContain(FROZEN_AFTER_LEAD);
    expect(frozen).not.toContain('none was sent to your phone');
    expect(frozen).toContain(`var REV = ${JSON.stringify(rev)};`);

    fetched = [];
    const refused = await call('apex_execute', { confirmation_code: code });
    expect(textOf(refused)).toBe(freezeExecuteRefusalText('acme-dev', FREEZE, 'page'));
    expect(fetched).toEqual([]);
    expect(db.getDeployRequest(request.id)!.status).toBe('validated');

    expect(page.live.recordFreezeOverride(REASON)).toBe('override_recorded');
    const executed = await call('apex_execute', { confirmation_code: code });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(summaryOf(request.id).governance.execute_check).toMatchObject({
      freeze_active: true,
      overridden: true,
    });
  });

  it('a freeze that ends shows the code again with no override, and the code executes', async () => {
    config.policies = FREEZE_POLICIES;
    await call('dml_propose', { ...CASES[2]!.args(), justification: WHY });
    const request = newestRequest();
    const code = request.confirmationCode;
    const page = newestPage();
    expect(page.render()).not.toContain(code);

    config.policies = ACME_RULE;
    const open = page.render();
    expect(open).toContain(codeElement(code));
    expect(open).not.toContain('id="gov-freeze"');
    expect(page.status().rev).toMatch(/^open:::\d{4}-/);
    const executed = await call('dml_execute', { confirmation_code: code });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(summaryOf(request.id).governance.execute_check).toMatchObject({
      rules: [RULE],
      freeze_active: false,
      overridden: false,
    });
    expect(db.queryAuditEvents({ eventType: 'policy.freeze_overridden' })).toHaveLength(0);
  });

  it('a render and the /status poll agree on rev after disconnect_org, so the page does not reload on every poll', async () => {
    config.policies = FREEZE_POLICIES;
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    const page = newestPage();
    expect(page.render()).toContain(`var REV = ${JSON.stringify(FROZEN_REV)};`);
    expect(page.status()).toEqual({ active: true, status: 'validated', rev: FROZEN_REV });

    // The connection row goes; the pending request's row stays.
    const removed = await call('disconnect_org', {});
    expect(removed.isError ?? false, textOf(removed)).toBe(false);
    expect(db.resolveConnection('acme-dev')).toBeNull();
    expect(db.getDeployRequest(request.id)!.status).toBe('validated');
    const after = page.render();
    expect(after).toContain(`var REV = ${JSON.stringify(FROZEN_REV)};`);
    expect(after).not.toContain(request.confirmationCode);
    expect(page.status()).toEqual({ active: true, status: 'validated', rev: FROZEN_REV });
  });

  it('when a longer window begins inside the named one, the rev changes, so an open page reloads and names it', async () => {
    // The Getting Started example's windows, on this connection. 2026-12-19
    // is a Saturday: the year-end close begins at 17:00 in Toronto, inside
    // the weekend, and lasts longer.
    const RULE_NAME = 'acme production';
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        {
          name: RULE_NAME,
          match: { connections: ['acme-*'] },
          freezeWindows: [
            { name: 'weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'America/Toronto' },
            {
              name: 'year-end close',
              range: { from: '2026-12-19T17:00', to: '2027-01-04T08:00' },
              timeZone: 'America/Toronto',
            },
          ],
        },
      ],
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 11, 19, 21, 45)); // Sat 16:45 in Toronto
      const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const weekend = { rule: RULE_NAME, window: 'weekend', until: 'mon 08:00 America/Toronto' };
      expect(textOf(res)).toContain(freezeProposeNote('acme-dev', weekend, 'page'));
      const page = newestPage();
      const before = page.status().rev!;
      expect(before).toBe(`frozen::::${JSON.stringify([RULE_NAME, 'weekend'])}`);
      expect(presentedPages.at(-1)!).toContain(`var REV = ${JSON.stringify(before)};`);
      expect(page.render()).toContain(esc(freezeBannerText('acme-dev', weekend)));

      vi.setSystemTime(Date.UTC(2026, 11, 19, 22, 15)); // Sat 17:15 in Toronto
      const after = page.status().rev!;
      expect(after).toBe(`frozen::::${JSON.stringify([RULE_NAME, 'year-end close'])}`);
      const html = page.render();
      expect(html).toContain(`var REV = ${JSON.stringify(after)};`);
      expect(html).toContain(
        esc(
          freezeBannerText('acme-dev', {
            rule: RULE_NAME,
            window: 'year-end close',
            until: '2027-01-04 08:00 America/Toronto',
          }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('execute_deploy: a freeze that begins during the target guard is refused at the claim; after a reason the next call executes, not the stale refusal', async () => {
    // The DeployResult's org clock gives the guard an org read to make.
    orgClock = true;
    const res = await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const request = newestRequest();
    const code = request.confirmationCode;
    const page = newestPage();

    // The guard's org read is held, so the call outlives its soft wait.
    let release!: () => void;
    listHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    listCalls = 0;
    config.deploy.toolWaitMs = 30;
    const first = await call('execute_deploy', { confirmation_code: code });
    expect(first.isError ?? false, textOf(first)).toBe(false);
    expect(textOf(first)).toContain('Deploy is still running');
    expect(bodyOf(first).progress).toBe('re-checking the target org before claiming the code');
    for (let i = 0; i < 200 && listCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBeGreaterThan(0);

    // A freeze begins during the guard's read; the claim refuses it.
    config.policies = FREEZE_POLICIES;
    listHold = null;
    release();
    for (let i = 0; i < 200 && policyRefusals().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(policyRefusals()).toHaveLength(1);
    expect(policyRefusals()[0]!.detail).toMatchObject({
      phase: 'execute',
      requestId: request.id,
      reason: 'freeze',
    });
    expect(db.getDeployRequest(request.id)!.status).toBe('validated');
    expect(realDeploys).toBe(0);

    // The human records an emergency reason on the page.
    expect(page.live.recordFreezeOverride(REASON)).toBe('override_recorded');

    // The next call executes: never the CHANGE FREEZE refusal the claim made.
    config.deploy.toolWaitMs = 10_000;
    const next = await executeCode('execute_deploy', code);
    expect(next.isError ?? false, textOf(next)).toBe(false);
    expect(textOf(next)).not.toContain('CHANGE FREEZE');
    expect(bodyOf(next)).toMatchObject({ deployed: true });
    expect(db.getDeployRequest(request.id)!.status).toBe('executed');
    expect(realDeploys).toBe(1);
    expect(summaryOf(request.id).governance.execute_check).toMatchObject({
      freeze_active: true,
      overridden: true,
    });
  });

  it('execute_deploy: a claim refused for a freeze, then a newer validation — the old code is reported superseded, never the stale CHANGE FREEZE refusal', async () => {
    orgClock = true;
    const res = await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const request = newestRequest();
    const code = request.confirmationCode;

    // The guard's org read is held, so the call outlives its soft wait.
    let release!: () => void;
    listHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    listCalls = 0;
    config.deploy.toolWaitMs = 30;
    const first = await call('execute_deploy', { confirmation_code: code });
    expect(textOf(first)).toContain('Deploy is still running');
    for (let i = 0; i < 200 && listCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBeGreaterThan(0);

    // A freeze begins during the guard's read; the claim refuses it, and the
    // refusal sits uncollected in the job.
    config.policies = FREEZE_POLICIES;
    listHold = null;
    release();
    for (let i = 0; i < 200 && policyRefusals().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(policyRefusals()).toHaveLength(1);
    expect(db.getDeployRequest(request.id)!.status).toBe('validated');

    // A newer validation replaces the request.
    config.deploy.toolWaitMs = 10_000;
    const again = await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY });
    expect(again.isError ?? false, textOf(again)).toBe(false);
    expect(db.getDeployRequest(request.id)!.status).toBe('superseded');

    // The old code: claimCode's superseded refusal, never the freeze text.
    const stale = await call('execute_deploy', { confirmation_code: code });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).not.toContain('CHANGE FREEZE');
    expect(textOf(stale)).toContain(
      'That confirmation code is superseded — a newer validation replaced it. Validate again for a fresh one.',
    );
    expect(realDeploys).toBe(0);
    expect(db.queryAuditEvents({ eventType: 'deploy.refused' }).map((e) => e.detail)).toContainEqual(
      expect.objectContaining({ reason: 'superseded', requestId: request.id }),
    );
  });
});

describe('one freeze evaluation per mint', () => {
  it('a freeze that begins while a deploy validates: the record, the result, the push and the first render all say frozen, from one read', async () => {
    notifier.method = 'pushover';
    config.deploy.toolWaitMs = 60;
    holdValidation = true;
    let loads = 0;
    deploys.setPolicySource(() => {
      loads += 1;
      // The pre-job check reads no freeze; the mint's check reads one; any
      // later read would read none again — so a second read at mint shows.
      return { ok: true, policies: loads === 2 ? FREEZE_POLICIES : ACME_RULE, source: 'config' };
    });
    const started = await call('validate_deploy', { ...CASES[0]!.args(), justification: WHY });
    expect(textOf(started)).toContain('Validation is still running');
    expect(loads).toBe(1);
    const jobId = String(bodyOf(started).job_id);
    holdValidation = false;
    config.deploy.toolWaitMs = 10_000;
    const finished = await call('validate_deploy', { job_id: jobId });
    expect(finished.isError ?? false, textOf(finished)).toBe(false);
    expect(loads).toBe(2);

    const request = newestRequest();
    expect(summaryOf(request.id).governance.freeze).toEqual({ ...FREEZE, time_zone: 'UTC' });
    const note = freezeProposeNote('acme-dev', FREEZE, 'page');
    expect(textOf(finished)).toContain(`Validation passed. TARGET: acme-dev (developer). ${note}`);
    expect(bodyOf(finished).governance).toMatchObject({ freeze: { active: true, ...FREEZE, note } });
    const first = presentedPages.at(-1)!;
    expect(first).not.toMatch(/class="code"/);
    expect(first).toContain(FROZEN_AT_MINT_LEAD);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.opts).toMatchObject({ includeCode: false, freeze: true });
    expect(notifier.calls[0]!.view.code).toBe('');
    expect(db.queryAuditEvents({ eventType: 'deploy.validated' })[0]!.detail!.governance).toMatchObject({
      frozen: true,
    });
    expect(textOf(finished)).not.toContain(request.confirmationCode);
  });

  it('a frozen deactivate_flow collected through validate_deploy {job_id} closes with the freeze note', async () => {
    config.policies = FREEZE_POLICIES;
    config.deploy.toolWaitMs = 60;
    holdValidation = true;
    const started = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    const jobId = /Still validating \(job ([^)]+)\)/.exec(textOf(started))![1]!;
    holdValidation = false;
    config.deploy.toolWaitMs = 10_000;
    const collected = await call('validate_deploy', { job_id: jobId });
    expect(collected.isError ?? false, textOf(collected)).toBe(false);
    expect(textOf(collected)).toContain(freezeProposeNote('acme-dev', FREEZE, 'page'));
    expect(textOf(collected)).not.toContain('Contrail gives the confirmation code only to the human');
    expect(presentedPages.at(-1)!).not.toMatch(/class="code"/);
  });

  it('a label rule\'s freeze holds a second connection to the same org, whatever its label', async () => {
    config.policies = FREEZE_POLICIES;
    addConnection('client-second-label', 'developer', ORG_ID.slice(0, 15));
    const res = await call(
      'apex_propose',
      { code: "System.debug('x');", justification: WHY },
      'client-second-label',
    );
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(textOf(res)).toContain(freezeProposeNote('client-second-label', FREEZE, 'page'));
    const request = newestRequest('client-second-label');
    expect(presentedPages.at(-1)!).not.toContain(request.confirmationCode);
    const refused = await call(
      'apex_execute',
      { confirmation_code: request.confirmationCode },
      'client-second-label',
    );
    expect(textOf(refused)).toBe(freezeExecuteRefusalText('client-second-label', FREEZE, 'page'));
  });

  it('a rule that matches no connection is named on the page but never pushed', async () => {
    notifier.method = 'pushover';
    config.policies = {
      rules: [
        ...ACME_RULE.rules,
        { name: 'old client org', match: { orgIds: ['00D0000000000ZZ'] }, requireTicket: true },
      ],
    };
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(newestPage().render()).toContain(esc(unmatchedRuleText('old client org')));
    const { view, opts } = notifier.calls[0]!;
    const push = composePushover(view, { ...opts, summary: 'full' }).message;
    expect(push).not.toContain('Not applied to any connection');
    expect(push).not.toContain('old client org');
  });
});

// ── policies re-checked at execute (P11) ─────────────────────────────────

describe('every rule is checked again when a change executes', () => {
  for (const c of CASES) {
    it(`${c.tool}: a rule added after the mint blocks the page and the execute; the code is not spent`, async () => {
      await call(c.tool, { ...c.args(), justification: WHY });
      const request = newestRequest();
      const code = request.confirmationCode;
      const page = newestPage();

      config.policies = TICKET_POLICIES;
      const blocked = page.render();
      expect(blocked).toContain('<div class="card danger-card" id="gov-block"><h2>BLOCKED BY POLICY</h2>');
      expect(blocked).toContain(`<div class="chg-warn">${esc(TICKET_VIOLATION)}</div>`);
      expect(blocked).toContain(
        "No confirmation code is shown: this request does not satisfy this connection's policies " +
          'as they stand now — the lines above say what is missing.',
      );
      expect(blocked).not.toContain('id="code"');
      expect(blocked).toContain('Not shown — see "Blocked by policy" above.');
      expect(page.status().rev).toMatch(/^blocked:::/);

      fetched = [];
      const refused = await call(c.execTool, { confirmation_code: code });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(
        policyRefusalText('acme-dev', 'developer', [{ text: TICKET_VIOLATION }], 'execute', 'config'),
      );
      expect(textOf(refused)).toContain('POLICY REFUSAL — not executed. The code was not used up');
      expect(fetched).toEqual([]);
      expect(db.getDeployRequest(request.id)!.status).toBe('validated');
      expect(policyRefusals()[0]!.detail).toEqual({
        phase: 'execute',
        requestId: request.id,
        kind: c.kind,
        reason: 'violations',
        rules: [TICKET_RULE],
        violations: ['ticket_required'],
        ticket_given: false,
        justification_given: true,
      });

      // Once nothing blocks it, the same code runs.
      config.policies = ACME_RULE;
      const executed = await executeCode(c.execTool, code);
      expect(executed.isError ?? false, textOf(executed)).toBe(false);
      expect(db.getDeployRequest(request.id)!.status).toBe('executed');
    });
  }

  it('policies that cannot be read refuse the execute with the execute-phase text; the same code works once fixed', async () => {
    await call('dml_propose', { ...CASES[2]!.args(), justification: WHY });
    const request = newestRequest();
    const problem = 'config.json is not valid JSON (Unexpected token)';
    deploys.setPolicySource(() => ({ ok: false, problem }));
    const page = newestPage();
    const blocked = page.render();
    expect(blocked).toContain('<h2>BLOCKED BY POLICY</h2>');
    expect(blocked).toContain(`<div class="chg-warn">${esc(problem)}</div>`);
    expect(blocked).toContain(
      'No confirmation code is shown: Contrail could not read the policies in config.json — the ' +
        'line above says why. Once the file is fixed, this page updates by itself within a few seconds.',
    );
    expect(blocked).not.toContain('No policy rule applies');

    fetched = [];
    const refused = await call('dml_execute', { confirmation_code: request.confirmationCode });
    expect(textOf(refused)).toBe(policyUnreadableText(problem, 'execute'));
    expect(fetched).toEqual([]);
    expect(policyRefusals()[0]!.detail).toEqual({
      phase: 'execute',
      requestId: request.id,
      kind: 'dml',
      reason: 'config_unreadable',
    });
    deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    const executed = await call('dml_execute', { confirmation_code: request.confirmationCode });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
  });

  it('a request minted before 0.40 is checked from its row: on production it lacks a justification, and the text says nothing changed', async () => {
    const prodId = addConnection('acme-prod', 'production', '00D000000000002AAA');
    deploys.setPolicySource(() => ({ ok: true, policies: DEFAULT_POLICIES, source: 'default' }));
    const old = db.insertDeployRequest({
      connectionId: prodId,
      kind: 'apex',
      confirmationCode: 'ABCD-2345',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      payloadJson: JSON.stringify({ apex: true, code: "System.debug('old');" }),
      summaryJson: JSON.stringify({ lines: 1 }),
    });
    fetched = [];
    const refused = await call('apex_execute', { confirmation_code: 'ABCD-2345' }, 'acme-prod');
    expect(refused.isError).toBe(true);
    const text = textOf(refused);
    expect(text).toBe(
      policyRefusalText(
        'acme-prod',
        'production',
        [{ text: JUSTIFICATION_VIOLATION('default: production needs a justification', 'acme-prod') }],
        'execute',
        'default',
      ),
    );
    expect(text).toContain("This is Contrail's built-in default rule");
    expect(text).not.toMatch(/changed/);
    expect(fetched).toEqual([]);
    expect(db.getDeployRequest(old.id)!.status).toBe('validated');
    expect(policyRefusals()[0]!.detail).toMatchObject({
      phase: 'execute',
      requestId: old.id,
      reason: 'violations',
      ticket_given: false,
      justification_given: false,
    });
  });
});

describe('a freeze that begins during the target guard\'s org read is refused at the claim', () => {
  // The three kinds whose execute checks the policies at the peek, before the
  // guard reads the org, and again in claimCode after it (integration §2.4 B3).
  const PEEK_TOOLS = ['validate_deploy', 'dml_propose', 'agent_activation_propose'];
  for (const c of CASES.filter((k) => PEEK_TOOLS.includes(k.tool))) {
    it(`${c.tool}: the bare freeze text, no write, no attempt counted, nothing voided — and the code runs once the freeze ends`, async () => {
      const res = await call(c.tool, { ...c.args(), justification: WHY });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const request = newestRequest();
      expect(request.kind).toBe(c.kind);
      const code = request.confirmationCode;

      let loads = 0;
      deploys.setPolicySource(() => {
        loads += 1;
        // The peek's check reads no freeze; the claim's check, after the org read, reads one.
        return { ok: true, policies: loads === 1 ? ACME_RULE : FREEZE_POLICIES, source: 'config' };
      });
      fetched = [];
      realDeploys = 0;
      const refused = await call(c.execTool, { confirmation_code: code });
      expect(loads).toBe(2);
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(freezeExecuteRefusalText('acme-dev', FREEZE, 'page'));

      // Whatever the guard read, nothing was written to the org.
      expect(fetched.filter((u) => u.includes('/composite/sobjects') || /\/activation$/.test(u))).toEqual([]);
      expect(realDeploys).toBe(0);

      // Still pending, unrecorded and unvoided: one policy.refused row, no claim refusal.
      expect(db.getDeployRequest(request.id)!.status).toBe('validated');
      expect(summaryOf(request.id).governance.execute_check).toBeNull();
      const refusals = policyRefusals();
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.tool).toBe(c.execTool);
      expect(refusals[0]!.detail).toEqual({
        phase: 'execute',
        requestId: request.id,
        kind: c.kind,
        reason: 'freeze',
        rule: FREEZE_RULE,
        window: 'always',
      });
      expect(db.queryAuditEvents({ eventType: `${c.kind}.refused` })).toHaveLength(0);

      // No attempt was counted: a wrong code now is the first.
      const bad = await call(c.execTool, { confirmation_code: wrongCodeFor(code) });
      expect(bad.isError).toBe(true);
      expect(db.queryAuditEvents({ eventType: `${c.kind}.refused` })[0]!.detail).toMatchObject({
        reason: 'no_matching_code',
        attempts_remaining: config.deploy.maxFailedAttempts - 1,
        requestId: request.id,
      });

      deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
      const executed = await executeCode(c.execTool, code);
      expect(executed.isError ?? false, textOf(executed)).toBe(false);
      expect(db.getDeployRequest(request.id)!.status).toBe('executed');
      expect(summaryOf(request.id).governance.execute_check).toMatchObject({ freeze_active: false });
    });
  }
});

describe('the execute record', () => {
  for (const c of CASES) {
    it(`${c.tool}: an executed request carries governance.execute_check, beside the rest of its record`, async () => {
      await call(c.tool, { ...c.args(), justification: WHY });
      const request = newestRequest();
      expect(summaryOf(request.id).governance.execute_check).toBeNull();
      const executed = await executeCode(c.execTool, request.confirmationCode);
      expect(executed.isError ?? false, textOf(executed)).toBe(false);
      const summary = summaryOf(request.id);
      expect(summary.governance.execute_check).toEqual({
        at: expect.stringMatching(ISO_RE),
        rules: [RULE],
        freeze_active: false,
        overridden: false,
        org_id: ORG_ID,
        username: 'admin@acme.example.invalid',
      });
      // The claim merged into the record: nothing else in it was lost.
      expect(summary.governance.justification).toEqual({ text: WHY, source: 'agent' });
      expect(summary.page_view).toMatchObject({ kind: c.kind });
      expect(JSON.stringify(summary)).not.toContain(request.confirmationCode);
    });
  }

  it('records the connection as it is at the claim — a re-authorisation after the mint shows', async () => {
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    const conn = db.resolveConnection('acme-dev')!;
    db.updateConnectionAuth(conn.id, {
      instanceUrl: conn.instanceUrl,
      loginUrl: conn.loginUrl,
      orgId: ORG_ID,
      orgName: 'Acme',
      orgType: 'developer',
      isSandbox: false,
      username: 'deputy@acme.example.invalid',
      userId: '005000000000002AAA',
      grants: conn.grants,
    });
    await call('apex_execute', { confirmation_code: request.confirmationCode });
    const g = summaryOf(request.id).governance;
    expect(g.target.username).toBe('admin@acme.example.invalid');
    expect(g.execute_check.username).toBe('deputy@acme.example.invalid');
  });

  it('when the record cannot be written the claim is not attempted: running, and the code still works', async () => {
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    const spy = vi.spyOn(db, 'patchDeployRequestSummary').mockReturnValueOnce(false);
    const res = await call('apex_execute', { confirmation_code: request.confirmationCode });
    spy.mockRestore();
    expect(textOf(res)).toContain('already being executed by a concurrent call');
    expect(db.getDeployRequest(request.id)!.status).toBe('validated');
    expect(summaryOf(request.id).governance.execute_check).toBeNull();
    expect(fetched.some((u) => u.includes('executeAnonymous'))).toBe(false);
    const executed = await call('apex_execute', { confirmation_code: request.confirmationCode });
    expect(executed.isError ?? false, textOf(executed)).toBe(false);
    expect(db.getDeployRequest(request.id)!.status).toBe('executed');
  });

  it('a wrong code names the request it was counted against — never a code — and none when nothing is pending', async () => {
    const none = await call('apex_execute', { confirmation_code: 'ABCD-EFGH' });
    expect(none.isError).toBe(true);
    const first = db.queryAuditEvents({ eventType: 'apex.refused' })[0]!;
    expect(first.detail).toEqual({
      reason: 'no_matching_code',
      attempts_remaining: null,
      locked: false,
    });

    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    await call('apex_execute', { confirmation_code: wrongCodeFor(request.confirmationCode) });
    const counted = db.queryAuditEvents({ eventType: 'apex.refused' })[0]!;
    expect(counted.detail).toEqual({
      reason: 'no_matching_code',
      attempts_remaining: config.deploy.maxFailedAttempts - 1,
      locked: false,
      requestId: request.id,
    });
    expect(JSON.stringify(counted)).not.toContain(request.confirmationCode);
  });
});

// ── the policies-changed cue (P11) ───────────────────────────────────────

describe('the policies-changed cue', () => {
  it('the first policies seen are no change; a change is cued on the page, in rev and in the next push, for 24 hours', async () => {
    notifier.method = 'pushover';
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(notifier.calls[0]!.opts).toEqual({ includeCode: true });
    const page = newestPage();
    expect(page.render()).not.toContain('gov-changed');
    expect(page.status().rev).toBe('open:::');
    expect(deploys.policyChangeNotice(Date.now())).toBeNull();

    // The human edits the policies (a rule that does not touch this org).
    config.policies = {
      rules: [...ACME_RULE.rules, { name: 'prod tickets', match: { orgTypes: ['production'] }, requireTicket: true }],
    };
    const rev = page.status().rev!;
    const notice = deploys.policyChangeNotice(Date.now())!;
    expect(notice.at).toMatch(ISO_RE);
    expect(rev).toBe(`open:::${notice.at}`);
    const changed = page.render();
    expect(changed).toContain(`<p class="chg-warn" id="gov-changed">${esc(policyChangedText(notice.at))}</p>`);
    expect(changed).toContain(codeElement(newestRequest().confirmationCode));

    // The next proposal: its first render and its push carry the cue.
    await call('apex_propose', { code: "System.debug('y');", justification: WHY });
    expect(presentedPages.at(-1)!).toContain('id="gov-changed"');
    const last = notifier.calls.at(-1)!;
    expect(last.opts).toEqual({ includeCode: true, policyChangedAt: notice.at });
    const lines = composePushover(last.view, { ...last.opts, summary: 'full' }).message.split('\n');
    expect(lines[1]).toMatch(
      /^Contrail noticed a policies change in config\.json at \d{2}:\d{2} — read the approval page or Deploy Review before approving\.$/,
    );

    // 24 hours after the change the cue is gone.
    const at = Date.parse(notice.at);
    expect(deploys.policyChangeNotice(at + 24 * 60 * 60_000 - 1000)).toEqual(notice);
    expect(deploys.policyChangeNotice(at + 24 * 60 * 60_000)).toBeNull();
  });

  it('a request minted inside the 24-hour window renders the rev /status returns, so the first poll does not reload', async () => {
    const PROD_TICKETS = { name: 'prod tickets', match: { orgTypes: ['production' as const] }, requireTicket: true };
    await client.callTool({ name: 'list_connections', arguments: {} });
    config.policies = { rules: [...ACME_RULE.rules, PROD_TICKETS] };
    await client.callTool({ name: 'list_connections', arguments: {} });
    const notice = deploys.policyChangeNotice(Date.now())!;
    expect(notice.at).toMatch(ISO_RE);

    // apex_propose mints at once; validate_deploy when its validation finishes.
    for (const c of [CASES[3]!, CASES[0]!]) {
      const res = await call(c.tool, { ...c.args(), justification: WHY });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const first = presentedPages.at(-1)!;
      const rev = newestPage().status().rev!;
      expect(rev).toBe(`open:::${notice.at}`);
      expect(first).toContain(`var REV = ${JSON.stringify(rev)};`);
      expect(first).toContain('id="gov-changed"');
    }

    // Frozen at mint, inside the window of a later change: the same.
    config.policies = { rules: [...FREEZE_POLICIES.rules, PROD_TICKETS] };
    await call('apex_propose', { code: "System.debug('z');", justification: WHY });
    const later = deploys.policyChangeNotice(Date.now())!;
    const rev = newestPage().status().rev!;
    expect(rev).toBe(`frozen:::${later.at}${FREEZE_REV_TAIL}`);
    expect(presentedPages.at(-1)!).toContain(`var REV = ${JSON.stringify(rev)};`);
  });

  it('an unreadable interlude that ends with the same policies is no change', async () => {
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const page = newestPage();
    deploys.setPolicySource(() => ({ ok: false, problem: 'config.json is not a JSON object' }));
    expect(page.status().rev).toBe('blocked:::');
    expect(page.render()).not.toContain('gov-changed');
    expect(deploys.policyChangeNotice(Date.now())).toBeNull();
    deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    expect(page.status().rev).toBe('open:::');
    expect(page.render()).not.toContain('gov-changed');
    expect(deploys.policyChangeNotice(Date.now())).toBeNull();
  });

  it('a frozen request whose window is removed shows its code and the cue', async () => {
    config.policies = FREEZE_POLICIES;
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    const page = newestPage();
    expect(page.render()).not.toContain('gov-changed');
    config.policies = ACME_RULE;
    const html = page.render();
    expect(html).toContain(codeElement(request.confirmationCode));
    expect(html).toContain('id="gov-changed"');
    expect(html).toContain('If you did not edit that file, do not approve this request.');
  });

  it('a second engine on the same database adopts the recorded change and cues it too, writing nothing', async () => {
    const seen = () => db.queryAuditEvents({ eventType: 'policy.config_seen' });
    const other = createDeps({
      db,
      tokens,
      config,
      store: new SnapshotStore(path.join(tmp, 'snapshots')),
    });
    other.deploys.setPolicySource(() => ({ ok: true, policies: ACME_RULE, source: 'config' }));
    await client.callTool({ name: 'list_connections', arguments: {} });
    other.deploys.policiesStatus();
    expect(seen()).toHaveLength(1);

    config.policies = TICKET_POLICIES;
    await client.callTool({ name: 'list_connections', arguments: {} });
    expect(seen()).toHaveLength(2);
    const row = seen()[0]!;
    expect(row.detail).toMatchObject({ changed: true });

    other.deploys.setPolicySource(() => ({ ok: true, policies: TICKET_POLICIES, source: 'config' }));
    other.deploys.policiesStatus();
    expect(seen()).toHaveLength(2);
    expect(other.deploys.policyChangeNotice(Date.now())).toEqual({ at: row.ts });
  });
});

// ── the freeze texts, one case per path (P11) ────────────────────────────

describe('the freeze texts, one per path', () => {
  it('a frozen request whose page could not be opened: the note asks for no code, and nothing says the page is open', async () => {
    browserFails = true;
    config.policies = FREEZE_POLICIES;
    const res = await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const body = bodyOf(res);
    expect(body.approval_page).toEqual({
      opened: false,
      note: freezePageNotOpenedText(),
      phone_notification: { status: 'off' },
    });
    const text = textOf(res);
    expect(text).not.toContain('read the code back');
    expect(text).not.toContain('read this code back');
    expect(text).not.toMatch(/page is open|is open on/);

    // Without a freeze the note is unchanged.
    config.policies = ACME_RULE;
    const open = await call('apex_propose', { code: "System.debug('y');", justification: WHY });
    expect((bodyOf(open).approval_page as { note: string }).note).toContain(
      'Ask the human to open the Contrail log, visit the page, and read the code back.',
    );
  });

  it('deactivate_flow points at execute_deploy after the approval instructions only — a frozen result ends with the freeze note', async () => {
    const leadOf = (res: Awaited<ReturnType<typeof call>>) => {
      const text = textOf(res);
      return text.slice(0, text.indexOf('\n{'));
    };
    const LEAD = 'Deactivation of flow "Invoice_Reminder" validated. TARGET: acme-dev (developer). ';
    config.policies = FREEZE_POLICIES;
    const frozen = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(frozen.isError ?? false, textOf(frozen)).toBe(false);
    expect(leadOf(frozen)).toBe(`${LEAD}${freezeProposeNote('acme-dev', FREEZE, 'page')}`);
    expect(textOf(frozen)).not.toContain('Execute it with execute_deploy');

    config.policies = ACME_RULE;
    const open = await call('deactivate_flow', { flow: 'Invoice_Reminder', justification: WHY });
    expect(open.isError ?? false, textOf(open)).toBe(false);
    const lead = leadOf(open);
    expect(lead.startsWith(`${LEAD}Contrail gives the confirmation code only to the human`)).toBe(true);
    expect(lead.endsWith('needs no remark.) Execute it with execute_deploy.')).toBe(true);
  });

  it('an emergency reason is answered by the gate: overridden → already recorded, blocked → blocked, open → not needed', async () => {
    config.policies = FREEZE_POLICIES;
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const overridden = newestPage();
    expect(overridden.live.recordFreezeOverride(REASON)).toBe('override_recorded');
    expect(overridden.live.recordFreezeOverride(REASON)).toBe('override_already_recorded');

    config.policies = { rules: [...FREEZE_POLICIES.rules, TICKET_POLICIES.rules[1]!] };
    await call('apex_propose', { code: "System.debug('y');", justification: WHY, ticket: TICKET });
    const blockedPage = newestPage();
    config.policies = {
      rules: [...FREEZE_POLICIES.rules, { ...TICKET_POLICIES.rules[1]!, ticketPattern: 'ABC-[0-9]+' }],
    };
    expect(blockedPage.live.recordFreezeOverride(REASON)).toBe('override_blocked');

    config.policies = ACME_RULE;
    await call('apex_propose', { code: "System.debug('z');", justification: WHY });
    expect(newestPage().live.recordFreezeOverride(REASON)).toBe('override_not_needed');
    expect(db.queryAuditEvents({ eventType: 'policy.freeze_overridden' })).toHaveLength(1);
  });

  it('"shown below" is not rendered once the request is blocked or executed', async () => {
    config.policies = FREEZE_POLICIES;
    await call('apex_propose', { code: "System.debug('x');", justification: WHY });
    const request = newestRequest();
    const page = newestPage();
    expect(page.live.recordFreezeOverride(REASON)).toBe('override_recorded');
    const shownBelow = 'The confirmation code is shown below';
    expect(page.render('override_recorded')).toContain(shownBelow);

    config.policies = { rules: [...FREEZE_POLICIES.rules, TICKET_POLICIES.rules[1]!] };
    const blocked = page.render('override_recorded');
    expect(blocked).toContain('BLOCKED BY POLICY');
    expect(blocked).not.toContain(shownBelow);
    expect(blocked).not.toContain('id="code"');

    config.policies = FREEZE_POLICIES;
    await call('apex_execute', { confirmation_code: request.confirmationCode });
    expect(db.getDeployRequest(request.id)!.status).toBe('executed');
    const after = page.render('override_recorded');
    expect(after).not.toContain(shownBelow);
    expect(after).not.toContain(request.confirmationCode);
  });
});

// ── starting an agent test run (P11) ─────────────────────────────────────

describe('run_agent_eval starts are checked; polls are not', () => {
  beforeEach(() => {
    const conn = db.resolveConnection('acme-dev')!;
    db.updateGrants(conn.id, { ...conn.grants, diagnostics_read: true });
  });

  const START = { eval: 'Invoice_Eval', runner: 'testing_center' };

  it('a start during a freeze is refused verbatim with no org request; a poll of an existing run still works', async () => {
    config.policies = FREEZE_POLICIES;
    fetched = [];
    const res = await call('run_agent_eval', START);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(freezeStartRefusalText('acme-dev', FREEZE));
    expect(fetched).toEqual([]);
    const rows = policyRefusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe('run_agent_eval');
    expect(rows[0]!.detail).toEqual({
      phase: 'start',
      kind: 'agent_eval',
      reason: 'freeze',
      rule: FREEZE_RULE,
      window: 'always',
    });

    const poll = await call('run_agent_eval', { run_id: EVAL_RUN_ID });
    expect(poll.isError ?? false, textOf(poll)).toBe(false);
    expect(bodyOf(poll)).toMatchObject({ run_id: EVAL_RUN_ID, status: 'IN_PROGRESS' });
    expect(policyRefusals()).toHaveLength(1);
  });

  it('policies that cannot be read refuse a start', async () => {
    const problem = 'config.json is not a JSON object';
    deploys.setPolicySource(() => ({ ok: false, problem }));
    fetched = [];
    const res = await call('run_agent_eval', START);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(policyUnreadableText(problem, 'propose'));
    expect(fetched).toEqual([]);
    expect(policyRefusals()[0]!.detail).toEqual({
      phase: 'start',
      kind: 'agent_eval',
      reason: 'config_unreadable',
    });
  });

  it('with no freeze a start goes ahead as before — no justification or ticket rule applies to a run', async () => {
    const res = await call('run_agent_eval', START);
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(bodyOf(res)).toMatchObject({ run_id: EVAL_RUN_ID, status: 'NEW', runner: 'testing_center' });
    expect(policyRefusals()).toHaveLength(0);
  });
});

// ── the freeze and block cards (connect/pages.ts, P11) ───────────────────

describe('the freeze and block cards', () => {
  const CODE = 'ABCD-EFGH';
  const VIEW: ApprovalPageOptions = {
    kind: 'apex',
    code: CODE,
    expiresAt: '2026-11-17T15:00:00.000Z',
    org: {
      alias: 'acme-dev',
      orgName: 'Acme',
      orgType: 'developer',
      instanceUrl: 'https://acme.example.invalid',
    },
    changes: [{ label: 'Execute anonymous Apex (1 line, 20 chars)', warnings: [] }],
    destructive: [],
    results: [],
    blast: [],
  };
  const FREEZE_LINE = `FREEZE — policy rule "${FREEZE_RULE}" freezes changes to "acme-dev" during "always" (until 2999-01-01 00:00 UTC).`;

  function pageWith(over: Partial<ApprovalGovernance> = {}): string {
    return renderApprovalPage({
      ...VIEW,
      governance: {
        gate: 'frozen',
        ticket: null,
        justification: { text: WHY, provenance: 'Drafted by the agent.', required: true },
        policySource: 'config',
        policyLines: [RULE_LINE],
        freezeLine: FREEZE_LINE,
        frozenAtMint: true,
        rev: 'frozen:::',
        limits: { justificationMax: 1000, reasonMin: 15, reasonMax: 1000 },
        ...over,
      },
    });
  }

  function codeCard(html: string): string {
    return html.slice(html.indexOf('id="code-card"'), html.indexOf('id="dead"'));
  }

  it('frozen: no code element even when the view carries the code, and neither the code nor the read-back note', () => {
    const html = pageWith();
    expect(html).not.toContain('id="code"');
    expect(html).not.toContain(CODE);
    expect(html).not.toContain('read this code back');
    expect(codeCard(html)).toContain(
      '<p class="note">Hidden while the change freeze is in effect — record an emergency reason above to show it.</p>',
    );
    const card = html.slice(html.indexOf('id="gov-freeze"'), html.indexOf('id="gov-record"'));
    expect(card).toContain('<h2>CHANGE FREEZE</h2>');
    expect(card).toContain(`<p class="freeze-line">${esc(FREEZE_LINE)}</p>`);
    expect(card).toContain(
      "If this change cannot wait, type the emergency reason below: the code then appears on this " +
        "page, and the reason is recorded in Contrail's audit log as a freeze override for this " +
        'request only. The freeze itself stays configured — only editing config.json changes it.',
    );
    // Between the org card and the Change record.
    expect(html.indexOf('id="gov-freeze"')).toBeGreaterThan(html.indexOf('>Instance<'));
    expect(html.indexOf('id="gov-freeze"')).toBeLessThan(html.indexOf('id="gov-record"'));
  });

  it('the two lead sentences, by whether the request was frozen when it was proposed', () => {
    const atMint = pageWith({ frozenAtMint: true });
    expect(atMint).toContain(`<p class="note">${FROZEN_AT_MINT_LEAD} If this change cannot wait`);
    expect(atMint).not.toContain('This freeze began after');
    const after = pageWith({ frozenAtMint: false });
    expect(after).toContain(`<p class="note">${FROZEN_AFTER_LEAD} If this change cannot wait`);
    expect(after).not.toContain('none was sent to your phone');
  });

  it('with a session the frozen card carries the emergency-reason form; without one it has none', () => {
    expect(pageWith()).not.toContain('<form');
    const html = pageWith({ sessionId: 'sid-1' });
    expect(html).toContain('<form method="post" action="/override" id="gov-override">');
    expect(html).toContain('<input type="hidden" name="session" value="sid-1">');
    expect(html).toContain('<label for="reason">Emergency reason</label>');
    expect(html).toContain(
      '<textarea id="reason" name="reason" rows="3" required minlength="15" maxlength="1000" ' +
        'placeholder="Why this cannot wait until the freeze ends"></textarea>',
    );
    expect(html).toContain(
      '<div class="hint">At least 15 characters. Kept with this request in the audit log and the ' +
        'change-evidence dossier.</div>',
    );
    expect(html).toContain('<button type="submit">Record emergency reason and show the code</button>');
  });

  it('overridden: the code and Part D\'s note, and the reason recorded, escaped', () => {
    const html = pageWith({
      gate: 'overridden',
      override: { reason: '<script>alert(1)</script> checkout down', at: '2026-11-17T14:03:00.000Z' },
    });
    expect(html).toContain('<h2>CHANGE FREEZE — OVERRIDDEN FOR THIS REQUEST</h2>');
    expect(html).toContain(`<p class="freeze-line">${esc(FREEZE_LINE)}</p>`);
    expect(html).toMatch(
      /You recorded an emergency reason at \d{2}:\d{2}: “&lt;script&gt;alert\(1\)&lt;\/script&gt; checkout down”\. The override applies to this request only and is in the audit log; the freeze stays configured\./,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<form method="post" action="/override"');
    expect(codeCard(html)).toContain(codeElement(CODE));
    expect(codeCard(html)).toContain('Contrail itself never gives the agent this page or the code');
  });

  it('blocked: both closing sentences, no code element and no read-back note', () => {
    const violations = pageWith({
      gate: 'blocked',
      blockedBy: 'violations',
      blockedLines: [TICKET_VIOLATION],
    });
    expect(violations).toContain('<div class="card danger-card" id="gov-block"><h2>BLOCKED BY POLICY</h2>');
    expect(violations).toContain(`<div class="chg-warn">${esc(TICKET_VIOLATION)}</div>`);
    expect(violations).toContain(
      "<p class=\"note\">No confirmation code is shown: this request does not satisfy this " +
        "connection's policies as they stand now — the lines above say what is missing. If it is " +
        'a justification, type it under Change record below and save; otherwise ask the agent to ' +
        'propose the change again.</p>',
    );
    const unreadable = pageWith({
      gate: 'blocked',
      blockedBy: 'unreadable',
      blockedLines: ['config.json is not a JSON object'],
      policyLines: [],
    });
    expect(unreadable).toContain(
      '<p class="note">No confirmation code is shown: Contrail could not read the policies in ' +
        'config.json — the line above says why. Once the file is fixed, this page updates by ' +
        'itself within a few seconds.</p>',
    );
    expect(unreadable).not.toContain('No policy rule applies');
    for (const html of [violations, unreadable]) {
      expect(html).not.toContain('id="code"');
      expect(html).not.toContain(CODE);
      expect(html).not.toContain('read this code back');
      expect(html).not.toContain('id="gov-freeze"');
      expect(codeCard(html)).toContain('<p class="note">Not shown — see "Blocked by policy" above.</p>');
    }
  });

  it('an open gate adds no freeze or block card; a page that is no longer pending has an empty code card', () => {
    const open = pageWith({ gate: 'open', freezeLine: undefined });
    expect(open).not.toContain('id="gov-freeze"');
    expect(open).not.toContain('id="gov-block"');
    expect(codeCard(open)).toContain(codeElement(CODE));
    const closed = renderApprovalPage({ ...VIEW, code: '', governance: undefined });
    expect(codeCard(closed)).not.toContain('<p class="note">');
  });

  it('the inline script reloads the page when /status reports another rev', () => {
    const html = pageWith({ rev: 'frozen:::2026-11-17T09:30:00.000Z' });
    const script = html.slice(html.indexOf('<script>'));
    expect(script).toContain('var REV = "frozen:::2026-11-17T09:30:00.000Z";');
    expect(script).toContain('else if (REV !== null && s && s.rev && s.rev !== REV) location.reload();');
    expect(script.indexOf('s.active === false')).toBeLessThan(script.indexOf('location.reload()'));
    expect(script).toContain(
      "history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(s))",
    );
    expect(renderApprovalPage(VIEW)).toContain('var REV = null;');
  });
});

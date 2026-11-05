import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { AuditLog } from '../core/audit.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { AccessTokenManager } from '../salesforce/tokens.js';
import { SnapshotStore } from '../snapshot/store.js';
import { SnapshotEngine } from '../snapshot/engine.js';
import { DeployEngine } from '../deploy/engine.js';
import { emptyGrantSet } from '../core/grants.js';
import type { ConnectionRecord } from '../core/types.js';

/**
 * S41 (§3.1): jobs are keyed by REQUEST INPUT, never by connection alone.
 * The field bug these pin: refresh_snapshot ["LightningComponentBundle"]
 * returned a result for ["ApexClass","CustomObject"], and a later
 * ["Settings"] call collected the LWC result while the Settings refresh
 * never ran. The same keying applied to validate_deploy (including dry
 * runs), so parallel callers could read each other's results.
 */

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

let tmp: string;
let db: ContrailDb;
let conn: ConnectionRecord;
let connId: string;
let tokens: MemoryTokenStore;
let store: SnapshotStore;

/** One-shot gate: while armed, the matching stub call stalls until release(). */
let gatePromise: Promise<void> | null = null;
let gateRelease: () => void = () => {};
function armGate(): void {
  gatePromise = new Promise((resolve) => {
    gateRelease = resolve;
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-jobkeys-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  conn = db.insertConnection({
    alias: 'jobs-org',
    instanceUrl: 'https://jobs.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DJ',
    orgName: 'Jobs',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  connId = conn.id;
  tokens.setRefreshToken(connId, 'RT');
  store = new SnapshotStore(path.join(tmp, 'snapshots'));
});

afterEach(() => {
  gateRelease(); // never leave a stalled stub holding the event loop
  gatePromise = null;
  vi.unstubAllGlobals();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── refresh jobs ─────────────────────────────────────────────────────────

describe('request-keyed refresh jobs', () => {
  let engine: SnapshotEngine;
  let listCalls: number;
  let statusCalls: number;

  function fileProp(type: string, fullName: string, fileName: string, tag: string): string {
    return `<${tag}><fullName>${fullName}</fullName><type>${type}</type>
      <fileName>${fileName}</fileName><id>x</id>
      <lastModifiedDate>2026-08-01T00:00:00.000Z</lastModifiedDate>
      <lastModifiedByName>Ryley</lastModifiedByName></${tag}>`;
  }

  function fixtureZip(): string {
    const zip = zipSync({
      'unpackaged/package.xml': strToU8('<Package/>'),
      'unpackaged/classes/JobsCls.cls': strToU8('public class JobsCls {}'),
      'unpackaged/flows/Jobs_Flow.flow': strToU8(
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Jobs Flow</label></Flow>',
      ),
    });
    return Buffer.from(zip).toString('base64');
  }

  beforeEach(() => {
    listCalls = 0;
    statusCalls = 0;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            instance_url: 'https://jobs.stub.salesforce.com',
            id: 'https://login.salesforce.com/id/00DJ/005J',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.includes('/services/Soap/m/')) {
        const body = String(init?.body ?? '');
        if (body.includes('<met:listMetadata>')) {
          listCalls += 1;
          return new Response(
            soapEnvelope(
              `<listMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 ${fileProp('ApexClass', 'JobsCls', 'classes/JobsCls.cls', 'result')}
                 ${fileProp('Flow', 'Jobs_Flow', 'flows/Jobs_Flow.flow', 'result')}
               </listMetadataResponse>`,
            ),
          );
        }
        if (body.includes('<met:retrieve>')) {
          return new Response(
            soapEnvelope(
              `<retrieveResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><id>09S-jobs</id><done>false</done><state>Queued</state></result>
               </retrieveResponse>`,
            ),
          );
        }
        if (body.includes('<met:checkRetrieveStatus>')) {
          statusCalls += 1;
          // The FIRST status poll of the run stalls while the gate is armed —
          // that keeps job #1 in flight while later requests arrive.
          if (statusCalls === 1 && gatePromise) await gatePromise;
          return new Response(
            soapEnvelope(
              `<checkRetrieveStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><done>true</done><status>Succeeded</status><success>true</success>
                   <id>09S-jobs</id><zipFile>${fixtureZip()}</zipFile>
                   ${fileProp('ApexClass', 'JobsCls', 'classes/JobsCls.cls', 'fileProperties')}
                   ${fileProp('Flow', 'Jobs_Flow', 'flows/Jobs_Flow.flow', 'fileProperties')}
                 </result>
               </checkRetrieveStatusResponse>`,
            ),
          );
        }
        return new Response('unexpected SOAP body', { status: 500 });
      }
      if (url.includes('/tooling/query')) {
        return new Response(JSON.stringify({ done: true, records: [] }));
      }
      return new Response('not found', { status: 404 });
    });

    const config: ContrailConfig = {
      ...DEFAULT_CONFIG,
      salesforce: { ...DEFAULT_CONFIG.salesforce },
      snapshot: { ...DEFAULT_CONFIG.snapshot, pollIntervalMs: 5, toolWaitMs: 30 },
    };
    const tokenMgr = new AccessTokenManager(db, tokens, config);
    engine = new SnapshotEngine(db, store, tokenMgr, config, new AuditLog(db));
  });

  async function collect(types?: string[], jobId?: string) {
    for (let i = 0; i < 400; i++) {
      const outcome = await engine.refresh(conn, types, jobId);
      if (outcome.status !== 'in_progress') return outcome;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('refresh never finished');
  }

  it('a different request never collects an earlier job, and runs serialise per connection', async () => {
    armGate();
    const first = await engine.refresh(conn, ['ApexClass']);
    expect(first.status).toBe('in_progress');
    const firstId = first.job_id;

    // A second, DIFFERENT request gets its own job — queued, not attached.
    const second = await engine.refresh(conn, ['Flow']);
    expect(second.status).toBe('in_progress');
    expect(second.job_id).not.toBe(firstId);
    // Serialisation: while job #1 is stalled org-side, job #2 has not
    // touched the org at all.
    expect(listCalls).toBe(1);

    gateRelease();
    gatePromise = null;

    // The Flow caller gets the FLOW result — never the ApexClass one.
    const flowDone = await collect(['Flow']);
    expect(flowDone.status).toBe('complete');
    if (flowDone.status !== 'complete') return;
    expect(flowDone.summary.types).toEqual(['Flow']);
    expect(flowDone.summary.artifact_counts).toMatchObject({ Flow: 1 });

    // Job #1's uncollected result is still waiting for ITS requester.
    const apexDone = await collect(['ApexClass']);
    expect(apexDone.status).toBe('complete');
    if (apexDone.status !== 'complete') return;
    expect(apexDone.job_id).toBe(firstId);
    expect(apexDone.summary.types).toEqual(['ApexClass']);
    expect(apexDone.summary.artifact_counts).toMatchObject({ ApexClass: 1 });

    // Both refreshes really ran, one after the other, and neither clobbered
    // the other's files or index rows.
    expect(listCalls).toBe(2);
    expect(db.getArtifact(connId, 'ApexClass', 'JobsCls')).toBeTruthy();
    expect(db.getArtifact(connId, 'Flow', 'Jobs_Flow')).toBeTruthy();
  });

  it('polls by job_id alone; unknown or already-collected ids are honest, never a fresh run', async () => {
    armGate();
    const first = await engine.refresh(conn, ['ApexClass']);
    expect(first.status).toBe('in_progress');

    const polled = await engine.refresh(conn, undefined, first.job_id);
    expect(polled.status).toBe('in_progress');
    expect(polled.job_id).toBe(first.job_id);

    const unknown = await engine.refresh(conn, undefined, 'refresh-doesnotexist');
    expect(unknown.status).toBe('unknown_job');

    gateRelease();
    gatePromise = null;
    const done = await collect(undefined, first.job_id);
    expect(done.status).toBe('complete');
    if (done.status !== 'complete') return;
    expect(done.summary.types).toEqual(['ApexClass']);

    // Collected means gone: a re-poll says so instead of inventing a result,
    // and polling never started a new refresh (still exactly one listing).
    const again = await engine.refresh(conn, undefined, first.job_id);
    expect(again.status).toBe('unknown_job');
    expect(listCalls).toBe(1);
  });

  it('a live foreign app_locks lease (desktop mid-sync) fails the refresh; expiry frees it', async () => {
    // The plugin NEVER creates app_locks (v5 freeze) — simulate a machine
    // where the desktop app made the table and is mid-sync on this org.
    const raw = new Database(path.join(tmp, 'test.db'));
    raw.exec(
      `CREATE TABLE app_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL,
         pid INTEGER, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    );
    raw
      .prepare(
        `INSERT INTO app_locks (name, holder, pid, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        `snapshot:${connId}`,
        'desktop:4242',
        4242,
        new Date().toISOString(),
        new Date(Date.now() + 10 * 60_000).toISOString(),
      );

    const locked = await collect(['ApexClass']);
    expect(locked.status).toBe('failed');
    if (locked.status !== 'failed') return;
    expect(locked.error).toMatch(/desktop app\) is refreshing this connection/);
    expect(listCalls).toBe(0); // refused before touching the org

    // An EXPIRED foreign lease is taken over — the desktop's own semantics —
    // and the plugin releases its lease once the run finishes.
    raw
      .prepare(`UPDATE app_locks SET expires_at = ? WHERE name = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), `snapshot:${connId}`);
    const done = await collect(['ApexClass']);
    expect(done.status).toBe('complete');
    const left = raw.prepare(`SELECT * FROM app_locks WHERE name = ?`).all(`snapshot:${connId}`);
    expect(left).toHaveLength(0); // released in the finally
    raw.close();
  });
});

// ── validate jobs ────────────────────────────────────────────────────────

describe('input-keyed validate jobs', () => {
  let deploys: DeployEngine;
  let validations: number;
  /** Deploy ids whose checkDeployStatus stalls while the gate is armed. */
  let stalledIds: Set<string>;

  beforeEach(() => {
    validations = 0;
    stalledIds = new Set();
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/oauth2/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            instance_url: 'https://jobs.stub.salesforce.com',
            id: 'https://login.salesforce.com/id/00DJ/005J',
            token_type: 'Bearer',
          }),
        );
      }
      if (url.includes('/services/Soap/m/')) {
        const body = String(init?.body ?? '');
        if (body.includes('<met:deploy>')) {
          validations += 1;
          return new Response(
            soapEnvelope(
              `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result><id>0Af-check-${validations}</id></result>
               </deployResponse>`,
            ),
          );
        }
        if (body.includes('<met:checkDeployStatus>')) {
          const id = /<met:asyncProcessId>([^<]+)<\/met:asyncProcessId>/.exec(body)?.[1] ?? '';
          if (stalledIds.has(id) && gatePromise) await gatePromise;
          return new Response(
            soapEnvelope(
              `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
                 <result>
                   <done>true</done><status>Succeeded</status>
                   <success>true</success><checkOnly>true</checkOnly>
                   <numberComponentsTotal>1</numberComponentsTotal>
                   <numberComponentsDeployed>1</numberComponentsDeployed>
                   <numberComponentErrors>0</numberComponentErrors>
                   <numberTestsTotal>0</numberTestsTotal>
                   <numberTestsCompleted>0</numberTestsCompleted>
                   <numberTestErrors>0</numberTestErrors>
                   <details><runTestResult><numTestsRun>0</numTestsRun>
                     <numFailures>0</numFailures></runTestResult></details>
                 </result>
               </checkDeployStatusResponse>`,
            ),
          );
        }
        return new Response('unexpected SOAP body', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    });

    const config: ContrailConfig = {
      ...DEFAULT_CONFIG,
      salesforce: { ...DEFAULT_CONFIG.salesforce },
      deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5, toolWaitMs: 30 },
    };
    const tokenMgr = new AccessTokenManager(db, tokens, config);
    deploys = new DeployEngine(db, store, tokenMgr, config, new AuditLog(db));
  });

  function dryInput(name: string) {
    return {
      components: [
        { type: 'ApexClass', api_name: name, content: `public class ${name} {}` },
      ],
      destructive: [],
      runTests: [],
      dryRun: true,
    };
  }

  async function pollUntilDone(jobId: string) {
    for (let i = 0; i < 400; i++) {
      const outcome = await deploys.pollValidate(conn, jobId);
      if (!outcome) throw new Error(`job ${jobId} vanished before it was collected`);
      if (outcome.status !== 'in_progress') return outcome;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('validation never finished');
  }

  it('two concurrent dry runs of different packages each get their own result', async () => {
    armGate();
    stalledIds.add('0Af-check-1');

    const alpha1 = await deploys.validateDeploy(conn, dryInput('AlphaCls'));
    expect(alpha1.status).toBe('in_progress');

    // Re-sending the SAME input attaches to the same job: no third
    // validation is dispatched for it.
    const alphaAgain = await deploys.validateDeploy(conn, dryInput('AlphaCls'));
    expect(alphaAgain.job_id).toBe(alpha1.job_id);

    // A DIFFERENT package gets its own job and its own org validation —
    // before S41 it attached to Alpha's job and read Alpha's result.
    const beta = await deploys.validateDeploy(conn, dryInput('BetaCls'));
    expect(beta.job_id).not.toBe(alpha1.job_id);
    const betaDone = beta.status === 'complete' ? beta : await pollUntilDone(beta.job_id);
    expect(betaDone.status).toBe('complete');
    const betaText = JSON.stringify(betaDone);
    expect(betaText).toContain('BetaCls');
    expect(betaText).not.toContain('AlphaCls');

    gateRelease();
    gatePromise = null;
    const alphaDone = await pollUntilDone(alpha1.job_id);
    expect(alphaDone.status).toBe('complete');
    expect(JSON.stringify(alphaDone)).toContain('AlphaCls');

    expect(validations).toBe(2); // one per package — never a third, never zero for Beta
  });

  it('pollValidate answers only for jobs that exist; collected results are gone honestly', async () => {
    expect(await deploys.pollValidate(conn, 'vdry-doesnotexist')).toBeNull();

    const done = await deploys.validateDeploy(conn, dryInput('GammaCls'));
    expect(done.status).toBe('complete'); // inline: nothing stalled it
    // Collected inline — a later poll must say "no such job", not re-run.
    expect(await deploys.pollValidate(conn, done.job_id)).toBeNull();
    expect(validations).toBe(1);

    // The dry/real split rides the id itself.
    expect(done.job_id.startsWith('vdry-')).toBe(true);
  });
});

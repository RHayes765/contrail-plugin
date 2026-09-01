import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import { ApprovalPageServer } from '../deploy/approval.js';
import { createDeps, createServer } from '../server.js';
import { apexScratchName } from '../localdiag/runner.js';
import type {
  ApexSourceKind,
  LocalDiagResult,
  LocalDiagRunner,
  UnavailableCode,
} from '../localdiag/types.js';

/**
 * S26 tool-surface tests with a FAKE runner injected through createDeps —
 * the honesty contract under test: unavailable results are structured
 * SUCCESSES carrying the fail-closed doctrine, never isError; diagnostics
 * render with counts; semantic findings carry the advisory note.
 * (The real spawn path is covered by localdiag.integration.test.ts.)
 */

let tmp: string;
let db: ContrailDb;
let client: Client;
let fake: {
  apexCalls: Array<{ source: string; kind: ApexSourceKind }>;
  soqlCalls: string[];
  nextApex: LocalDiagResult;
  nextSoql: LocalDiagResult;
};

function fakeRunner(): LocalDiagRunner {
  return {
    async checkApex(source, kind) {
      fake.apexCalls.push({ source, kind });
      return fake.nextApex;
    },
    async checkSoql(query) {
      fake.soqlCalls.push(query);
      return fake.nextSoql;
    },
    async shutdown() {},
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-ld-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  fake = {
    apexCalls: [],
    soqlCalls: [],
    nextApex: { checked: true, diagnostics: [] },
    nextSoql: { checked: true, diagnostics: [] },
  };
  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot },
    updates: { ...DEFAULT_CONFIG.updates },
    localDiagnostics: { ...DEFAULT_CONFIG.localDiagnostics },
    deploy: { ...DEFAULT_CONFIG.deploy },
  };
  const deps = createDeps({
    db,
    tokens: new MemoryTokenStore(),
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals: new ApprovalPageServer(async () => {}),
    localDiag: fakeRunner(),
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
  await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('check_apex / check_soql tool surface', () => {
  it('renders diagnostics with honest counts, defaulting the kind to class', async () => {
    fake.nextApex = {
      checked: true,
      diagnostics: [
        { severity: 'error', line: 2, column: 10, message: "missing ';' at '}'", code: 'missing.syntax' },
        { severity: 'warning', line: 4, column: 1, message: 'unused variable', code: 'unused.variable' },
      ],
    };
    const result = await client.callTool({
      name: 'check_apex',
      arguments: { code: 'public class X {}' },
    });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(result.isError ?? false).toBe(false);
    expect(body.checked).toBe(true);
    expect(body.error_count).toBe(1);
    expect(body.warning_count).toBe(1);
    expect(fake.apexCalls).toEqual([{ source: 'public class X {}', kind: 'class' }]);
  });

  it('attaches the advisory note to SEMANTIC findings but not to pure syntax results', async () => {
    fake.nextApex = {
      checked: true,
      diagnostics: [
        { severity: 'error', line: 1, column: 1, message: 'x', code: 'missing.syntax' },
      ],
    };
    const syntaxOnly = JSON.parse(
      textOf(await client.callTool({ name: 'check_apex', arguments: { code: 'x', type: 'anonymous' } })),
    ) as Record<string, unknown>;
    expect(syntaxOnly.note).toBeUndefined();
    expect(fake.apexCalls[0]?.kind).toBe('anonymous');

    fake.nextApex = {
      checked: true,
      diagnostics: [
        { severity: 'error', line: 1, column: 1, message: 'y', code: 'variable.does.not.exist' },
      ],
    };
    const semantic = JSON.parse(
      textOf(await client.callTool({ name: 'check_apex', arguments: { code: 'x' } })),
    ) as Record<string, unknown>;
    expect(String(semantic.note)).toContain('validate_deploy as the authority');
  });

  it('every unavailable code is a structured SUCCESS carrying the fail-closed doctrine', async () => {
    const codes: UnavailableCode[] = [
      'disabled',
      'not_installed',
      'spawn_timeout',
      'check_timeout',
      'server_error',
    ];
    for (const code of codes) {
      fake.nextApex = { checked: false, unavailable: code, detail: `because ${code}` };
      const result = await client.callTool({
        name: 'check_apex',
        arguments: { code: 'public class X {}' },
      });
      // NOT an error: an error would train the agent to retry instead of
      // falling back to validate_deploy.
      expect(result.isError ?? false, code).toBe(false);
      const text = textOf(result);
      expect(text).toContain(`check_apex=unavailable: ${code}`);
      expect(text).toContain('NOT checked');
      expect(text).toContain('validate_deploy');
    }
    fake.nextSoql = { checked: false, unavailable: 'not_installed', detail: 'x' };
    const soql = await client.callTool({ name: 'check_soql', arguments: { query: 'SELECT Id FROM A' } });
    expect(soql.isError ?? false).toBe(false);
    expect(textOf(soql)).toContain('check_soql=unavailable: not_installed');
  });

  it('refuses empty and over-cap inputs at the schema/handler edge', async () => {
    const empty = await client.callTool({ name: 'check_apex', arguments: { code: '   ' } });
    expect(empty.isError).toBe(true);

    const overCap = await client.callTool({
      name: 'check_apex',
      arguments: { code: 'x'.repeat(500_001) },
    });
    expect(overCap.isError).toBe(true);

    const emptyQuery = await client.callTool({ name: 'check_soql', arguments: { query: ' ' } });
    expect(emptyQuery.isError).toBe(true);
    expect(fake.apexCalls).toHaveLength(0);
    expect(fake.soqlCalls).toHaveLength(0);
  });
});

describe('apexScratchName', () => {
  it('derives the filename from the DECLARED type name (a mismatch would itself diagnose)', () => {
    expect(apexScratchName('public with sharing class InvoiceService { }', 'class')).toBe(
      'InvoiceService.cls',
    );
    expect(apexScratchName('public interface Payable {}', 'class')).toBe('Payable.cls');
    expect(apexScratchName('trigger AccountGuard on Account (before insert) {}', 'trigger')).toBe(
      'AccountGuard.trigger',
    );
    expect(apexScratchName("System.debug('x');", 'anonymous')).toBe('__anon__.apex');
    expect(apexScratchName('not really apex', 'class')).toBe('ContrailCheck.cls');
  });
});

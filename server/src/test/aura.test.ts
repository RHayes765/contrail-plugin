import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { emptyGrantSet } from '../core/grants.js';

/**
 * S41: AuraDefinitionBundle at the tool/engine seam — the LIVE validate
 * checks (MISCLASSIFIED ADD, NAME COLLISION), the live Tooling read path,
 * the §3.14 production NoTestRun guard, the §3.15 unregistered-delete gate,
 * and the build-before-supersede ordering that keeps local refusals from
 * killing pending approvals.
 */

let tmp: string;
let db: ContrailDb;
let client: Client;
let presentedPages: string[];
let deployCalls: number;

/** Tooling stub state, reset per test. */
let lwcCollisionRows: Array<{ Id: string }>;
let auraDefRows: Array<{ DefType: string; Source: string | null }>;
let auraBundleRows: Array<{ ApiVersion: number | null; Description?: string | null }>;
let toolingFails: boolean;
let lastToolingQueries: string[];

const META_66 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
  '    <apiVersion>66.0</apiVersion>\n</AuraDefinitionBundle>\n';

function popEnvelope(): string {
  return JSON.stringify({
    contrail_bundle: 1,
    files: {
      'voiceCallPop.cmp': '<aura:component implements="lightning:backgroundUtilityItem"/>',
      'voiceCallPop.cmp-meta.xml': META_66,
      'voiceCallPopController.js': '({ onCall: function () {} })',
    },
  });
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function stubSalesforce(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://aura.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DA/005A',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/tooling/query')) {
      if (toolingFails) return new Response('tooling down', { status: 500 });
      const q = decodeURIComponent(url);
      lastToolingQueries.push(q);
      if (q.includes('FROM LightningComponentBundle')) {
        return new Response(
          JSON.stringify({ done: true, records: lwcCollisionRows, totalSize: lwcCollisionRows.length }),
        );
      }
      if (q.includes('FROM AuraDefinition ')) {
        return new Response(
          JSON.stringify({ done: true, records: auraDefRows, totalSize: auraDefRows.length }),
        );
      }
      if (q.includes('FROM AuraDefinitionBundle')) {
        return new Response(
          JSON.stringify({ done: true, records: auraBundleRows, totalSize: auraBundleRows.length }),
        );
      }
      return new Response(JSON.stringify({ done: true, records: [] }));
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        deployCalls += 1;
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af-aura-${deployCalls}</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
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
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-aura-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  presentedPages = [];
  deployCalls = 0;
  lwcCollisionRows = [];
  auraDefRows = [];
  auraBundleRows = [];
  toolingFails = false;
  lastToolingQueries = [];

  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  for (const [alias, orgType] of [
    ['aura-dev', 'developer'],
    ['aura-prod', 'production'],
  ] as const) {
    const conn = db.insertConnection({
      alias,
      instanceUrl: 'https://aura.stub.salesforce.com',
      loginUrl: 'https://login.salesforce.com',
      orgId: alias === 'aura-prod' ? '00DP' : '00DA',
      orgName: 'Aura',
      orgType,
      isSandbox: false,
      username: null,
      userId: null,
      grants,
    });
    tokens.setRefreshToken(conn.id, 'RT');
  }
  stubSalesforce();

  const approvals = new ApprovalPageServer(async () => {});
  const origPresent = approvals.present.bind(approvals);
  approvals.present = async (
    html: string,
    statusCheck?: () => { active: boolean; status: string },
  ) => {
    presentedPages.push(html);
    return origPresent(html, statusCheck);
  };

  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5 },
  };
  const deps = createDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals,
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => undefined,
    },
  });
  const server = createServer(deps);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'aura-test', version: '0.0.0' });
  await client.connect(c);
});

afterEach(async () => {
  await client.close();
  db.close();
  vi.unstubAllGlobals();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** ok() prefixes the JSON payload with a message line — parse past it. */
function jsonOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;
}

async function dryValidatePop(connection = 'aura-dev') {
  return client.callTool({
    name: 'validate_deploy',
    arguments: {
      connection,
      dry_run: true,
      components: [
        { type: 'AuraDefinitionBundle', api_name: 'voiceCallPop', content: popEnvelope() },
      ],
    },
  });
}

describe('S41 live validate checks', () => {
  it('MISCLASSIFIED ADD: an org-held bundle absent from the snapshot shows MODIFY with the file delta', async () => {
    auraDefRows = [
      { DefType: 'COMPONENT', Source: '<aura:component/>' }, // differs → changed
      { DefType: 'CONTROLLER', Source: '({ onCall: function () {} })' }, // equal
      { DefType: 'STYLE', Source: '.old {}' }, // only org-side → removed
    ];
    auraBundleRows = [{ ApiVersion: 60 }];
    const parsed = jsonOf(await dryValidatePop()) as unknown as {
      changes: Array<{ change: string; warnings: string[] }>;
    };
    expect(parsed.changes[0]!.change).toBe('modify');
    const text = parsed.changes[0]!.warnings.join(' ');
    expect(text).toMatch(/ORG HAS THIS BUNDLE/);
    expect(text).toMatch(/changed: voiceCallPop\.cmp/);
    expect(text).toMatch(/removed: voiceCallPop\.css/);
    expect(text).toMatch(/apiVersion changes 60 → 66/);
    // The flip RETRACTS the add-time INERT warning: "renders NOWHERE" is
    // false for a bundle the org already places — both lines on one page
    // would contradict each other.
    expect(text).not.toMatch(/INERT UNTIL PLACED/);
  });

  it('a live KIND conflict refuses the validate — never swallowed by the degrade catch', async () => {
    // Org-side the bundle is an APPLICATION; the envelope proposes a .cmp
    // under the same name. The live check SUCCEEDED in finding this, so it
    // must refuse — not degrade into a could-not-live-check warning.
    auraDefRows = [{ DefType: 'APPLICATION', Source: '<aura:application/>' }];
    auraBundleRows = [{ ApiVersion: 60 }];
    const result = await dryValidatePop();
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/ORG's bundle is \.app \(live check\)/);
    expect(text).toMatch(/envelope is \.cmp/);
    expect(text).not.toMatch(/could not live-check/);
    expect(deployCalls).toBe(0); // refused before any org deploy was sent
  });

  it('NAME COLLISION with an org LWC warns; no org bundle keeps ADD honest', async () => {
    lwcCollisionRows = [{ Id: '0Rb000000000001AAA' }];
    const parsed = jsonOf(await dryValidatePop()) as unknown as {
      changes: Array<{ change: string; warnings: string[] }>;
    };
    expect(parsed.changes[0]!.change).toBe('add');
    expect(parsed.changes[0]!.warnings.join(' ')).toMatch(/NAME COLLISION/);
  });

  it('a failed live check degrades to an honest warning, never a blocked validation', async () => {
    toolingFails = true;
    const result = await dryValidatePop();
    expect(result.isError ?? false).toBe(false);
    const parsed = jsonOf(result) as unknown as {
      changes: Array<{ warnings: string[] }>;
    };
    expect(parsed.changes[0]!.warnings.join(' ')).toMatch(/could not live-check/);
  });
});

describe('S41 §3.14/§3.15 guards and supersede ordering', () => {
  it('production refuses an explicit NoTestRun locally — no org call, nothing superseded', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-prod',
        test_level: 'NoTestRun',
        components: [{ type: 'FlexiPage', api_name: 'P', content: '<FlexiPage/>' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/NoTestRun is refused locally/);
    expect(deployCalls).toBe(0);
  });

  it('an unregistered-type delete needs the explicit flag; translations are refused outright', async () => {
    const blind = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-dev',
        destructive: [{ type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
      },
    });
    expect(blind.isError).toBe(true);
    expect(textOf(blind)).toMatch(/allow_unregistered_delete/);
    expect(deployCalls).toBe(0);

    const allowed = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-dev',
        destructive: [{ type: 'PresenceUserConfig', api_name: 'Voice_Agents' }],
        allow_unregistered_delete: true,
      },
    });
    expect(allowed.isError ?? false).toBe(false);
    expect(presentedPages.at(-1)!).toMatch(/UNREGISTERED TYPE DELETE/);

    const translation = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-dev',
        destructive: [{ type: 'Translations', api_name: 'fr' }],
        allow_unregistered_delete: true,
      },
    });
    expect(translation.isError).toBe(true);
    expect(textOf(translation)).toMatch(/Translation Workbench/);
  });

  it('a poll is job_id ALONE — options beside it are refused, never silently dropped', async () => {
    const result = await client.callTool({
      name: 'validate_deploy',
      arguments: { connection: 'aura-dev', job_id: 'val-abc123def456', dry_run: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Pass job_id ALONE/);
    expect(deployCalls).toBe(0);
  });

  it('a locally refused validate supersedes NOTHING — the pending code survives', async () => {
    const first = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-dev',
        components: [{ type: 'FlexiPage', api_name: 'P', content: '<FlexiPage/>' }],
      },
    });
    const requestId = (jsonOf(first) as unknown as { request_id: string }).request_id;
    expect(db.getDeployRequestStatus(requestId)).toBe('validated');

    // A malformed Aura envelope (missing meta) is refused by the local
    // grammar — BEFORE the supersede step, by S41's ordering.
    const refused = await client.callTool({
      name: 'validate_deploy',
      arguments: {
        connection: 'aura-dev',
        components: [
          {
            type: 'AuraDefinitionBundle',
            api_name: 'voiceCallPop',
            content: JSON.stringify({
              contrail_bundle: 1,
              files: { 'voiceCallPop.cmp': '<aura:component/>' },
            }),
          },
        ],
      },
    });
    expect(refused.isError).toBe(true);
    expect(db.getDeployRequestStatus(requestId)).toBe('validated'); // untouched
  });
});

describe('S41 live Aura read', () => {
  it('a bundle missing from the snapshot reads live from Tooling, framed like the index', async () => {
    auraDefRows = [
      { DefType: 'COMPONENT', Source: '<aura:component/>' },
      { DefType: 'CONTROLLER', Source: '({})' },
    ];
    auraBundleRows = [{ ApiVersion: 59, Description: 'Installed helper' }];
    const result = await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        connection: 'aura-dev',
        type: 'AuraDefinitionBundle',
        names: ['navHelper'],
      },
    });
    const text = textOf(result);
    expect(text).toContain('tooling (live)');
    expect(text).toContain('contrail:file aura/navHelper/navHelper.cmp');
    // toFixed(1): Tooling returns ApiVersion as a NUMBER (59) — the rebuilt
    // meta must print the canonical metadata form (59.0), matching retrieves.
    expect(text).toContain('<apiVersion>59.0</apiVersion>');
    expect(text).toContain('Installed helper');
  });

  it('an ns__Name managed bundle filters by namespace in the live query', async () => {
    auraDefRows = [{ DefType: 'COMPONENT', Source: '(hidden)' }];
    auraBundleRows = [{ ApiVersion: 55 }];
    const result = await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        connection: 'aura-dev',
        type: 'AuraDefinitionBundle',
        names: ['fsc__openUrl'],
      },
    });
    const text = textOf(result);
    expect(text).toContain('managed package conceals');
    expect(lastToolingQueries.join(' ')).toContain(`NamespacePrefix = 'fsc'`);
    expect(lastToolingQueries.join(' ')).toContain(`DeveloperName = 'openUrl'`);
  });
});

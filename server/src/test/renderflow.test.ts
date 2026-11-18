import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { ContrailError } from '../core/errors.js';
import { emptyGrantSet, TOOL_GRANT_MAP } from '../core/grants.js';
import { resolveSkillsDir } from '../core/paths.js';
import { RC_HOOKED_TOOLS, RemoteControlProbe } from '../core/remoteControl.js';
import type { AuditEvent } from '../core/types.js';
import { ENGINE_VERSION } from '../core/version.js';
import { resolveSourcePath } from '../deploy/sources.js';
import { createDeps, createServer } from '../server.js';
import { SnapshotStore } from '../snapshot/store.js';
import { buildServerInstructions } from '../skillpack/instructions.js';
import { loadSkillPack } from '../skillpack/pack.js';
import { RENDER_RETENTION_MS, sweepRenders } from '../tools/flowrender.js';
import type { ToolDeps } from '../tools/register.js';
import { SEND_INVOICE_FLOW_XML } from './fixtures.js';

/**
 * render_flow through a real server over the in-memory transport: every kind
 * of side (a snapshot copy, a Tooling version, the live fallback, a saved
 * file), what the result and the page say about each, every refusal with its
 * exact text, the order of the file-side checks (nothing is learned about a
 * path outside the folders render_flow reads), and the renders/ sweep.
 * Tooling and REST calls are answered by a stubbed fetch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const SHIPPED_TEMPLATE = path.join(
  repoRoot,
  'skills',
  'salesforce-flow-visualize',
  'assets',
  'flow-diff-template.html',
);

// The suite reads the repo's own pack unless a case points elsewhere.
delete process.env.CONTRAIL_SKILLS_DIR;

const BOM = String.fromCharCode(0xfeff);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRIEVED_AT = '2026-08-06T09:30:00.000Z';
const RETRIEVED_TEXT = '2026-08-06 09:30';

const DESCRIPTION =
  'Show a Salesforce flow as an interactive flow diagram, or two flows side by side in a diff viewer: ' +
  'visualize, display, draw or chart a flow; compare a flow across two orgs, two versions of one flow, or ' +
  'before and after an edit. Contrail builds the HTML page itself from the flow XML (Flow-Builder-style ' +
  'canvas, change highlighting, click a node to inspect it) - never hand-build one - writes it under ' +
  'renders/ in its data directory and returns the file path. By default it also asks this computer to open ' +
  'the page; to show it anywhere else (a human on their phone, a shared review), pass open:false and ' +
  'publish the returned file as a private artifact - publish the file, never paste its contents. Each side ' +
  "is one of: a connection's snapshot copy of the flow - its latest version, which may not be the active " +
  'one (read live from the Tooling API when the snapshot lacks it); a historical version by number, or ' +
  '"active" / "latest" (the Tooling API\'s JSON converted to flow XML); or a saved flow XML file under ' +
  "Contrail's staging directory. Side A is the left/old pane, side B the right/new pane; give no side-B " +
  'argument for a single view. Requires metadata_read on every connection it reads. Two snapshot copies, ' +
  'or two converted versions, compare like for like; a converted version against a snapshot or a saved ' +
  'retrieve is allowed but can mark nodes changed only because their child elements are ordered ' +
  'differently - the result and the page footer say when that applies. A flow whose definition no API ' +
  "exposes (platform/feature-delivered) is refused, not drawn. The page embeds the flow's full XML: treat " +
  'the file as client-confidential. Pages in renders/ older than 7 days are deleted when the Contrail ' +
  'server starts and each time render_flow writes a page.';

const RETENTION =
  'Pages in this folder older than 7 days are deleted when the Contrail server starts and each time ' +
  'render_flow writes a page; nothing deletes them in between.';
const PUBLISH_NOTE =
  'To show this page anywhere else, publish this file as a private artifact. Publish the file itself; do ' +
  'not paste or retype its contents.';

const PREFIX_OPENED =
  'Flow page written and this computer was asked to open it (its default app for .html files).';
const PREFIX_NOT_OPENED = 'Flow page written; not opened, because open was false.';
const PREFIX_OPEN_FAILED = 'Flow page written, but this computer could not open it automatically.';

const HINT =
  ' - an older version may still be the active one. Pass version: "active" to draw the version that runs.';
const N5_MIXED =
  'Mixed sources: one side was converted from Tooling API JSON and the other is a Metadata API retrieve. ' +
  'Their child elements are ordered differently, so nodes can be marked changed when nothing real differs ' +
  "- check the inspector's parsed rows before trusting a mark. For a like-for-like comparison, pass a " +
  'version on both sides.';
const N6_FILE =
  'One side is a saved file whose origin Contrail cannot tell. If the two sides were not produced the same ' +
  'way (both Metadata API retrieves, or both converted Tooling versions), nodes can be marked changed only ' +
  'because their child elements are ordered differently.';
const BUILT_RE = new RegExp(
  `^Built by Contrail ${ENGINE_VERSION.replaceAll('.', '\\.')} render_flow at ` +
    '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\.$',
);

// ---- flows ----------------------------------------------------------------

function flowWithStatus(label: string, status: string | null): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <assignments>
        <name>Set_Flag</name>
        <label>Set flag</label>
        <connector><targetReference>Notify</targetReference></connector>
    </assignments>
    <actionCalls>
        <name>Notify</name>
        <label>${label}</label>
        <actionName>emailSimple</actionName>
        <actionType>emailSimple</actionType>
    </actionCalls>
    <label>${label}</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <connector><targetReference>Set_Flag</targetReference></connector>
    </start>${status === null ? '' : `\n    <status>${status}</status>`}
</Flow>
`;
}

/** A flow with `n` decision elements: the page draws n + 1 nodes (the Start node too). */
function flowWithDecisions(n: number): string {
  const decisions = Array.from(
    { length: n },
    (_, i) => `<decisions><name>D${i}</name><label>Decision ${i}</label></decisions>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">${decisions}<status>Active</status></Flow>\n`;
}

const SEND_INVOICE_B = SEND_INVOICE_FLOW_XML.replace(
  '<actionName>InvoiceService</actionName>',
  '<actionName>InvoiceServiceV2</actionName>',
);

// ---- the stubbed org -------------------------------------------------------

interface StubVersion {
  n: number;
  status: string;
  metadata: Record<string, unknown>;
}

function routerMetadata(n: number, status: string): Record<string, unknown> {
  return {
    label: `Order Router v${n}`,
    status,
    processType: 'AutoLaunchedFlow',
    assignments: Array.from({ length: n - 11 }, (_, i) => ({ name: `Set_${i}`, label: `Set ${i}` })),
    start: { connector: { targetReference: 'Set_0' } },
  };
}

const VERSIONS: Record<string, StubVersion[]> = {
  Order_Router: [
    { n: 12, status: 'Obsolete', metadata: routerMetadata(12, 'Obsolete') },
    { n: 13, status: 'Active', metadata: routerMetadata(13, 'Active') },
    { n: 14, status: 'Draft', metadata: routerMetadata(14, 'Draft') },
  ],
  Draft_Only: [
    { n: 1, status: 'Obsolete', metadata: { label: 'Draft only v1', status: 'Obsolete' } },
    { n: 2, status: 'Draft', metadata: { label: 'Draft only v2', status: 'Draft' } },
  ],
};

const versionId = (flow: string, n: number): string =>
  `301${Object.keys(VERSIONS).indexOf(flow)}${String(n).padStart(11, '0')}AAA`;

/** FlowDefinition rows for flows the snapshot does not hold. */
const DEFINITIONS: Record<string, { ActiveVersionId: string | null; LatestVersionId: string | null }> = {
  Live_Only: { ActiveVersionId: '301LIVE0000000001AAA', LatestVersionId: '301LIVE0000000002AAA' },
  Live_Latest: { ActiveVersionId: null, LatestVersionId: '301LIVE0000000003AAA' },
};
const LIVE_METADATA: Record<string, Record<string, unknown>> = {
  '301LIVE0000000001AAA': { label: 'Live only, active', status: 'Active', assignments: [{ name: 'One' }] },
  '301LIVE0000000002AAA': { label: 'Live only, latest draft', status: 'Draft' },
  '301LIVE0000000003AAA': { label: 'Live latest', status: 'Draft', screens: [{ name: 'S1' }, { name: 'S2' }] },
};

const records = (rows: unknown[]): Response =>
  new Response(JSON.stringify({ totalSize: rows.length, done: true, records: rows }));

let fetchCalls: string[];

async function stubbedFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url.includes('/services/oauth2/token')) {
    return new Response(
      JSON.stringify({
        access_token: 'AT',
        instance_url: 'https://render.stub.salesforce.com',
        id: 'https://login.salesforce.com/id/00DR/005R',
        token_type: 'Bearer',
      }),
    );
  }
  const q = decodeURIComponent(url);
  if (url.includes('/tooling/query?q=')) {
    const one = /FROM Flow WHERE Definition\.DeveloperName = '([^']+)' AND VersionNumber = (\d+) LIMIT 1/.exec(q);
    if (one) {
      const hit = (VERSIONS[one[1]!] ?? []).find((v) => v.n === Number(one[2]));
      return records(hit ? [{ Id: versionId(one[1]!, hit.n), Status: hit.status }] : []);
    }
    const list =
      /SELECT VersionNumber, Status FROM Flow WHERE Definition\.DeveloperName = '([^']+)' ORDER BY VersionNumber DESC/.exec(
        q,
      );
    if (list) {
      return records(
        [...(VERSIONS[list[1]!] ?? [])]
          .sort((x, y) => y.n - x.n)
          .map((v) => ({ VersionNumber: v.n, Status: v.status })),
      );
    }
    const def = /FROM FlowDefinition WHERE DeveloperName = '([^']+)'/.exec(q);
    if (def) {
      const row = DEFINITIONS[def[1]!];
      return records(row ? [{ Id: '300DEF', ...row, NamespacePrefix: null }] : []);
    }
    const meta = /SELECT Metadata FROM Flow WHERE Id = '([^']+)'/.exec(q);
    if (meta) {
      const body = LIVE_METADATA[meta[1]!];
      return records(body ? [{ Metadata: body }] : []);
    }
    return records([]);
  }
  const record = /\/tooling\/sobjects\/Flow\/([A-Za-z0-9]+)\?/.exec(url);
  if (record) {
    for (const [flow, versions] of Object.entries(VERSIONS)) {
      for (const v of versions) {
        if (versionId(flow, v.n) === record[1]) {
          return new Response(JSON.stringify({ Status: v.status, VersionNumber: v.n, Metadata: v.metadata }));
        }
      }
    }
    return new Response('not found', { status: 404 });
  }
  if (url.includes('/query?q=')) {
    if (q.includes("FROM FlowDefinitionView WHERE ApiName = 'Platform_Flow'")) {
      return records([
        {
          attributes: { type: 'FlowDefinitionView', url: 'x' },
          ApiName: 'Platform_Flow',
          Label: 'Platform Flow',
          ProcessType: 'Flow',
          TriggerType: null,
          IsActive: true,
          NamespacePrefix: null,
          Description: null,
          ActiveVersionId: 'std__Platform_Flow-1',
        },
      ]);
    }
    return records([]);
  }
  return new Response('not found', { status: 404 });
}

// ---- harness ---------------------------------------------------------------

let tmp: string;
let dataDir: string;
let stagingDir: string;
let snapshotsDir: string;
let rendersDir: string;
let outsideDir: string;
let db: ContrailDb;
let store: SnapshotStore;
let tokens: MemoryTokenStore;
let clients: Client[];
let client: Client;
let opened: string[];
let openFails: boolean;
let connA: string;
let connB: string;
let connLocked: string;

function seedConnection(alias: string, orgId: string, metadataRead: boolean): string {
  const grants = emptyGrantSet();
  grants.metadata_read = metadataRead;
  const conn = db.insertConnection({
    alias,
    instanceUrl: 'https://render.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId,
    orgName: alias,
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  return conn.id;
}

function seedFlows(connId: string, flows: Record<string, string | Uint8Array>): void {
  store.writeCurrent(
    connId,
    new Map(
      Object.entries(flows).map(([name, xml]) => [
        `flows/${name}.flow`,
        typeof xml === 'string' ? strToU8(xml) : xml,
      ]),
    ),
  );
  db.replaceArtifactsForTypes(
    connId,
    ['Flow'],
    Object.keys(flows).map((name) => ({
      connectionId: connId,
      type: 'Flow',
      apiName: name,
      filePath: `flows/${name}.flow`,
      contentHash: `h-${name}`,
      lastModifiedDate: null,
      lastModifiedBy: null,
      retrievedAt: RETRIEVED_AT,
    })),
  );
}

function makeDeps(config: ContrailConfig = { ...DEFAULT_CONFIG }): ToolDeps {
  return createDeps({
    db,
    tokens,
    config,
    store,
    // Marker dir and Claude settings file inside the sandbox.
    remoteControl: new RemoteControlProbe({
      root: dataDir,
      claudeSettingsFile: path.join(tmp, 'claude-settings.json'),
    }),
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised in render_flow tests');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised in render_flow tests');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      // Stands in for "ask this computer to open it".
      openBrowser: async (target: string) => {
        if (openFails) throw new Error('no default app for .html files');
        opened.push(target);
      },
    },
  });
}

/** A real server over the in-memory transport. CONTRAIL_SKILLS_DIR is read when the deps are built. */
async function connect(
  opts: { config?: ContrailConfig; adjust?: (deps: ToolDeps) => void } = {},
): Promise<{ client: Client; deps: ToolDeps }> {
  const deps = makeDeps(opts.config);
  opts.adjust?.(deps);
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'render-test', version: '0.0.0' });
  await c.connect(clientTransport);
  clients.push(c);
  return { client: c, deps };
}

beforeEach(async () => {
  // realpath: the tool compares real paths, and a temp dir can sit behind a
  // link (macOS /var).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-render-')));
  dataDir = path.join(tmp, 'data');
  stagingDir = path.join(dataDir, 'staging');
  snapshotsDir = path.join(dataDir, 'snapshots');
  rendersDir = path.join(dataDir, 'renders');
  outsideDir = path.join(tmp, 'outside');
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  process.env.CONTRAIL_DATA_DIR = dataDir;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  // The snapshot store sits where snapshotsDir() says, as it does in a real install.
  store = new SnapshotStore(snapshotsDir);
  tokens = new MemoryTokenStore();
  clients = [];
  opened = [];
  openFails = false;
  fetchCalls = [];
  vi.stubGlobal('fetch', stubbedFetch);

  connA = seedConnection('org-a', '00DA', true);
  connB = seedConnection('org-b', '00DB', true);
  connLocked = seedConnection('locked', '00DL', false);
  seedFlows(connA, {
    Send_Invoice: SEND_INVOICE_FLOW_XML,
    Active_Flow: flowWithStatus('Active flow', 'Active'),
    Draft_Flow: flowWithStatus('Draft flow', 'Draft'),
  });
  seedFlows(connB, { Send_Invoice: SEND_INVOICE_B });
  seedFlows(connLocked, { Send_Invoice: SEND_INVOICE_FLOW_XML });

  ({ client } = await connect());
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const c of clients) await c.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  delete process.env.CONTRAIL_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type CallResult = Awaited<ReturnType<Client['callTool']>>;

interface SideEntry {
  side: 'a' | 'b';
  label: string;
  origin: 'snapshot' | 'tooling_version' | 'tooling_fallback' | 'file';
  connection?: string;
  flow?: string;
  version?: number;
  status?: string | null;
  retrieved_at?: string | null;
  file?: string;
  sha256?: string;
  bytes: number;
  elements: number | null;
  over_diagram_limit: boolean;
}

interface Payload {
  file: string;
  file_url: string;
  mode: 'single' | 'diff';
  title: string;
  opened: boolean;
  sides: SideEntry[];
  fidelity?: 'like_for_like' | 'mixed' | 'unknown';
  notes: string[];
  page_bytes: number;
  remote_control?: { state: string; at: string };
  retention: string;
  note: string;
}

function textOf(result: CallResult): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

async function call(args: Record<string, unknown>, on: Client = client): Promise<CallResult> {
  return on.callTool({ name: 'render_flow', arguments: args });
}

/** A call that must succeed: its prefix line and its payload. */
async function render(
  args: Record<string, unknown>,
  on: Client = client,
): Promise<{ prefix: string; payload: Payload }> {
  const result = await call(args, on);
  const text = textOf(result);
  expect(result.isError, text).toBeFalsy();
  const cut = text.indexOf('\n');
  return { prefix: text.slice(0, cut), payload: JSON.parse(text.slice(cut + 1)) as Payload };
}

/** A call that must be refused: the refusal text. The call may not write, open or record a page. */
async function refused(args: Record<string, unknown>, on: Client = client): Promise<string> {
  const before = { pages: pages(), opened: [...opened], rendered: auditRows('flow.rendered').length };
  const result = await call(args, on);
  const text = textOf(result);
  expect(result.isError, text).toBe(true);
  expect(pages()).toEqual(before.pages);
  expect(opened).toEqual(before.opened);
  expect(auditRows('flow.rendered')).toHaveLength(before.rendered);
  return text;
}

/** The files in renders/, or [] when the folder does not exist. */
function pages(): string[] {
  return fs.existsSync(rendersDir) ? fs.readdirSync(rendersDir).sort() : [];
}

function auditRows(eventType?: string): AuditEvent[] {
  const rows = db.queryAuditEvents({ limit: 1000 });
  return eventType ? rows.filter((e) => e.eventType === eventType) : rows;
}

/** What the page embeds: the two flow literals and META, parsed. */
function embedded(file: string): {
  page: string;
  a: string;
  b: string | null;
  meta: { aLabel: string; bLabel?: string; subtitle?: string; note?: string };
} {
  const page = fs.readFileSync(file, 'utf8');
  const pick = (name: string): unknown => {
    const m = new RegExp(`^const ${name} = (.*);$`, 'm').exec(page);
    expect(m, `the ${name} line`).not.toBeNull();
    return JSON.parse(m![1]!) as unknown;
  };
  return {
    page,
    a: pick('FLOW_A_XML') as string,
    b: pick('FLOW_B_XML') as string | null,
    meta: pick('META') as { aLabel: string; bLabel?: string; subtitle?: string; note?: string },
  };
}

function stage(name: string, content: string | Buffer): string {
  const file = path.join(stagingDir, ...name.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Make a link; false where this account may not (Windows without the symlink privilege). */
function tryLink(target: string, link: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

/** Set a file's mtime to `days` days ago. */
function age(file: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, when, when);
}

function writePage(dir: string, name: string, days: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '<!doctype html><title>old page</title>');
  age(file, days);
  return file;
}

const snapshotNote = (heading: string, alias: string, statusText: string, tail: string): string =>
  `${heading}: snapshot of "${alias}" retrieved ${RETRIEVED_TEXT} UTC; the org may have changed since. ` +
  `The snapshot holds the flow's latest version (${statusText})${tail}`;

// ---- the tool surface -------------------------------------------------------

describe('render_flow: the tool surface', () => {
  it('is listed after the skill tools, with its title, description and arguments, verbatim', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'render_flow')!;
    expect(tool.title).toBe('Render a flow diagram or flow diff page');
    expect(tool.description).toBe(DESCRIPTION);
    expect(Buffer.byteLength(DESCRIPTION, 'utf8')).toBe(1759);
    expect(/^[\x20-\x7e]*$/.test(DESCRIPTION)).toBe(true);
    // Appended after the skill tools, so the earlier tools/list order is unchanged.
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe('connect_org');
    expect(names.indexOf('render_flow')).toBe(names.indexOf('read_skill') + 1);

    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
      'flow',
      'connection',
      'version',
      'file',
      'label',
      'connection_b',
      'flow_b',
      'version_b',
      'file_b',
      'label_b',
      'title',
      'open',
    ]);
    // Every argument is optional: the shape rules are refusals with their own text.
    expect(tool.inputSchema.required ?? []).toEqual([]);
    const described = Object.fromEntries(
      Object.entries(tool.inputSchema.properties ?? {}).map(([name, schema]) => [
        name,
        (schema as { description?: string }).description,
      ]),
    );
    expect(described).toEqual({
      flow:
        'Flow API name (DeveloperName), for example Send_Invoice. Used for both sides unless flow_b is given. ' +
        'Required whenever a side reads from a connection.',
      connection: 'Side A: connection alias (or id) to read the flow from.',
      version:
        'Side A: a historical version - a version number, or "active" / "latest". Omit for the snapshot copy. ' +
        'Needs connection.',
      file:
        "Side A instead of a connection: absolute path of a saved flow XML file under Contrail's staging " +
        'directory (list_connections returns staging_dir).',
      label:
        'Side A pane heading (default: the connection alias, plus the version when one is given; or the file ' +
        'name).',
      connection_b:
        "Side B: connection alias (or id). Omit to reuse side A's connection when version_b or flow_b is given.",
      flow_b: 'Side B: a different flow API name (default: flow).',
      version_b: 'Side B: a version number, or "active" / "latest". Omit for the snapshot copy.',
      file_b:
        "Side B instead of a connection: absolute path of a saved flow XML file under Contrail's staging " +
        'directory.',
      label_b: 'Side B pane heading.',
      title: 'Page title (default: the flow name and the pane headings).',
      open:
        'Ask this computer to open the page in its default app for .html files (default true). Pass false when ' +
        'the human is not at this computer.',
    });
    expect(tool.inputSchema.properties).toMatchObject({
      label: { type: 'string', maxLength: 80 },
      label_b: { type: 'string', maxLength: 80 },
      title: { type: 'string', maxLength: 120 },
      open: { type: 'boolean' },
    });
  });

  it('is gated on metadata_read and mints no code, so it is not sampled for Remote Control', async () => {
    expect(TOOL_GRANT_MAP).toHaveProperty('render_flow', 'metadata_read');
    expect(RC_HOOKED_TOOLS).not.toContain('render_flow');
    const { client: c, deps } = await connect();
    const run = vi.spyOn(deps.remoteControl, 'run');
    await render({ connection: 'org-a', flow: 'Send_Invoice', open: false }, c);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an argument of the wrong shape before the handler runs', async () => {
    for (const bad of [
      { connection: 'org-a', flow: 'Order_Router', version: 0 },
      { connection: 'org-a', flow: 'Order_Router', version: 1.5 },
      { connection: 'org-a', flow: 'Order_Router', version: 'newest' },
      { connection: 'org-a', flow: 'Send_Invoice', label: 'x'.repeat(81) },
      { connection: 'org-a', flow: 'Send_Invoice', title: 'x'.repeat(121) },
      { connection: 'org-a', flow: 'Send_Invoice', open: 'no' },
    ]) {
      // The SDK validates the schema: an error result or a protocol error, never a page.
      let isError = false;
      try {
        isError = (await call(bad)).isError === true;
      } catch {
        isError = true;
      }
      expect(isError, JSON.stringify(bad)).toBe(true);
      expect(pages()).toEqual([]);
    }
  });
});

// ---- a snapshot side --------------------------------------------------------

describe('render_flow: one flow from a snapshot', () => {
  it('writes the page under renders/, asks this computer to open it, and says where the side came from', async () => {
    const { prefix, payload } = await render({ connection: 'org-a', flow: 'Send_Invoice' });
    expect(prefix).toBe(PREFIX_OPENED);

    // The file: under <data>/renders/, named for the flow and the mode.
    expect(path.dirname(payload.file)).toBe(rendersDir);
    expect(path.basename(payload.file)).toMatch(/^Send_Invoice-view-\d{8}-\d{6}Z-[0-9a-f]{4}\.html$/);
    expect(fs.existsSync(payload.file)).toBe(true);
    expect(pages()).toEqual([path.basename(payload.file)]);
    expect(payload.file_url).toBe(pathToFileURL(payload.file).href);
    expect(payload.page_bytes).toBe(fs.statSync(payload.file).size);

    // The opener was called once, with that path.
    expect(opened).toEqual([payload.file]);
    expect(payload.opened).toBe(true);

    expect(Object.keys(payload)).toEqual([
      'file',
      'file_url',
      'mode',
      'title',
      'opened',
      'sides',
      'notes',
      'page_bytes',
      'retention',
      'note',
    ]);
    expect(payload.mode).toBe('single');
    expect(payload.title).toBe('Send_Invoice — org-a');
    expect(payload.sides).toEqual([
      {
        side: 'a',
        label: 'org-a',
        origin: 'snapshot',
        connection: 'org-a',
        flow: 'Send_Invoice',
        status: null,
        retrieved_at: RETRIEVED_AT,
        bytes: Buffer.byteLength(SEND_INVOICE_FLOW_XML, 'utf8'),
        elements: 4,
        over_diagram_limit: false,
      },
    ]);
    // N1, then N8.
    expect(payload.notes).toHaveLength(2);
    expect(payload.notes[0]).toBe(snapshotNote('org-a', 'org-a', 'its XML carries no status', HINT));
    expect(payload.notes[1]).toMatch(BUILT_RE);
    expect(payload.retention).toBe(RETENTION);
    expect(payload.note).toBe(PUBLISH_NOTE);

    // The page: the template, filled, with the XML exactly as the snapshot holds it.
    const { page, a, b, meta } = embedded(payload.file);
    expect(page.startsWith('<!doctype html>\n<meta charset="utf-8">\n')).toBe(true);
    expect(page).toContain('<title>Send_Invoice — org-a</title>');
    expect(a).toBe(SEND_INVOICE_FLOW_XML);
    expect(b).toBeNull();
    expect(meta).toEqual({
      aLabel: 'org-a',
      subtitle: `"org-a" snapshot (${RETRIEVED_TEXT} UTC)`,
      note: payload.notes.join(' '),
    });
    // A snapshot read touches no network.
    expect(fetchCalls).toEqual([]);
  });

  it('label and title replace the defaults, on the page and in the notes', async () => {
    const { payload } = await render({
      connection: 'org-a',
      flow: 'Send_Invoice',
      label: 'UAT today',
      title: 'Invoice flow <review>',
      open: false,
    });
    expect(payload.title).toBe('Invoice flow <review>');
    expect(payload.sides[0]!.label).toBe('UAT today');
    expect(payload.notes[0]!.startsWith('UAT today: snapshot of "org-a" retrieved')).toBe(true);
    const { page, meta } = embedded(payload.file);
    expect(page).toContain('<title>Invoice flow &lt;review&gt;</title>');
    expect(meta.aLabel).toBe('UAT today');
  });

  it('accepts a connection id in place of the alias, and a flow name in any case', async () => {
    const { payload } = await render({ connection: connA, flow: 'send_invoice', open: false });
    expect(payload.sides[0]).toMatchObject({ origin: 'snapshot', connection: 'org-a', flow: 'send_invoice' });
    expect(embedded(payload.file).a).toBe(SEND_INVOICE_FLOW_XML);
  });

  it('a Draft snapshot says so and points at version: "active"', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Draft_Flow', open: false });
    expect(payload.sides[0]!.status).toBe('Draft');
    expect(payload.notes[0]).toBe(snapshotNote('org-a', 'org-a', 'its status reads Draft', HINT));
    expect(payload.notes[0]).toContain('status reads Draft');
    expect(payload.notes[0]).toContain('Pass version: "active"');
    expect(embedded(payload.file).meta.note).toContain('Pass version: "active" to draw the version that runs.');
  });

  it('an Active snapshot ends at the parenthesis, with no hint', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Active_Flow', open: false });
    expect(payload.sides[0]!.status).toBe('Active');
    expect(payload.notes[0]).toBe(snapshotNote('org-a', 'org-a', 'its status reads Active', '.'));
    expect(payload.notes[0]!.endsWith("latest version (its status reads Active).")).toBe(true);
    expect(payload.notes.join(' ')).not.toContain('Pass version');
  });

  it('a snapshot with no top-level <status> says its XML carries none, with the hint', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(payload.sides[0]!.status).toBeNull();
    expect(payload.notes[0]).toContain('(its XML carries no status)');
    expect(payload.notes[0]!.endsWith(HINT)).toBe(true);
  });

  it("reads the flow's own status, never an element's", async () => {
    // The only <status> sits inside an element: the flow itself carries none.
    seedFlows(connA, {
      Nested_Status: '<Flow><decisions><name>D</name><status>Active</status></decisions><label>x</label></Flow>',
    });
    const { payload } = await render({ connection: 'org-a', flow: 'Nested_Status', open: false });
    expect(payload.sides[0]!.status).toBeNull();
  });
});

// ---- opening ---------------------------------------------------------------

describe('render_flow: opening the page', () => {
  it('open: false writes the page and does not call the opener', async () => {
    const { prefix, payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(prefix).toBe(PREFIX_NOT_OPENED);
    expect(payload.opened).toBe(false);
    expect(opened).toEqual([]);
    expect(fs.existsSync(payload.file)).toBe(true);
  });

  it('an opener that throws gives opened: false, and the page is still written', async () => {
    openFails = true;
    const { prefix, payload } = await render({ connection: 'org-a', flow: 'Send_Invoice' });
    expect(prefix).toBe(PREFIX_OPEN_FAILED);
    expect(payload.opened).toBe(false);
    expect(fs.existsSync(payload.file)).toBe(true);
    expect(auditRows('flow.rendered')[0]!.detail).toMatchObject({ open_requested: true, opened: false });
  });

  it('open: true is the default', async () => {
    const { prefix } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: true });
    expect(prefix).toBe(PREFIX_OPENED);
    expect(opened).toHaveLength(1);
  });
});

// ---- two connections --------------------------------------------------------

describe('render_flow: a flow across two orgs', () => {
  it('two snapshot copies compare like for like', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', connection_b: 'org-b' });
    expect(payload.mode).toBe('diff');
    expect(payload.fidelity).toBe('like_for_like');
    expect(payload.title).toBe('Send_Invoice — org-a vs org-b (diff)');
    expect(path.basename(payload.file)).toMatch(/^Send_Invoice-diff-\d{8}-\d{6}Z-[0-9a-f]{4}\.html$/);
    expect(payload.sides.map((s) => [s.side, s.label, s.origin, s.connection])).toEqual([
      ['a', 'org-a', 'snapshot', 'org-a'],
      ['b', 'org-b', 'snapshot', 'org-b'],
    ]);
    // One note per side, then N8: no fidelity warning for like for like.
    expect(payload.notes).toHaveLength(3);
    expect(payload.notes[0]!.startsWith('org-a: snapshot of "org-a"')).toBe(true);
    expect(payload.notes[1]!.startsWith('org-b: snapshot of "org-b"')).toBe(true);
    expect(payload.notes[2]).toMatch(BUILT_RE);

    const { a, b, meta } = embedded(payload.file);
    expect(a).toBe(SEND_INVOICE_FLOW_XML);
    expect(b).toBe(SEND_INVOICE_B);
    expect(meta).toEqual({
      aLabel: 'org-a',
      bLabel: 'org-b',
      subtitle: `"org-a" snapshot (${RETRIEVED_TEXT} UTC) → "org-b" snapshot (${RETRIEVED_TEXT} UTC)`,
      note: payload.notes.join(' '),
    });
  });

  it('flow_b compares two different flows, here inside one org', async () => {
    const { payload } = await render({
      connection: 'org-a',
      flow: 'Active_Flow',
      flow_b: 'Draft_Flow',
      label: 'active one',
      label_b: 'draft one',
      open: false,
    });
    expect(payload.mode).toBe('diff');
    expect(payload.fidelity).toBe('like_for_like');
    expect(payload.title).toBe('Active_Flow — active one vs draft one (diff)');
    expect(payload.sides.map((s) => [s.connection, s.flow, s.label, s.status])).toEqual([
      ['org-a', 'Active_Flow', 'active one', 'Active'],
      ['org-a', 'Draft_Flow', 'draft one', 'Draft'],
    ]);
  });

  for (const [which, args] of [
    ['side B', { connection: 'org-a', flow: 'Send_Invoice', connection_b: 'locked' }],
    ['side A', { connection: 'locked', flow: 'Send_Invoice', connection_b: 'org-a' }],
    ['the only side', { connection: 'locked', flow: 'Send_Invoice' }],
  ] as const) {
    it(`a connection without metadata_read on ${which} is refused, with one audited refusal and nothing written`, async () => {
      const text = await refused(args);
      expect(text).toBe(
        'Connection "locked" does not hold the "metadata_read" grant required by render_flow. Grants are set ' +
          'by a human on the connection management page — call manage_connection to open it. Do not retry ' +
          'without the grant.',
      );
      const rows = auditRows('grant.refused');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        connectionId: connLocked,
        tool: 'render_flow',
        outcome: 'refused',
        detail: { required: 'metadata_read' },
      });
      expect(fs.existsSync(rendersDir)).toBe(false);
    });
  }

  it('both grants are checked before any read: no org call is made for the side that holds one', async () => {
    // Side A would need the Tooling API; side B lacks the grant.
    await refused({ connection: 'org-a', flow: 'Order_Router', version: 12, connection_b: 'locked' });
    expect(fetchCalls).toEqual([]);
  });

  it('an unknown connection is refused by name', async () => {
    expect(await refused({ connection: 'nowhere', flow: 'Send_Invoice' })).toBe(
      'No connection matches "nowhere". Call list_connections to see what is connected, or connect_org to add one.',
    );
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', connection_b: 'nowhere-b' })).toContain(
      'No connection matches "nowhere-b".',
    );
  });
});

// ---- versions ---------------------------------------------------------------

describe('render_flow: historical versions through the Tooling API', () => {
  const n2 = (heading: string, n: number, status: string): string =>
    `${heading}: version ${n} (${status}) of Order_Router on "org-a", converted from the Tooling API's JSON - ` +
    'faithful for reading and diffing, element order alphabetical, not deploy-ready.';

  it('a version number is read, converted and described', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Order_Router', version: 12, open: false });
    expect(payload.mode).toBe('single');
    expect(payload.title).toBe('Order_Router — org-a · v12');
    expect(payload.sides).toEqual([
      {
        side: 'a',
        label: 'org-a · v12',
        origin: 'tooling_version',
        connection: 'org-a',
        flow: 'Order_Router',
        version: 12,
        status: 'Obsolete',
        bytes: payload.sides[0]!.bytes,
        elements: 2,
        over_diagram_limit: false,
      },
    ]);
    expect(payload.notes[0]).toBe(n2('org-a · v12', 12, 'Obsolete'));
    expect(payload.notes[1]).toMatch(BUILT_RE);

    const { a, meta } = embedded(payload.file);
    expect(a.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">')).toBe(true);
    expect(a).toContain('<label>Order Router v12</label>');
    expect(payload.sides[0]!.bytes).toBe(Buffer.byteLength(a, 'utf8'));
    expect(meta.subtitle).toBe('"org-a" version 12 (Obsolete)');
  });

  it('"latest" is the highest version number, whatever its status', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Order_Router', version: 'latest', open: false });
    expect(payload.sides[0]).toMatchObject({ origin: 'tooling_version', version: 14, status: 'Draft', label: 'org-a · v14' });
    expect(payload.notes[0]).toBe(n2('org-a · v14', 14, 'Draft'));
    expect(embedded(payload.file).a).toContain('<label>Order Router v14</label>');
  });

  it('"active" is the version whose Status is Active', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Order_Router', version: 'active', open: false });
    expect(payload.sides[0]).toMatchObject({ origin: 'tooling_version', version: 13, status: 'Active', label: 'org-a · v13' });
    expect(payload.notes[0]).toBe(n2('org-a · v13', 13, 'Active'));
    expect(embedded(payload.file).a).toContain('<label>Order Router v13</label>');
  });

  it('"active" with no active version is refused, listing the versions there are', async () => {
    expect(await refused({ connection: 'org-a', flow: 'Draft_Only', version: 'active' })).toBe(
      'Flow Draft_Only has no active version on "org-a" (versions: 2 (Draft), 1 (Obsolete)). Pass a version ' +
        'number or "latest". Nothing was written.',
    );
  });

  it('a version that does not exist passes the Tooling read\'s own not-found text through', async () => {
    expect(await refused({ connection: 'org-a', flow: 'Order_Router', version: 7 })).toBe(
      'Flow Order_Router has no version 7 on "org-a" — available: 14 (Draft), 13 (Active), 12 (Obsolete).',
    );
    expect(await refused({ connection: 'org-a', flow: 'Unknown_Flow', version: 3 })).toBe(
      'No flow named Unknown_Flow is visible to the Tooling API on "org-a".',
    );
    expect(await refused({ connection: 'org-a', flow: 'Unknown_Flow', version: 'latest' })).toBe(
      'No flow named Unknown_Flow is visible to the Tooling API on "org-a".',
    );
    expect(await refused({ connection: 'org-a', flow: 'Unknown_Flow', version: 'active' })).toBe(
      'No flow named Unknown_Flow is visible to the Tooling API on "org-a".',
    );
  });

  it('version against version in one org compares like for like, reusing side A\'s connection', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Order_Router', version: 12, version_b: 13 });
    expect(payload.mode).toBe('diff');
    expect(payload.fidelity).toBe('like_for_like');
    expect(payload.title).toBe('Order_Router — org-a · v12 vs org-a · v13 (diff)');
    expect(payload.sides.map((s) => [s.side, s.connection, s.origin, s.version, s.status])).toEqual([
      ['a', 'org-a', 'tooling_version', 12, 'Obsolete'],
      ['b', 'org-a', 'tooling_version', 13, 'Active'],
    ]);
    expect(payload.notes).toHaveLength(3);
    expect(payload.notes[0]).toBe(n2('org-a · v12', 12, 'Obsolete'));
    expect(payload.notes[1]).toBe(n2('org-a · v13', 13, 'Active'));
    expect(embedded(payload.file).meta.subtitle).toBe('"org-a" version 12 (Obsolete) → "org-a" version 13 (Active)');
  });

  it('a version against "latest" is like for like too', async () => {
    const { payload } = await render({
      connection: 'org-a',
      flow: 'Order_Router',
      version: 12,
      version_b: 'latest',
      open: false,
    });
    expect(payload.fidelity).toBe('like_for_like');
    expect(payload.sides.map((s) => s.version)).toEqual([12, 14]);
  });

  it('a version against a snapshot is a mixed comparison, and both the result and the page say so', async () => {
    seedFlows(connA, { Order_Router: flowWithStatus('Order Router (snapshot)', 'Draft') });
    const { payload } = await render({ connection: 'org-a', flow: 'Order_Router', version: 12, connection_b: 'org-a' });
    expect(payload.fidelity).toBe('mixed');
    expect(payload.sides.map((s) => s.origin)).toEqual(['tooling_version', 'snapshot']);
    expect(payload.notes).toHaveLength(4);
    expect(payload.notes[2]).toBe(N5_MIXED);
    expect(payload.notes).not.toContain(N6_FILE);
    const { meta } = embedded(payload.file);
    expect(meta.note).toContain(N5_MIXED);
    expect(meta.note).toBe(payload.notes.join(' '));
    expect(meta.subtitle).toBe(`"org-a" version 12 (Obsolete) → "org-a" snapshot (${RETRIEVED_TEXT} UTC)`);
  });

  it('a snapshot against a version is mixed the other way round', async () => {
    seedFlows(connA, { Order_Router: flowWithStatus('Order Router (snapshot)', 'Active') });
    const { payload } = await render({
      connection: 'org-a',
      flow: 'Order_Router',
      version_b: 'active',
      open: false,
    });
    expect(payload.fidelity).toBe('mixed');
    expect(payload.sides.map((s) => s.origin)).toEqual(['snapshot', 'tooling_version']);
    expect(payload.notes).toContain(N5_MIXED);
  });
});

// ---- the live fallback ------------------------------------------------------

describe('render_flow: a flow the snapshot does not hold', () => {
  it('is read live from the Tooling API: its active version when it has one', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Live_Only', open: false });
    expect(payload.sides).toEqual([
      {
        side: 'a',
        label: 'org-a · active (live)',
        origin: 'tooling_fallback',
        connection: 'org-a',
        flow: 'Live_Only',
        bytes: payload.sides[0]!.bytes,
        elements: 2,
        over_diagram_limit: false,
      },
    ]);
    expect(payload.title).toBe('Live_Only — org-a · active (live)');
    expect(payload.notes[0]).toBe(
      'org-a · active (live): Live_Only is not in the snapshot of "org-a"; this is its active version, read ' +
        'live from the Tooling API and converted from JSON (element order alphabetical, not deploy-ready).',
    );
    const { a, meta } = embedded(payload.file);
    expect(a).toContain('<label>Live only, active</label>');
    expect(meta.subtitle).toBe('"org-a" active version, read live');
  });

  it('else its latest version', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Live_Latest', open: false });
    expect(payload.sides[0]).toMatchObject({ origin: 'tooling_fallback', label: 'org-a · latest (live)', elements: 3 });
    expect(payload.notes[0]).toBe(
      'org-a · latest (live): Live_Latest is not in the snapshot of "org-a"; this is its latest version, read ' +
        'live from the Tooling API and converted from JSON (element order alphabetical, not deploy-ready).',
    );
    expect(embedded(payload.file).meta.subtitle).toBe('"org-a" latest version, read live');
  });

  it('a live fallback against a snapshot is mixed; against a version it is like for like', async () => {
    const mixed = await render({ connection: 'org-a', flow: 'Live_Only', connection_b: 'org-b', flow_b: 'Send_Invoice', open: false });
    expect(mixed.payload.fidelity).toBe('mixed');
    expect(mixed.payload.notes).toContain(N5_MIXED);
    const alike = await render({ connection: 'org-a', flow: 'Live_Only', flow_b: 'Order_Router', version_b: 12, open: false });
    expect(alike.payload.fidelity).toBe('like_for_like');
    expect(alike.payload.notes).not.toContain(N5_MIXED);
  });

  it('a flow with only a descriptor is refused, not drawn', async () => {
    expect(await refused({ connection: 'org-a', flow: 'Platform_Flow' })).toBe(
      'Flow Platform_Flow on "org-a" is platform/feature-delivered: Salesforce exposes only a descriptor for ' +
        'it (identity, type, active status) and no API returns its definition, so there is nothing to draw. ' +
        'Nothing was written.',
    );
  });

  it('a flow no source knows is refused', async () => {
    expect(await refused({ connection: 'org-a', flow: 'Nowhere_Flow' })).toBe(
      'Flow Nowhere_Flow was not found on "org-a" - not in the snapshot, the Tooling API, or ' +
        'FlowDefinitionView. Check the name with list_metadata (type Flow, live=true), or run ' +
        'refresh_snapshot. Nothing was written.',
    );
  });
});

// ---- a saved file -----------------------------------------------------------

describe('render_flow: a saved file', () => {
  it('a file under staging is drawn as a file: no connection, no grant, its sha256 on record', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    const { payload } = await render({ file });
    expect(payload.mode).toBe('single');
    expect(payload.title).toBe('before.flow');
    expect(path.basename(payload.file)).toMatch(/^before-view-\d{8}-\d{6}Z-[0-9a-f]{4}\.html$/);
    expect(payload.sides).toEqual([
      {
        side: 'a',
        label: 'before.flow',
        origin: 'file',
        file,
        sha256: sha256(SEND_INVOICE_FLOW_XML),
        bytes: Buffer.byteLength(SEND_INVOICE_FLOW_XML, 'utf8'),
        elements: 4,
        over_diagram_limit: false,
      },
    ]);
    expect(payload.notes[0]).toBe(
      `before.flow: saved file before.flow (sha256 ${sha256(SEND_INVOICE_FLOW_XML).slice(0, 12)}); Contrail did ` +
        'not read this side from an org.',
    );
    const { a, meta } = embedded(payload.file);
    expect(a).toBe(SEND_INVOICE_FLOW_XML);
    expect(meta.subtitle).toBe('file before.flow');
    // No grant was consulted and nothing was refused.
    expect(auditRows('grant.refused')).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it('flow names the page when a file side is given one', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    const { payload } = await render({ file, flow: 'Send_Invoice', open: false });
    expect(payload.title).toBe('Send_Invoice — before.flow');
    expect(path.basename(payload.file)).toMatch(/^Send_Invoice-view-/);
  });

  it('before/after: a saved file against a connection is fidelity unknown, and says why', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    const { payload } = await render({ file, connection_b: 'org-b', flow: 'Send_Invoice' });
    expect(payload.mode).toBe('diff');
    expect(payload.fidelity).toBe('unknown');
    expect(payload.title).toBe('Send_Invoice — before.flow vs org-b (diff)');
    expect(payload.sides.map((s) => [s.side, s.origin, s.label])).toEqual([
      ['a', 'file', 'before.flow'],
      ['b', 'snapshot', 'org-b'],
    ]);
    expect(payload.notes).toHaveLength(4);
    expect(payload.notes[0]!.startsWith('before.flow: saved file before.flow (sha256 ')).toBe(true);
    expect(payload.notes[1]!.startsWith('org-b: snapshot of "org-b"')).toBe(true);
    expect(payload.notes[2]).toBe(N6_FILE);
    expect(payload.notes).not.toContain(N5_MIXED);
    const { a, b, meta } = embedded(payload.file);
    expect(a).toBe(SEND_INVOICE_FLOW_XML);
    expect(b).toBe(SEND_INVOICE_B);
    expect(meta.note).toContain(N6_FILE);
    expect(meta.subtitle).toBe(`file before.flow → "org-b" snapshot (${RETRIEVED_TEXT} UTC)`);
  });

  it('a connection against a staged edit, and two files, are fidelity unknown as well', async () => {
    const edit = stage('edit/Send_Invoice.flow-meta.xml', SEND_INVOICE_B);
    const one = await render({ connection: 'org-a', flow: 'Send_Invoice', file_b: edit, open: false });
    expect(one.payload.fidelity).toBe('unknown');
    expect(one.payload.sides.map((s) => s.origin)).toEqual(['snapshot', 'file']);
    expect(one.payload.sides[1]!.label).toBe('Send_Invoice.flow-meta.xml');
    expect(one.payload.notes).toContain(N6_FILE);

    const before = stage('before.flow', SEND_INVOICE_FLOW_XML);
    const two = await render({ file: before, file_b: edit, open: false });
    expect(two.payload.fidelity).toBe('unknown');
    expect(two.payload.title).toBe('before.flow vs Send_Invoice.flow-meta.xml (diff)');
    expect(path.basename(two.payload.file)).toMatch(/^before-diff-/);
    expect(two.payload.sides.map((s) => s.origin)).toEqual(['file', 'file']);
  });

  it('a file under a root the human configured is read too, and the refusal lists every root', async () => {
    const extra = path.join(tmp, 'extra-root');
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(extra, 'saved.flow'), SEND_INVOICE_FLOW_XML);
    const config: ContrailConfig = {
      ...DEFAULT_CONFIG,
      deploy: { ...DEFAULT_CONFIG.deploy, allowedSourceRoots: [extra, 'relative/root'] },
    };
    const { client: c } = await connect({ config });
    const { payload } = await render({ file: path.join(extra, 'saved.flow'), open: false }, c);
    expect(payload.sides[0]).toMatchObject({ origin: 'file', file: path.join(extra, 'saved.flow') });
    // A relative entry is not a root.
    expect(await refused({ file: path.join(outsideDir, 'x.flow') }, c)).toBe(
      `file is outside the folders render_flow reads saved XML from (${stagingDir}, ${extra}). Copy the file ` +
        `into ${stagingDir} and pass that path.`,
    );
  });

  it('a byte-order mark is dropped before the XML is checked and embedded', async () => {
    const withBom = `${BOM}${SEND_INVOICE_FLOW_XML}`;
    const file = stage('bom.flow', withBom);
    expect(fs.readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const { payload } = await render({ file, open: false });
    const { a } = embedded(payload.file);
    expect(a.charCodeAt(0)).not.toBe(0xfeff);
    expect(a.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(a).toBe(SEND_INVOICE_FLOW_XML);
    // The size and the hash are of the file as it is on disk.
    expect(payload.sides[0]!.bytes).toBe(Buffer.byteLength(withBom, 'utf8'));
    expect(payload.sides[0]!.sha256).toBe(sha256(withBom));
  });

  it('a file of exactly 5,000,000 bytes is within the limit', async () => {
    const head = '<Flow><label>padded</label>';
    const tail = '</Flow>';
    const xml = head + ' '.repeat(5_000_000 - head.length - tail.length) + tail;
    const file = stage('limit.flow', xml);
    expect(fs.statSync(file).size).toBe(5_000_000);
    const { payload } = await render({ file, open: false });
    expect(payload.sides[0]!.bytes).toBe(5_000_000);
  });
});

describe('render_flow: file refusals', () => {
  it('R11: a relative path', async () => {
    expect(await refused({ file: 'staging/before.flow' })).toBe(
      `file must be an absolute path (got "staging/before.flow"). Save the XML under ${stagingDir} and pass ` +
        'that full path.',
    );
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: 'edit.flow' })).toBe(
      `file_b must be an absolute path (got "edit.flow"). Save the XML under ${stagingDir} and pass that full path.`,
    );
    expect(await refused({ file: '' })).toBe(
      `file must be an absolute path (got ""). Save the XML under ${stagingDir} and pass that full path.`,
    );
  });

  it('R12: a path inside staging that does not exist', async () => {
    const missing = path.join(stagingDir, 'never-written.flow');
    expect(await refused({ file: missing })).toBe(`file does not exist: ${missing}`);
    const missingB = path.join(stagingDir, 'sub', 'never.flow');
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: missingB })).toBe(
      `file_b does not exist: ${missingB}`,
    );
  });

  it('R13: a path under the snapshot folder', async () => {
    const inSnapshot = store.currentFilePath(connA, 'flows/Send_Invoice.flow')!;
    expect(fs.existsSync(inSnapshot)).toBe(true);
    const R13 =
      "file points inside Contrail's snapshot folder. Name the org instead - connection + flow - so the read " +
      "goes through that connection's metadata_read grant.";
    expect(await refused({ file: inSnapshot })).toBe(R13);
    // The same text for a snapshot path that does not exist, and for the folder itself.
    expect(await refused({ file: path.join(snapshotsDir, 'no-such-connection', 'x.flow') })).toBe(R13);
    expect(await refused({ file: snapshotsDir })).toBe(R13);
    // A locked connection's snapshot is not readable this way either.
    expect(await refused({ file: store.currentFilePath(connLocked, 'flows/Send_Invoice.flow')! })).toBe(R13);
  });

  it('R14: a path outside the folders render_flow reads', async () => {
    const outside = path.join(outsideDir, 'saved.flow');
    fs.writeFileSync(outside, SEND_INVOICE_FLOW_XML);
    const R14 = (arg: string): string =>
      `${arg} is outside the folders render_flow reads saved XML from (${stagingDir}). Copy the file into ` +
      `${stagingDir} and pass that path.`;
    expect(await refused({ file: outside })).toBe(R14('file'));
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: outside })).toBe(R14('file_b'));
    // Leaving staging with ".." is outside; so are the staging folder itself and a sibling whose name starts the same.
    expect(await refused({ file: path.join(stagingDir, '..', '..', 'outside', 'saved.flow') })).toBe(R14('file'));
    expect(await refused({ file: stagingDir })).toBe(R14('file'));
    fs.mkdirSync(`${stagingDir}-other`);
    fs.writeFileSync(path.join(`${stagingDir}-other`, 'saved.flow'), SEND_INVOICE_FLOW_XML);
    expect(await refused({ file: path.join(`${stagingDir}-other`, 'saved.flow') })).toBe(R14('file'));
    // The renders folder is not a source either.
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    const result = await call({ file: payload.file });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(R14('file'));
  });

  it('R15: a file over 5,000,000 bytes inside staging is refused on its size, without being read', async () => {
    const file = stage('huge.flow', Buffer.alloc(5_000_001, 0x20));
    const read = vi.spyOn(fs, 'readFileSync');
    expect(await refused({ file })).toBe(
      "Side A (file huge.flow) is 5000001 bytes; render_flow's limit per side is 5000000. Nothing was written.",
    );
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: file })).toBe(
      "Side B (file huge.flow) is 5000001 bytes; render_flow's limit per side is 5000000. Nothing was written.",
    );
    // The size comes from stat: a multi-gigabyte file under staging is never
    // brought into memory to be measured.
    const readsOf = (name: string): string[] =>
      read.mock.calls.map((args) => String(args[0])).filter((p) => p.toLowerCase().includes(name));
    expect(readsOf('huge.flow')).toEqual([]);
    // The spy does see a file side being read: one within the limit is read once.
    const small = stage('small.flow', SEND_INVOICE_FLOW_XML);
    await render({ file: small, open: false });
    expect(readsOf('small.flow')).toHaveLength(1);
  });

  it('R15 applies to a snapshot copy as well', async () => {
    seedFlows(connA, { Huge_Flow: Buffer.alloc(5_000_001, 0x20) });
    expect(await refused({ connection: 'org-a', flow: 'Huge_Flow' })).toBe(
      `Side A ("org-a" snapshot (${RETRIEVED_TEXT} UTC)) is 5000001 bytes; render_flow's limit per side is ` +
        '5000000. Nothing was written.',
    );
  });

  it('R16: XML that is not a flow', async () => {
    const R16 = (side: string, name: string): string =>
      `Side ${side} (file ${name}) is not Flow metadata XML - its root element is not <Flow>. Nothing was written.`;
    const object = stage('Invoice__c.object', '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>x</label></CustomObject>');
    expect(await refused({ file: object })).toBe(R16('A', 'Invoice__c.object'));
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: object })).toBe(R16('B', 'Invoice__c.object'));
    // The Tooling API's JSON, saved as a file, is not flow XML.
    const json = stage('tooling.json', JSON.stringify({ label: 'x', status: 'Active' }));
    expect(await refused({ file: json })).toBe(R16('A', 'tooling.json'));
    const empty = stage('empty.flow', '');
    expect(await refused({ file: empty })).toBe(R16('A', 'empty.flow'));
  });

  it('R16 applies to a snapshot copy as well', async () => {
    seedFlows(connA, { Not_A_Flow: '<Workflow><label>x</label></Workflow>' });
    expect(await refused({ connection: 'org-a', flow: 'Not_A_Flow' })).toBe(
      `Side A ("org-a" snapshot (${RETRIEVED_TEXT} UTC)) is not Flow metadata XML - its root element is not ` +
        '<Flow>. Nothing was written.',
    );
  });

  it('R17: a DOCTYPE or an entity declaration', async () => {
    const R17 = (name: string): string =>
      `Side A (file ${name}) declares a DOCTYPE or an entity. Flow metadata never does, and the page's XML ` +
      'parser would expand it, so Contrail will not embed it. Nothing was written.';
    const doctype = stage(
      'doctype.flow',
      '<?xml version="1.0"?>\n<!DOCTYPE Flow [ <!ENTITY big "aaaaaaaaaaaaaaaaaaaa"> ]>\n<Flow><label>&big;&big;</label></Flow>',
    );
    expect(await refused({ file: doctype })).toBe(R17('doctype.flow'));
    const entity = stage('entity.flow', '<Flow><!ENTITY x "y"><label>x</label></Flow>');
    expect(await refused({ file: entity })).toBe(R17('entity.flow'));
    // Checked before the root element: a page of HTML is refused for its doctype.
    const html = stage('page.html', '<!doctype html><title>x</title>');
    expect(await refused({ file: html })).toBe(R17('page.html'));
  });

  it('R21: a truncated file', async () => {
    const cut = stage('cut.flow', SEND_INVOICE_FLOW_XML.slice(0, Math.floor(SEND_INVOICE_FLOW_XML.length / 2)));
    const text = await refused({ file: cut });
    expect(text).toMatch(
      /^Side A \(file cut\.flow\) is not well-formed XML \((InvalidXml|InvalidTag|InvalidChar|InvalidAttr), line \d+\)\. render_flow draws only well-formed flow XML\. Nothing was written\.$/,
    );
    const midElement = stage(
      'mid.flow',
      '<Flow xmlns="x"><decisions><name>A</name></decisions><assignments><name>B</name><label>cut off he',
    );
    expect(await refused({ file: midElement })).toBe(
      'Side A (file mid.flow) is not well-formed XML (InvalidXml, line 1). render_flow draws only well-formed ' +
        'flow XML. Nothing was written.',
    );
  });

  it('R21: a mismatched closing tag', async () => {
    const retyped = stage('retyped.flow', '<Flow>\n<label>x</label>\n<status>Active</statis>\n</Flow>\n');
    expect(await refused({ file: retyped })).toBe(
      'Side A (file retyped.flow) is not well-formed XML (InvalidTag, line 3). render_flow draws only ' +
        'well-formed flow XML. Nothing was written.',
    );
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: retyped })).toBe(
      'Side B (file retyped.flow) is not well-formed XML (InvalidTag, line 3). render_flow draws only ' +
        'well-formed flow XML. Nothing was written.',
    );
  });

  it('R21: a comment or processing instruction that is never closed, and text after the flow', async () => {
    const R21 = (name: string, line: number): string =>
      `Side A (file ${name}) is not well-formed XML (InvalidXml, line ${line}). render_flow draws only ` +
      'well-formed flow XML. Nothing was written.';
    const flow = SEND_INVOICE_FLOW_XML.trimEnd();
    const after = flow.split('\n').length + 1;
    // Each of these the XML validator alone accepts, and the page could not draw.
    const openComment = stage('open-comment.flow', `${flow}\n<!-- a note that is never closed\n`);
    expect(await refused({ file: openComment })).toBe(R21('open-comment.flow', after));
    const openInstruction = stage('open-pi.flow', '<Flow/><?pi');
    expect(await refused({ file: openInstruction })).toBe(R21('open-pi.flow', 1));
    const trailing = stage('trailing.flow', '<Flow/>\n\nsaved from an email');
    expect(await refused({ file: trailing })).toBe(R21('trailing.flow', 3));
    // On side B, and from a snapshot copy.
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: openComment })).toBe(
      R21('open-comment.flow', after).replace('Side A', 'Side B'),
    );
    seedFlows(connA, { Open_Comment: `${flow}\n<!-- never closed` });
    expect(await refused({ connection: 'org-a', flow: 'Open_Comment' })).toBe(
      `Side A ("org-a" snapshot (${RETRIEVED_TEXT} UTC)) is not well-formed XML (InvalidXml, line ${after}). ` +
        'render_flow draws only well-formed flow XML. Nothing was written.',
    );
  });

  it('R21 is prompt whatever the file holds: 1 MB of comment openers after the flow', async () => {
    // Checking this once took time that grew with the square of the file's
    // length — over a minute here, with the whole server waiting.
    const openers = stage('openers.flow', `<Flow/>${'<!--'.repeat(250_000)}`);
    const inAttributes = stage('attributes.flow', `<Flow>${'<a b="<!--"/>'.repeat(77_000)}</Flow>`);
    const started = performance.now();
    expect(await refused({ file: openers })).toBe(
      'Side A (file openers.flow) is not well-formed XML (InvalidXml, line 1). render_flow draws only ' +
        'well-formed flow XML. Nothing was written.',
    );
    expect(await refused({ file: inAttributes })).toBe(
      'Side A (file attributes.flow) is not well-formed XML (InvalidXml, line 1). render_flow draws only ' +
        'well-formed flow XML. Nothing was written.',
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('R21 applies to a cut snapshot file as well', async () => {
    seedFlows(connA, { Cut_Flow: '<Flow><label>x</label><decisions><name>D' });
    expect(await refused({ connection: 'org-a', flow: 'Cut_Flow' })).toMatch(
      /^Side A \("org-a" snapshot \(2026-08-06 09:30 UTC\)\) is not well-formed XML \(Invalid[A-Za-z]+, line 1\)\. render_flow draws only well-formed flow XML\. Nothing was written\.$/,
    );
  });

  it('a folder is not a file', async () => {
    fs.mkdirSync(path.join(stagingDir, 'a-folder'));
    const dir = path.join(stagingDir, 'a-folder');
    expect(await refused({ file: dir })).toBe(`file is not a regular file: ${dir}`);
  });
});

// ---- the order of the file-side checks ---------------------------------------

describe('render_flow: nothing is learned about a path outside the folders it reads', () => {
  /** Every path the tool handed to these fs calls, as text. */
  function watchDisk(): () => string[] {
    const spies = [
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'readFileSync'),
    ];
    return () => spies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));
  }

  const touching = (seen: string[], needle: string): string[] =>
    seen.filter((p) => p.toLowerCase().includes(needle.toLowerCase()));

  it('a network path is refused without a single filesystem call on it', async () => {
    const seen = watchDisk();
    const unc = '//contrail-test-host/share/a.flow';
    expect(await refused({ file: unc })).toBe(
      `file is a network or device path; render_flow reads saved XML only from local folders. Copy the file ` +
        `into ${stagingDir} and pass that path.`,
    );
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: unc })).toBe(
      `file_b is a network or device path; render_flow reads saved XML only from local folders. Copy the file ` +
        `into ${stagingDir} and pass that path.`,
    );
    expect(touching(seen(), 'contrail-test-host')).toEqual([]);
  });

  it('a device-namespace path is refused without a filesystem call on it', async () => {
    const seen = watchDisk();
    const device = '\\\\?\\C:\\contrail-device-probe\\x.flow';
    const text = await refused({ file: device });
    if (process.platform === 'win32') {
      expect(text).toBe(
        `file is a network or device path; render_flow reads saved XML only from local folders. Copy the file ` +
          `into ${stagingDir} and pass that path.`,
      );
    } else {
      // Not an absolute path on POSIX: refused one step earlier.
      expect(text).toBe(
        `file must be an absolute path (got "${device}"). Save the XML under ${stagingDir} and pass that full path.`,
      );
    }
    expect(touching(seen(), 'contrail-device-probe')).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'on Windows, every spelling of a network or device path is refused the same way',
    async () => {
      const seen = watchDisk();
      for (const given of [
        '\\\\contrail-test-host\\share\\a.flow',
        '\\\\.\\C:\\contrail-test-host\\a.flow',
        '/\\contrail-test-host\\share\\a.flow',
        '\\/contrail-test-host/share/a.flow',
      ]) {
        expect(await refused({ file: given }), given).toBe(
          `file is a network or device path; render_flow reads saved XML only from local folders. Copy the ` +
            `file into ${stagingDir} and pass that path.`,
        );
      }
      // A drive-relative path is not absolute.
      expect(await refused({ file: 'C:contrail-test-host.flow' })).toContain('file must be an absolute path');
      expect(touching(seen(), 'contrail-test-host')).toEqual([]);
    },
  );

  it('a missing path and an existing 6 MB file outside the roots get the identical refusal, untouched', async () => {
    const big = path.join(outsideDir, 'probe-big.flow');
    fs.writeFileSync(big, Buffer.alloc(6_000_000, 0x20));
    const missing = path.join(outsideDir, 'probe-missing.flow');
    const seen = watchDisk();
    const forBig = await refused({ file: big });
    const forMissing = await refused({ file: missing });
    expect(forBig).toBe(forMissing);
    expect(forBig).toBe(
      `file is outside the folders render_flow reads saved XML from (${stagingDir}). Copy the file into ` +
        `${stagingDir} and pass that path.`,
    );
    // Neither the size nor the existence of either path was looked at.
    expect(forBig).not.toContain('6000000');
    expect(forBig).not.toContain('probe-');
    expect(touching(seen(), 'probe-')).toEqual([]);
  });

  it('a snapshot path is refused without touching the file', async () => {
    const inSnapshot = store.currentFilePath(connA, 'flows/Send_Invoice.flow')!;
    const seen = watchDisk();
    expect(await refused({ file: inSnapshot })).toContain("points inside Contrail's snapshot folder");
    expect(touching(seen(), 'Send_Invoice.flow')).toEqual([]);
  });

  it('a missing path inside staging is looked at, and is reported missing', async () => {
    const missing = path.join(stagingDir, 'probe-missing.flow');
    const seen = watchDisk();
    expect(await refused({ file: missing })).toBe(`file does not exist: ${missing}`);
    expect(touching(seen(), 'probe-missing.flow').length).toBeGreaterThan(0);
  });

  it('a linked folder inside staging that points outside is refused on its real path', async (ctx) => {
    fs.writeFileSync(path.join(outsideDir, 'real.flow'), SEND_INVOICE_FLOW_XML);
    if (!tryLink(outsideDir, path.join(stagingDir, 'linked'), 'junction')) {
      ctx.skip();
      return;
    }
    expect(await refused({ file: path.join(stagingDir, 'linked', 'real.flow') })).toBe(
      `file is outside the folders render_flow reads saved XML from (${stagingDir}). Copy the file into ` +
        `${stagingDir} and pass that path.`,
    );
  });

  it('a linked file inside staging that points outside is refused on its real path', async (ctx) => {
    fs.writeFileSync(path.join(outsideDir, 'real.flow'), SEND_INVOICE_FLOW_XML);
    if (!tryLink(path.join(outsideDir, 'real.flow'), path.join(stagingDir, 'link.flow'), 'file')) {
      ctx.skip();
      return;
    }
    expect(await refused({ file: path.join(stagingDir, 'link.flow') })).toBe(
      `file is outside the folders render_flow reads saved XML from (${stagingDir}). Copy the file into ` +
        `${stagingDir} and pass that path.`,
    );
  });

  it('a link inside staging that points into the snapshot folder is refused as a snapshot path', async (ctx) => {
    if (!tryLink(path.join(snapshotsDir, connLocked), path.join(stagingDir, 'snap'), 'junction')) {
      ctx.skip();
      return;
    }
    expect(await refused({ file: path.join(stagingDir, 'snap', 'current', 'flows', 'Send_Invoice.flow') })).toBe(
      "file points inside Contrail's snapshot folder. Name the org instead - connection + flow - so the read " +
        "goes through that connection's metadata_read grant.",
    );
  });

  it.runIf(process.platform === 'win32')(
    'on Windows, paths compare without regard to letter case',
    async () => {
      const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
      const { payload } = await render({ file: file.toUpperCase(), open: false });
      expect(payload.sides[0]!.origin).toBe('file');
      const inSnapshot = store.currentFilePath(connLocked, 'flows/Send_Invoice.flow')!;
      const seen = watchDisk();
      expect(await refused({ file: inSnapshot.toUpperCase() })).toContain("points inside Contrail's snapshot folder");
      expect(touching(seen(), 'SEND_INVOICE.FLOW')).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'on Windows, a short (8.3) spelling of the snapshot folder is still a snapshot path, even under a configured root',
    async (ctx) => {
      // "snapshots" has a short name only where the volume generates them.
      const short = path.join(dataDir, 'SNAPSH~1', connLocked, 'current', 'flows', 'Send_Invoice.flow');
      if (!fs.existsSync(short)) {
        ctx.skip();
        return;
      }
      // A root the human configured that contains the whole data directory.
      const config: ContrailConfig = {
        ...DEFAULT_CONFIG,
        deploy: { ...DEFAULT_CONFIG.deploy, allowedSourceRoots: [tmp] },
      };
      const { client: c } = await connect({ config });
      const R13 =
        "file points inside Contrail's snapshot folder. Name the org instead - connection + flow - so the read " +
        "goes through that connection's metadata_read grant.";
      expect(await refused({ file: short }, c)).toBe(R13);
      expect(await refused({ file: store.currentFilePath(connLocked, 'flows/Send_Invoice.flow')! }, c)).toBe(R13);
      // The root itself still works for a file that is not a snapshot.
      fs.writeFileSync(path.join(outsideDir, 'saved.flow'), SEND_INVOICE_FLOW_XML);
      const { payload } = await render({ file: path.join(outsideDir, 'saved.flow'), open: false }, c);
      expect(payload.sides[0]!.origin).toBe('file');
    },
  );

  it('a link inside staging to another file inside staging is read', async (ctx) => {
    const target = stage('real/before.flow', SEND_INVOICE_FLOW_XML);
    if (!tryLink(path.dirname(target), path.join(stagingDir, 'alias'), 'junction')) {
      ctx.skip();
      return;
    }
    const { payload } = await render({ file: path.join(stagingDir, 'alias', 'before.flow'), open: false });
    // The side records the real path.
    expect(payload.sides[0]!.file).toBe(target);
  });
});

// ---- shape refusals ---------------------------------------------------------

describe('render_flow: shape refusals', () => {
  const R1 = 'render_flow needs a source for side A: either connection + flow, or file.';
  const R2 = (side: string): string =>
    `Side ${side} names both a connection and a file - give one. A connection reads the flow from that org; a ` +
    'file reads saved XML.';
  const R3 = 'version applies to a connection, not to a file.';
  const R4 = 'flow is required when a side reads from a connection.';
  const R5 = 'Side B needs connection_b or file_b: side A is a file, so there is no connection to reuse.';
  const R6 = (description: string): string =>
    `Both sides name the same source (${description}); there is nothing to compare. Drop the side-B arguments ` +
    'for a single view, or change one side.';
  const R7 = 'invalid flow name';

  it('R1: no source for side A', async () => {
    expect(await refused({})).toBe(R1);
    expect(await refused({ flow: 'Send_Invoice' })).toBe(R1);
    expect(await refused({ flow: 'Send_Invoice', version: 3 })).toBe(R1);
    expect(await refused({ connection_b: 'org-b', flow: 'Send_Invoice' })).toBe(R1);
    expect(await refused({ label: 'x', title: 'y', open: false })).toBe(R1);
  });

  it('R2: a side with both a connection and a file', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file })).toBe(R2('A'));
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', connection_b: 'org-b', file_b: file })).toBe(
      R2('B'),
    );
  });

  it('R3: a version on a file side', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    expect(await refused({ file, version: 2 })).toBe(R3);
    expect(await refused({ file, version: 'latest' })).toBe(R3);
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', file_b: file, version_b: 2 })).toBe(R3);
  });

  it('R4: a connection side with no flow name', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    expect(await refused({ connection: 'org-a' })).toBe(R4);
    expect(await refused({ connection: 'org-a', version: 12 })).toBe(R4);
    expect(await refused({ file, connection_b: 'org-b' })).toBe(R4);
    // flow_b alone names side B's flow, not side A's.
    expect(await refused({ connection: 'org-a', flow_b: 'Send_Invoice' })).toBe(R4);
  });

  it('R5: side B has nothing to read from when side A is a file', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    expect(await refused({ file, flow_b: 'Send_Invoice' })).toBe(R5);
    expect(await refused({ file, version_b: 3 })).toBe(R5);
    expect(await refused({ file, flow: 'Send_Invoice', version_b: 'active' })).toBe(R5);
  });

  it('R6: the same source on both sides', async () => {
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', connection_b: 'org-a' })).toBe(
      R6('"org-a" snapshot'),
    );
    // The same connection by id, and the same flow in another case.
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', connection_b: connA, flow_b: 'send_invoice' })).toBe(
      R6('"org-a" snapshot'),
    );
    expect(await refused({ connection: 'org-a', flow: 'Order_Router', version: 12, version_b: 12 })).toBe(
      R6('"org-a" version 12'),
    );
    expect(await refused({ connection: 'org-a', flow: 'Order_Router', version: 'latest', version_b: 'latest' })).toBe(
      R6('"org-a" latest version'),
    );
    // Decided from the arguments alone: no org was asked.
    expect(fetchCalls).toEqual([]);
  });

  it('R6: the same file on both sides, however it is spelled', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    expect(await refused({ file, file_b: file })).toBe(R6('file before.flow'));
    expect(await refused({ file, file_b: path.join(stagingDir, 'sub', '..', 'before.flow') })).toBe(
      R6('file before.flow'),
    );
  });

  it('a different version, flow or connection is not the same source', async () => {
    const one = await render({ connection: 'org-a', flow: 'Order_Router', version: 12, version_b: 'latest', open: false });
    expect(one.payload.mode).toBe('diff');
    const two = await render({ connection: 'org-a', flow: 'Send_Invoice', connection_b: 'org-b', open: false });
    expect(two.payload.mode).toBe('diff');
  });

  it('R7: a flow name that is not one', async () => {
    for (const bad of ['bad name', '../Send_Invoice', 'a..b', 'x'.repeat(121), "it's", 'a/b', 'a\\b', '']) {
      expect(await refused({ connection: 'org-a', flow: bad }), bad).toBe(R7);
    }
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice', flow_b: 'bad name' })).toBe(R7);
    // Checked before any connection is resolved.
    expect(await refused({ connection: 'nowhere', flow: 'bad name' })).toBe(R7);
  });

  it('label_b alone does not ask for a diff', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', label_b: 'ignored', open: false });
    expect(payload.mode).toBe('single');
    expect(payload.fidelity).toBeUndefined();
  });
});

// ---- the template -----------------------------------------------------------

describe('render_flow: the template comes from this install\'s skills folder', () => {
  const skillMd = (name: string): string =>
    `---\nname: ${name}\ndescription: "Does ${name} things for the test suite."\n---\n\n# ${name}\n`;

  function writeSkill(root: string, name: string, files: Record<string, string> = {}): void {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), skillMd(name));
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, name, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }

  it('R18: CONTRAIL_SKILLS_DIR names an empty folder — the remedy is the variable, not a reinstall', async () => {
    const empty = path.join(tmp, 'empty-pack');
    fs.mkdirSync(empty);
    process.env.CONTRAIL_SKILLS_DIR = empty;
    const { client: c, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override_missing');
    const text = await refused({ connection: 'org-a', flow: 'Send_Invoice' }, c);
    expect(text).toBe(
      "render_flow cannot build a page: flow-diff-template.html is missing from this install's skills folder " +
        '(no skills folder was found). CONTRAIL_SKILLS_DIR is set and decides which skills folder is read: ' +
        'correct or unset it. Nothing was written.',
    );
    expect(text).not.toContain('Reinstalling');
  });

  it('R18: an override pack without the flow skill names the folder it read', async () => {
    const root = path.join(tmp, 'pack-without-template');
    writeSkill(root, 'salesforce-house-rules');
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client: c, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override');
    const text = await refused({ connection: 'org-a', flow: 'Send_Invoice' }, c);
    expect(text).toBe(
      "render_flow cannot build a page: flow-diff-template.html is missing from this install's skills folder " +
        `(${root}). CONTRAIL_SKILLS_DIR is set and decides which skills folder is read: correct or unset it. ` +
        'Nothing was written.',
    );
    expect(text).not.toContain('Reinstalling');
  });

  it('R18: an install with no skills folder is told that reinstalling restores it', async () => {
    // A marker-less tree: skills beside the code, but nothing that says Contrail.
    const fromDir = path.join(tmp, 'install', 'server');
    fs.mkdirSync(fromDir, { recursive: true });
    writeSkill(path.join(tmp, 'install', 'skills'), 'salesforce-house-rules');
    const pack = loadSkillPack(resolveSkillsDir(fromDir));
    expect(pack.source).toBe('absent');
    const { client: c } = await connect({
      adjust: (deps) => {
        deps.skills = { pack, instructions: buildServerInstructions(pack, ENGINE_VERSION) };
      },
    });
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice' }, c)).toBe(
      "render_flow cannot build a page: flow-diff-template.html is missing from this install's skills folder " +
        '(no skills folder was found). Reinstalling Contrail from its release restores it. Nothing was written.',
    );
  });

  it('R19: a template that does not carry each placeholder exactly once', async () => {
    const root = path.join(tmp, 'pack-bad-template');
    writeSkill(root, 'salesforce-house-rules');
    writeSkill(root, 'salesforce-flow-visualize', {
      'assets/flow-diff-template.html': fs.readFileSync(SHIPPED_TEMPLATE, 'utf8').replace('__META__', '{}'),
    });
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client: c } = await connect();
    const template = path.join(root, 'salesforce-flow-visualize', 'assets', 'flow-diff-template.html');
    expect(await refused({ connection: 'org-a', flow: 'Send_Invoice' }, c)).toBe(
      `render_flow cannot build a page: the template at ${template} does not carry each placeholder exactly ` +
        'once, so it is not the template this engine expects. Nothing was written.',
    );
  });

  it('the template that is filled is the one in the pack', async () => {
    const root = path.join(tmp, 'pack-marked-template');
    writeSkill(root, 'salesforce-house-rules');
    writeSkill(root, 'salesforce-flow-visualize', {
      'assets/flow-diff-template.html': `${fs.readFileSync(SHIPPED_TEMPLATE, 'utf8')}<!-- marked copy -->\n`,
    });
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client: c } = await connect();
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false }, c);
    expect(fs.readFileSync(payload.file, 'utf8').endsWith('<!-- marked copy -->\n')).toBe(true);
  });

  it('the sides are read before the template: a bad side is reported even when the template is missing', async () => {
    const empty = path.join(tmp, 'empty-pack');
    fs.mkdirSync(empty);
    process.env.CONTRAIL_SKILLS_DIR = empty;
    const { client: c } = await connect();
    expect(await refused({ connection: 'org-a', flow: 'Nowhere_Flow' }, c)).toContain('was not found on "org-a"');
  });
});

// ---- what a written page is, and is not --------------------------------------

describe('render_flow: the written page', () => {
  it('is not a deploy source', async () => {
    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    let thrown: unknown;
    try {
      resolveSourcePath(payload.file);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContrailError);
    expect((thrown as ContrailError).code).toBe('source_outside_roots');
  });

  it('is never overwritten: two renders of the same flow are two files', async () => {
    const one = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    const two = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(two.payload.file).not.toBe(one.payload.file);
    expect(pages()).toHaveLength(2);
  });

  it('leaves one flow.rendered audit row, which holds no XML', async () => {
    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    const { payload } = await render({ file, connection_b: 'org-b', flow: 'Send_Invoice' });
    const rows = auditRows('flow.rendered');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'render_flow', outcome: 'success', connectionId: connB });
    expect(rows[0]!.detail).toEqual({
      mode: 'diff',
      flow: 'Send_Invoice',
      sides: [
        { side: 'a', origin: 'file', file, sha256: sha256(SEND_INVOICE_FLOW_XML) },
        { side: 'b', origin: 'snapshot', connection_id: connB },
      ],
      file: payload.file,
      page_bytes: payload.page_bytes,
      open_requested: true,
      opened: true,
    });
    const detail = JSON.stringify(rows[0]!.detail);
    for (const fragment of ['<Flow', '<label>', 'Get_Invoice', 'InvoiceService', 'xmlns']) {
      expect(detail, fragment).not.toContain(fragment);
    }
    // Nothing else was audited.
    expect(auditRows()).toHaveLength(1);
  });

  it('the audit row names side A\'s connection, the version read, and null when no org was read', async () => {
    await render({ connection: 'org-a', flow: 'Order_Router', version: 'active', connection_b: 'org-b', flow_b: 'Send_Invoice', open: false });
    const withVersion = auditRows('flow.rendered')[0]!;
    expect(withVersion.connectionId).toBe(connA);
    expect(withVersion.detail).toMatchObject({
      mode: 'diff',
      flow: 'Order_Router',
      sides: [
        { side: 'a', origin: 'tooling_version', connection_id: connA, version: 13 },
        { side: 'b', origin: 'snapshot', connection_id: connB },
      ],
      open_requested: false,
      opened: false,
    });

    const file = stage('before.flow', SEND_INVOICE_FLOW_XML);
    await render({ file, open: false });
    const fileOnly = auditRows('flow.rendered').find((e) => (e.detail as { mode: string }).mode === 'single')!;
    expect(fileOnly.connectionId).toBeNull();
    expect(fileOnly.detail).toMatchObject({ mode: 'single', flow: null });
  });

  it('more than 250 elements: the side is flagged and the notes say what the page shows', async () => {
    seedFlows(connA, { Big_Flow: flowWithDecisions(300), Edge_Flow: flowWithDecisions(249) });
    const { payload } = await render({ connection: 'org-a', flow: 'Big_Flow', open: false });
    expect(payload.sides[0]).toMatchObject({ elements: 301, over_diagram_limit: true });
    expect(payload.notes).toHaveLength(3);
    expect(payload.notes[1]).toBe(
      'org-a has 301 elements; above 250 the page shows a plain message instead of a diagram for that side.',
    );
    expect(embedded(payload.file).meta.note).toContain('org-a has 301 elements;');

    // Exactly 250 is within the limit.
    const edge = await render({ connection: 'org-a', flow: 'Edge_Flow', open: false });
    expect(edge.payload.sides[0]).toMatchObject({ elements: 250, over_diagram_limit: false });
    expect(edge.payload.notes).toHaveLength(2);

    // In a diff the note names the side by its heading.
    const diff = await render({
      connection: 'org-a',
      flow: 'Edge_Flow',
      flow_b: 'Big_Flow',
      label: 'small',
      label_b: 'large',
      open: false,
    });
    expect(diff.payload.sides.map((s) => s.over_diagram_limit)).toEqual([false, true]);
    expect(diff.payload.notes).toContain(
      'large has 301 elements; above 250 the page shows a plain message instead of a diagram for that side.',
    );
    expect(diff.payload.notes.join(' ')).not.toContain('small has');
  });

  it('hostile text in a flow reaches the page as data, never as markup', async () => {
    const hostile = '</script><script>alert(1)</script> $& __META__ __FLOW_B__';
    const xml = `<Flow><label>${hostile.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</label></Flow>`;
    const file = stage('hostile.flow', xml);
    const { payload } = await render({ file, title: '</title><script>x</script>', label: '<img src=x onerror=alert(1)>', open: false });
    const { page, a, meta } = embedded(payload.file);
    expect(a).toBe(xml);
    expect(meta.aLabel).toBe('<img src=x onerror=alert(1)>');
    expect(page.split('</script>').length - 1).toBe(1);
    expect(page.split('<script').length - 1).toBe(1);
    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(page).not.toContain('<img');
  });
});

// ---- Remote Control ---------------------------------------------------------

describe('render_flow: Remote Control', () => {
  function reportRemoteControl(on: boolean): string {
    const at = new Date(Date.now() - 60_000).toISOString();
    fs.mkdirSync(path.join(dataDir, 'remote-control'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'remote-control', 'latest.json'),
      JSON.stringify({ v: 1, remote_control: on, at, tool_name: 'mcp__contrail-engine__list_connections' }),
    );
    return at;
  }

  it('reported on: the result says so and adds the note, and the page is opened as usual', async () => {
    const at = reportRemoteControl(true);
    const { prefix, payload } = await render({ connection: 'org-a', flow: 'Send_Invoice' });
    expect(payload.remote_control).toEqual({ state: 'on', at });
    expect(payload.notes).toHaveLength(3);
    expect(payload.notes[1]).toBe(
      `Remote Control was last reported on at ${at}: the human may be away from this computer, where an ` +
        'opened page is not in front of them. Publish the file as a private artifact.',
    );
    // N8 stays last.
    expect(payload.notes[2]).toMatch(BUILT_RE);
    // The open behaviour itself does not change.
    expect(prefix).toBe(PREFIX_OPENED);
    expect(opened).toEqual([payload.file]);
    // The note is about this session, not about the page: the footer does not carry it.
    const { meta } = embedded(payload.file);
    expect(meta.note).not.toContain('Remote Control');
    expect(meta.note).toBe([payload.notes[0], payload.notes[2]].join(' '));
  });

  it('reported off, or never reported: no remote_control key and no note', async () => {
    const none = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(none.payload.remote_control).toBeUndefined();
    expect(none.payload.notes.join(' ')).not.toContain('Remote Control');

    reportRemoteControl(false);
    const off = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(off.payload.remote_control).toBeUndefined();
    expect(off.payload.notes.join(' ')).not.toContain('Remote Control');
  });
});

// ---- the sweep --------------------------------------------------------------

describe('renders/: pages older than seven days are swept', () => {
  it('seven days, in milliseconds', () => {
    expect(RENDER_RETENTION_MS).toBe(7 * DAY_MS);
  });

  it('at render: an 8-day-old page goes, a 6-day-old page and a non-html file stay', async () => {
    const old = writePage(rendersDir, 'old-view-20260101-000000Z-aaaa.html', 8);
    const recent = writePage(rendersDir, 'recent-view-20260101-000000Z-bbbb.html', 6);
    const notes = path.join(rendersDir, 'notes.txt');
    fs.writeFileSync(notes, 'not a page');
    age(notes, 30);

    const { payload } = await render({ connection: 'org-a', flow: 'Send_Invoice', open: false });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(notes)).toBe(true);
    expect(fs.existsSync(payload.file)).toBe(true);
  });

  it('a refused call writes nothing and sweeps nothing', async () => {
    const old = writePage(rendersDir, 'old.html', 8);
    await refused({ connection: 'org-a', flow: 'Nowhere_Flow' });
    expect(fs.existsSync(old)).toBe(true);
  });

  it('sweepRenders: deletes an 8-day-old .html, keeps a 6-day-old one and a file that is not .html', () => {
    const old = writePage(rendersDir, 'old.html', 8);
    const recent = writePage(rendersDir, 'recent.html', 6);
    const text = writePage(rendersDir, 'old.txt', 8);
    const other = writePage(rendersDir, 'old.html.bak', 8);
    sweepRenders(Date.now());
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(text)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('sweepRenders: the cut is seven days before the `now` it is given', () => {
    const page = writePage(rendersDir, 'page.html', 6);
    const mtime = fs.statSync(page).mtimeMs;
    sweepRenders(mtime + RENDER_RETENTION_MS);
    expect(fs.existsSync(page)).toBe(true);
    sweepRenders(mtime + RENDER_RETENTION_MS + 1000);
    expect(fs.existsSync(page)).toBe(false);
  });

  it('sweepRenders: never enters a sub-folder', () => {
    const nested = writePage(path.join(rendersDir, 'kept'), 'old.html', 8);
    // A folder whose own name ends in .html is not a page.
    const odd = writePage(path.join(rendersDir, 'folder.html'), 'old.html', 8);
    sweepRenders(Date.now());
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(odd)).toBe(true);
  });

  it('sweepRenders: never follows a linked folder', (ctx) => {
    fs.mkdirSync(rendersDir, { recursive: true });
    const target = writePage(path.join(outsideDir, 'pages'), 'old.html', 8);
    if (!tryLink(path.dirname(target), path.join(rendersDir, 'linked'), 'junction')) {
      ctx.skip();
      return;
    }
    sweepRenders(Date.now());
    expect(fs.existsSync(target)).toBe(true);
  });

  it('sweepRenders: never deletes through a linked file, and leaves the link alone', (ctx) => {
    fs.mkdirSync(rendersDir, { recursive: true });
    const target = writePage(outsideDir, 'old-target.html', 8);
    const link = path.join(rendersDir, 'link.html');
    if (!tryLink(target, link, 'file')) {
      ctx.skip();
      return;
    }
    sweepRenders(Date.now());
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('sweepRenders: does nothing, and creates nothing, when there is no renders folder', () => {
    expect(fs.existsSync(rendersDir)).toBe(false);
    expect(() => sweepRenders(Date.now())).not.toThrow();
    expect(fs.existsSync(rendersDir)).toBe(false);
  });

  it('sweepRenders: never throws, even when renders is a file', () => {
    fs.writeFileSync(rendersDir, 'not a folder');
    expect(() => sweepRenders(Date.now())).not.toThrow();
    expect(fs.readFileSync(rendersDir, 'utf8')).toBe('not a folder');
  });

  it('at start: createDeps() alone, with no render_flow call, removes an 8-day-old page', () => {
    const old = writePage(rendersDir, 'old.html', 8);
    const recent = writePage(rendersDir, 'recent.html', 6);
    makeDeps();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('at start: a data directory with no renders folder is left without one', () => {
    expect(fs.existsSync(rendersDir)).toBe(false);
    makeDeps();
    expect(fs.existsSync(rendersDir)).toBe(false);
  });

  it('at start: a renders folder that resolves outside the data directory is left untouched', (ctx) => {
    const target = writePage(path.join(outsideDir, 'elsewhere'), 'old.html', 8);
    if (!tryLink(path.dirname(target), rendersDir, 'junction')) {
      ctx.skip();
      return;
    }
    makeDeps();
    sweepRenders(Date.now());
    expect(fs.existsSync(target)).toBe(true);
  });

  it('at start, under test: every suite that builds the deps points CONTRAIL_DATA_DIR at its own sandbox', () => {
    // createDeps() sweeps renders/ under dataDir(). A suite that calls it with
    // CONTRAIL_DATA_DIR unset sweeps the real data directory of whoever runs
    // the tests.
    const suites = fs
      .readdirSync(here)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => ({ name, text: fs.readFileSync(path.join(here, name), 'utf8') }))
      .filter((suite) => suite.text.includes('createDeps('));
    expect(suites.length).toBeGreaterThan(20);
    expect(
      suites.filter((suite) => !suite.text.includes('process.env.CONTRAIL_DATA_DIR = ')).map((suite) => suite.name),
    ).toEqual([]);
  });

  it('R20: a renders folder that resolves outside the data directory is not written to', async (ctx) => {
    const elsewhere = path.join(outsideDir, 'elsewhere');
    const old = writePage(elsewhere, 'old.html', 8);
    if (!tryLink(elsewhere, rendersDir, 'junction')) {
      ctx.skip();
      return;
    }
    const result = await call({ connection: 'org-a', flow: 'Send_Invoice' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Contrail's renders folder resolves outside its data directory (${elsewhere}); refusing to write ` +
        `there. Remove the link at ${rendersDir} and retry.`,
    );
    // Nothing was written there, nothing was swept there, nothing was opened.
    expect(fs.readdirSync(elsewhere)).toEqual(['old.html']);
    expect(fs.existsSync(old)).toBe(true);
    expect(opened).toEqual([]);
    expect(auditRows('flow.rendered')).toEqual([]);
  });
});

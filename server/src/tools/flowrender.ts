import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, guarded } from './register.js';
import { fetchFlowVersionContent, readArtifactFromSnapshot, readFlowLive } from './metadata.js';
import type { ConnectionRecord } from '../core/types.js';
import { ConnectionNotFoundError, ContrailError } from '../core/errors.js';
import { assertGrant } from '../core/gate.js';
import { dataDir, rendersDir, snapshotsDir, stagingDir } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';
import { RestClient } from '../salesforce/rest.js';
import { flowMetadataJsonToXml } from '../salesforce/flowversion.js';
import { parseFlowStart } from '../deps/automation.js';
import {
  buildFlowPage,
  checkFlowXml,
  countFlowElements,
  FLOW_DIAGRAM_MAX_NODES,
  RENDER_MAX_FLOW_BYTES,
  stripBom,
  type FlowPageMeta,
} from '../skillpack/flowpage.js';

/**
 * S46: render_flow — one flow as an interactive diagram, or two side by side
 * as a diff, written as a self-contained HTML page under renders/ in the data
 * directory. Contrail builds the page (skillpack/flowpage.ts fills the
 * flow-visualize skill's template), so the flow XML never passes through a
 * model. Plugin-only: the desktop app draws flows on its own screens.
 *
 * A side is a connection's snapshot copy, a historical version read from the
 * Tooling API, or a saved XML file. The rules that keep this honest:
 *   - Every connection read must hold metadata_read, and BOTH are checked
 *     before any read (the diff tools' pattern).
 *   - A file side needs no grant, so it is confined before it is touched: no
 *     filesystem call names the agent's path until that path is lexically
 *     inside the staging folder or a root the human configured, and network
 *     and device paths are refused outright. A session with no grant cannot
 *     use the refusals to learn whether a path exists or how large it is.
 *   - A path under the snapshot folder is refused: that read belongs to the
 *     connection's grant.
 *   - Every side must be well-formed flow XML with no DOCTYPE, whatever its
 *     origin, or nothing is written.
 *
 * The page embeds the flow's full XML. Pages older than seven days are
 * deleted by sweepRenders, which runs when the server starts and each time
 * render_flow runs — no timer, no config key.
 */

const FLOW_NAME_RE = /^[A-Za-z0-9_.\-]{1,120}$/;
const flowNameOk = (name: string): boolean => FLOW_NAME_RE.test(name) && !name.includes('..');

/** Pages in renders/ older than this are deleted by sweepRenders. */
export const RENDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TEMPLATE_SKILL = 'salesforce-flow-visualize';
const TEMPLATE_FILE = 'flow-diff-template.html';

const RETENTION_TEXT =
  'Pages in this folder older than 7 days are deleted when the Contrail server starts and ' +
  'each time render_flow writes a page; nothing deletes them in between.';
const PUBLISH_NOTE =
  'To show this page anywhere else, publish this file as a private artifact. Publish the ' +
  'file itself; do not paste or retype its contents.';

type VersionSpec = number | 'active' | 'latest';
type SideKey = 'a' | 'b';
type Origin = 'snapshot' | 'tooling_version' | 'tooling_fallback' | 'file';

interface RenderFlowArgs {
  flow?: string;
  connection?: string;
  version?: VersionSpec;
  file?: string;
  label?: string;
  connection_b?: string;
  flow_b?: string;
  version_b?: VersionSpec;
  file_b?: string;
  label_b?: string;
  title?: string;
  open?: boolean;
}

/** What one side asks for, after the shape checks. */
type SideSource =
  | { kind: 'connection'; conn: ConnectionRecord; flow: string; version?: VersionSpec }
  | { kind: 'file'; arg: 'file' | 'file_b'; given: string };

interface ResolvedSide {
  side: SideKey;
  origin: Origin;
  /** The XML as embedded: read, then one leading byte-order mark dropped. */
  xml: string;
  bytes: number;
  /** "Described as" — the subtitle and the refusals use it. */
  description: string;
  defaultHeading: string;
  conn?: ConnectionRecord;
  flow?: string;
  version?: number;
  /** Version sides: the Tooling row's Status. Snapshot sides: the XML's top-level <status>, null when it has none. */
  status?: string | null;
  /** tooling_fallback only: which version the org handed back. */
  which?: 'active' | 'latest';
  retrievedAt?: string | null;
  /** File sides: the real path read, its name, and the sha256 of its bytes. */
  file?: string;
  basename?: string;
  sha256?: string;
  elements: number | null;
  overLimit: boolean;
}

// ---- containment ----------------------------------------------------------

/** Paths compare case-insensitively on Windows, where the file system does. */
function fold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** True when `child` is strictly inside `parent` (path.relative based; never touches the disk). */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(fold(parent), fold(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isInsideOrSame(child: string, parent: string): boolean {
  return fold(path.resolve(child)) === fold(path.resolve(parent)) || isInside(child, parent);
}

/**
 * One of Contrail's own folders (or a root the human configured), in its
 * configured spelling and — when it exists — its real path. The realpath here
 * is of Contrail's folder, never of a path the agent named.
 */
interface Folder {
  given: string;
  real: string | null;
}

function folder(dir: string): Folder {
  const given = path.resolve(dir);
  let real: string | null = null;
  try {
    real = fs.realpathSync(given);
  } catch {
    // A configured root that does not exist yet cannot hold a file.
  }
  return { given, real };
}

/**
 * The one canonical spelling of an existing path. fs.realpathSync resolves
 * links but leaves the rest as it was given: on Windows an 8.3 short name
 * (SNAPSH~1) and the letter case survive it, so two spellings of one folder
 * do not compare equal. The native call returns the spelling the file system
 * itself reports. Falls back to the path as given where the native call is
 * missing or fails.
 */
function canonicalPath(p: string): string {
  try {
    const native = fs.realpathSync.native;
    return typeof native === 'function' ? native(p) : p;
  } catch {
    return p;
  }
}

// ---- texts ----------------------------------------------------------------

const sideLetter = (side: SideKey): 'A' | 'B' => (side === 'a' ? 'A' : 'B');

/** `2026-11-17 14:05` from an ISO timestamp, in UTC. */
function utcMinute(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

/** A source named but not yet read: what R6 can say before anything is resolved. */
function describeSource(source: SideSource): string {
  if (source.kind === 'file') return `file ${path.basename(source.given)}`;
  const alias = `"${source.conn.alias}"`;
  if (source.version === undefined) return `${alias} snapshot`;
  if (typeof source.version === 'number') return `${alias} version ${source.version}`;
  return `${alias} ${source.version} version`;
}

function sideNote(side: ResolvedSide, heading: string): string {
  const alias = side.conn?.alias ?? '';
  switch (side.origin) {
    case 'snapshot': {
      const status = side.status ?? null;
      const tail =
        status === 'Active'
          ? '.'
          : ' - an older version may still be the active one. Pass version: "active" to draw ' +
            'the version that runs.';
      return (
        `${heading}: snapshot of "${alias}" retrieved ${utcMinute(side.retrievedAt)} UTC; the org ` +
        `may have changed since. The snapshot holds the flow's latest version ` +
        `(${status === null ? 'its XML carries no status' : `its status reads ${status}`})${tail}`
      );
    }
    case 'tooling_version':
      return (
        `${heading}: version ${side.version} (${side.status ?? 'status unknown'}) of ${side.flow} on ` +
        `"${alias}", converted from the Tooling API's JSON - faithful for reading and diffing, ` +
        `element order alphabetical, not deploy-ready.`
      );
    case 'tooling_fallback':
      return (
        `${heading}: ${side.flow} is not in the snapshot of "${alias}"; this is its ${side.which} ` +
        `version, read live from the Tooling API and converted from JSON (element order ` +
        `alphabetical, not deploy-ready).`
      );
    case 'file':
      return (
        `${heading}: saved file ${side.basename} (sha256 ${(side.sha256 ?? '').slice(0, 12)}); ` +
        `Contrail did not read this side from an org.`
      );
  }
}

const MIXED_NOTE =
  'Mixed sources: one side was converted from Tooling API JSON and the other is a Metadata ' +
  'API retrieve. Their child elements are ordered differently, so nodes can be marked changed ' +
  "when nothing real differs - check the inspector's parsed rows before trusting a mark. For " +
  'a like-for-like comparison, pass a version on both sides.';
const FILE_IN_DIFF_NOTE =
  'One side is a saved file whose origin Contrail cannot tell. If the two sides were not ' +
  'produced the same way (both Metadata API retrieves, or both converted Tooling versions), ' +
  'nodes can be marked changed only because their child elements are ordered differently.';

// ---- the sweep ------------------------------------------------------------

/**
 * Delete flow pages older than seven days. Runs when the server starts
 * (createDeps) and each time render_flow writes a page; nothing deletes a page
 * in between.
 *
 * Never throws and never creates the folder: it returns at once unless
 * renders/ exists and its real path is inside the data directory's. It then
 * deletes regular .html files directly in that folder whose mtime is more
 * than seven days before `now` — lstat only, never a sub-folder, never through
 * a link, errors ignored.
 */
export function sweepRenders(now: number): void {
  try {
    const root = dataDir();
    const dir = path.join(root, 'renders');
    if (!fs.existsSync(dir)) return;
    const realDir = fs.realpathSync(dir);
    if (!isInside(realDir, fs.realpathSync(root))) return;
    for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
      // A Dirent for a link or a folder is not a file.
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const file = path.join(realDir, entry.name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() && now - st.mtimeMs > RENDER_RETENTION_MS) fs.unlinkSync(file);
      } catch {
        // Best effort: a page that cannot be removed now is tried again next time.
      }
    }
  } catch {
    // The sweep never stops a start-up or a render.
  }
}

// ---- the tool -------------------------------------------------------------

export function registerFlowRenderTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit } = deps;

  const versionSchema = z.union([z.number().int().min(1), z.enum(['active', 'latest'])]).optional();

  /** Step 5 for one side: the size cap, then what the XML must be, then the advisory count. */
  function checked(
    side: SideKey,
    description: string,
    raw: string,
    bytes: number,
  ): { xml: string; elements: number | null; overLimit: boolean } {
    const where = `Side ${sideLetter(side)} (${description})`;
    if (bytes > RENDER_MAX_FLOW_BYTES) {
      throw new ContrailError(
        `${where} is ${bytes} bytes; render_flow's limit per side is ${RENDER_MAX_FLOW_BYTES}. ` +
          `Nothing was written.`,
        'source_too_large',
      );
    }
    const xml = stripBom(raw);
    const verdict = checkFlowXml(xml);
    if (!verdict.ok) {
      if (verdict.reason === 'doctype') {
        throw new ContrailError(
          `${where} declares a DOCTYPE or an entity. Flow metadata never does, and the page's ` +
            `XML parser would expand it, so Contrail will not embed it. Nothing was written.`,
          'bad_flow_xml',
        );
      }
      if (verdict.reason === 'not_flow') {
        throw new ContrailError(
          `${where} is not Flow metadata XML - its root element is not <Flow>. Nothing was written.`,
          'bad_flow_xml',
        );
      }
      throw new ContrailError(
        `${where} is not well-formed XML (${verdict.code}, line ${verdict.line}). render_flow ` +
          `draws only well-formed flow XML. Nothing was written.`,
        'bad_flow_xml',
      );
    }
    const elements = countFlowElements(xml);
    return { xml, elements, overLimit: elements !== null && elements > FLOW_DIAGRAM_MAX_NODES };
  }

  /** A version read through the Tooling API: one version, converted from its JSON. */
  async function versionSide(
    side: SideKey,
    conn: ConnectionRecord,
    flow: string,
    version: number,
  ): Promise<ResolvedSide> {
    // Its own artifact_not_found messages pass through unchanged.
    const content = await fetchFlowVersionContent(deps, conn, flow, version);
    const status = content.version_status ?? null;
    const description = `"${conn.alias}" version ${version} (${status ?? 'status unknown'})`;
    const body = checked(side, description, content.body, Buffer.byteLength(content.body, 'utf8'));
    return {
      side,
      origin: 'tooling_version',
      xml: body.xml,
      bytes: Buffer.byteLength(content.body, 'utf8'),
      description,
      defaultHeading: `${conn.alias} · v${version}`,
      conn,
      flow,
      version,
      status,
      elements: body.elements,
      overLimit: body.overLimit,
    };
  }

  async function connectionSide(
    side: SideKey,
    source: Extract<SideSource, { kind: 'connection' }>,
  ): Promise<ResolvedSide> {
    const { conn, flow, version } = source;

    if (typeof version === 'number') return versionSide(side, conn, flow, version);

    if (version === 'active' || version === 'latest') {
      const rest = new RestClient(deps.tokenMgr, conn, deps.config.salesforce.apiVersion);
      // Two-step escape, backslash first (house idiom) — the name gate
      // upstream already rejects both characters.
      const esc = flow.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const rows = await rest.toolingQuery<{ VersionNumber: number; Status: string | null }>(
        `SELECT VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '${esc}' ` +
          `ORDER BY VersionNumber DESC LIMIT 200`,
        200,
      );
      if (rows.length === 0) {
        throw new ContrailError(
          `No flow named ${flow} is visible to the Tooling API on "${conn.alias}".`,
          'artifact_not_found',
        );
      }
      const row = version === 'latest' ? rows[0] : rows.find((r) => r.Status === 'Active');
      if (!row) {
        const listed = rows.slice(0, 50).map((r) => `${r.VersionNumber} (${r.Status ?? '?'})`);
        if (rows.length > listed.length) listed.push(`and ${rows.length - listed.length} more`);
        throw new ContrailError(
          `Flow ${flow} has no active version on "${conn.alias}" (versions: ${listed.join(', ')}). ` +
            `Pass a version number or "latest". Nothing was written.`,
          'artifact_not_found',
        );
      }
      return versionSide(side, conn, flow, Number(row.VersionNumber));
    }

    // The snapshot copy: the flow's latest version, as last retrieved.
    const snapshot = readArtifactFromSnapshot(deps, conn, 'Flow', flow);
    if (snapshot !== null) {
      const retrievedAt = db.getArtifact(conn.id, 'Flow', flow)?.retrievedAt ?? null;
      const description = `"${conn.alias}" snapshot (${utcMinute(retrievedAt)} UTC)`;
      const bytes = Buffer.byteLength(snapshot, 'utf8');
      const body = checked(side, description, snapshot, bytes);
      return {
        side,
        origin: 'snapshot',
        xml: body.xml,
        bytes,
        description,
        defaultHeading: conn.alias,
        conn,
        flow,
        status: parseFlowStart(body.xml).status,
        retrievedAt,
        elements: body.elements,
        overLimit: body.overLimit,
      };
    }

    // Not in the snapshot: ask the org.
    const live = await readFlowLive(deps, conn, flow);
    if (live.kind === 'descriptor') {
      throw new ContrailError(
        `Flow ${flow} on "${conn.alias}" is platform/feature-delivered: Salesforce exposes only ` +
          `a descriptor for it (identity, type, active status) and no API returns its ` +
          `definition, so there is nothing to draw. Nothing was written.`,
        'artifact_not_found',
      );
    }
    if (live.kind === 'absent') {
      throw new ContrailError(
        `Flow ${flow} was not found on "${conn.alias}" - not in the snapshot, the Tooling API, ` +
          `or FlowDefinitionView. Check the name with list_metadata (type Flow, live=true), or ` +
          `run refresh_snapshot. Nothing was written.`,
        'artifact_not_found',
      );
    }
    const converted = flowMetadataJsonToXml(live.metadata);
    const description = `"${conn.alias}" ${live.which} version, read live`;
    const bytes = Buffer.byteLength(converted, 'utf8');
    const body = checked(side, description, converted, bytes);
    return {
      side,
      origin: 'tooling_fallback',
      xml: body.xml,
      bytes,
      description,
      defaultHeading: `${conn.alias} · ${live.which} (live)`,
      conn,
      flow,
      which: live.which,
      elements: body.elements,
      overLimit: body.overLimit,
    };
  }

  /**
   * A saved file. The order is the point: nothing below touches the path the
   * agent named until that path is lexically inside a folder render_flow may
   * read, so the refusals say nothing about paths outside those folders.
   */
  function fileSide(side: SideKey, source: Extract<SideSource, { kind: 'file' }>): ResolvedSide {
    const { arg, given } = source;
    const staging = stagingDir();

    // (a) Absolute only.
    if (!path.isAbsolute(given)) {
      throw new ContrailError(
        `${arg} must be an absolute path (got "${given}"). Save the XML under ${staging} and ` +
          `pass that full path.`,
        'bad_source_path',
      );
    }
    // (b) A UNC or device-namespace path: on Windows, opening one would make
    // this server start a session with a host the agent chose.
    if (
      given.startsWith('//') ||
      given.startsWith('\\\\') ||
      (process.platform === 'win32' && /^[\\/]{2}/.test(given))
    ) {
      throw new ContrailError(
        `${arg} is a network or device path; render_flow reads saved XML only from local ` +
          `folders. Copy the file into ${staging} and pass that path.`,
        'bad_source_path',
      );
    }

    // (c) Lexical containment. The roots are built here, explicitly — not
    // from allowedSourceRoots(), so a root a later sprint adds to that
    // function never becomes a render_flow root.
    const snapshots = folder(snapshotsDir());
    const roots = [
      folder(staging),
      ...deps.config.deploy.allowedSourceRoots.filter((r) => path.isAbsolute(r)).map(folder),
    ];
    const inSnapshots = (p: string): boolean =>
      isInsideOrSame(p, snapshots.given) ||
      (snapshots.real !== null && isInsideOrSame(p, snapshots.real));
    const refuseSnapshot = (): never => {
      throw new ContrailError(
        `${arg} points inside Contrail's snapshot folder. Name the org instead - connection + ` +
          `flow - so the read goes through that connection's metadata_read grant.`,
        'bad_source_path',
      );
    };
    const refuseOutside = (): never => {
      throw new ContrailError(
        `${arg} is outside the folders render_flow reads saved XML from ` +
          `(${roots.map((r) => r.given).join(', ')}). Copy the file into ${staging} and pass ` +
          `that path.`,
        'bad_source_path',
      );
    };
    const p = path.resolve(given);
    if (inSnapshots(p)) refuseSnapshot();
    if (!roots.some((r) => isInside(p, r.given) || (r.real !== null && isInside(p, r.real)))) {
      refuseOutside();
    }

    // (d) Only now the disk. A link inside a root that points outside still
    // fails: both checks run again on the real path.
    const missing = (): never => {
      throw new ContrailError(`${arg} does not exist: ${given}`, 'source_not_found');
    };
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return missing();
    }
    if (inSnapshots(real)) refuseSnapshot();
    if (!roots.some((r) => r.real !== null && isInside(real, r.real))) refuseOutside();
    // The snapshot folder is an exclusion, so it is also compared in the one
    // canonical spelling: when a configured root contains the data directory,
    // a short or re-cased spelling of "snapshots" would otherwise pass every
    // comparison above. (Being INSIDE a root needs no such step: a path that
    // starts with a root's own spelling is in that folder.)
    if (isInsideOrSame(canonicalPath(real), canonicalPath(snapshots.real ?? snapshots.given))) {
      refuseSnapshot();
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return missing();
    }
    if (!stat.isFile()) {
      throw new ContrailError(`${arg} is not a regular file: ${given}`, 'bad_source_path');
    }
    const basename = path.basename(real);
    const description = `file ${basename}`;
    if (stat.size > RENDER_MAX_FLOW_BYTES) {
      throw new ContrailError(
        `Side ${sideLetter(side)} (${description}) is ${stat.size} bytes; render_flow's limit ` +
          `per side is ${RENDER_MAX_FLOW_BYTES}. Nothing was written.`,
        'source_too_large',
      );
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(real);
    } catch {
      return missing();
    }
    const body = checked(side, description, buf.toString('utf8'), buf.length);
    return {
      side,
      origin: 'file',
      xml: body.xml,
      bytes: buf.length,
      description,
      defaultHeading: basename,
      file: real,
      basename,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      elements: body.elements,
      overLimit: body.overLimit,
    };
  }

  /** Step 6: the template, from this install's own skills folder. */
  function readTemplate(): { text: string; file: string } {
    const { pack } = deps.skills;
    const unavailable = (where: string): never => {
      // The remedy follows where the pack came from, so it is true on every
      // path that reaches it: reinstalling does not change a folder the human
      // named.
      const remedy =
        pack.source === 'override' || pack.source === 'override_missing'
          ? 'CONTRAIL_SKILLS_DIR is set and decides which skills folder is read: correct or unset it.'
          : 'Reinstalling Contrail from its release restores it.';
      throw new ContrailError(
        `render_flow cannot build a page: ${TEMPLATE_FILE} is missing from this install's ` +
          `skills folder (${where}). ${remedy} Nothing was written.`,
        'render_unavailable',
      );
    };
    if (pack.root === null) return unavailable('no skills folder was found');
    const file = path.join(pack.root, TEMPLATE_SKILL, 'assets', TEMPLATE_FILE);
    try {
      return { text: fs.readFileSync(file, 'utf8'), file };
    } catch {
      return unavailable(pack.root);
    }
  }

  server.registerTool(
    'render_flow',
    {
      title: 'Render a flow diagram or flow diff page',
      description:
        'Show a Salesforce flow as an interactive flow diagram, or two flows side by side in a ' +
        'diff viewer: visualize, display, draw or chart a flow; compare a flow across two orgs, ' +
        'two versions of one flow, or before and after an edit. Contrail builds the HTML page ' +
        'itself from the flow XML (Flow-Builder-style canvas, change highlighting, click a node ' +
        'to inspect it) - never hand-build one - writes it under renders/ in its data directory ' +
        'and returns the file path. By default it also asks this computer to open the page; to ' +
        'show it anywhere else (a human on their phone, a shared review), pass open:false and ' +
        'publish the returned file as a private artifact - publish the file, never paste its ' +
        "contents. Each side is one of: a connection's snapshot copy of the flow - its latest " +
        'version, which may not be the active one (read live from the Tooling API when the ' +
        'snapshot lacks it); a historical version by number, or "active" / "latest" (the Tooling ' +
        "API's JSON converted to flow XML); or a saved flow XML file under Contrail's staging " +
        'directory. Side A is the left/old pane, side B the right/new pane; give no side-B ' +
        'argument for a single view. Requires metadata_read on every connection it reads. Two ' +
        'snapshot copies, or two converted versions, compare like for like; a converted version ' +
        'against a snapshot or a saved retrieve is allowed but can mark nodes changed only ' +
        'because their child elements are ordered differently - the result and the page footer ' +
        'say when that applies. A flow whose definition no API exposes ' +
        '(platform/feature-delivered) is refused, not drawn. The page embeds the flow\'s full ' +
        'XML: treat the file as client-confidential. Pages in renders/ older than 7 days are ' +
        'deleted when the Contrail server starts and each time render_flow writes a page.',
      inputSchema: {
        flow: z
          .string()
          .optional()
          .describe(
            'Flow API name (DeveloperName), for example Send_Invoice. Used for both sides unless ' +
              'flow_b is given. Required whenever a side reads from a connection.',
          ),
        connection: z
          .string()
          .optional()
          .describe('Side A: connection alias (or id) to read the flow from.'),
        version: versionSchema.describe(
          'Side A: a historical version - a version number, or "active" / "latest". Omit for ' +
            'the snapshot copy. Needs connection.',
        ),
        file: z
          .string()
          .optional()
          .describe(
            'Side A instead of a connection: absolute path of a saved flow XML file under ' +
              "Contrail's staging directory (list_connections returns staging_dir).",
          ),
        label: z
          .string()
          .max(80)
          .optional()
          .describe(
            'Side A pane heading (default: the connection alias, plus the version when one is ' +
              'given; or the file name).',
          ),
        connection_b: z
          .string()
          .optional()
          .describe(
            "Side B: connection alias (or id). Omit to reuse side A's connection when version_b " +
              'or flow_b is given.',
          ),
        flow_b: z.string().optional().describe('Side B: a different flow API name (default: flow).'),
        version_b: versionSchema.describe(
          'Side B: a version number, or "active" / "latest". Omit for the snapshot copy.',
        ),
        file_b: z
          .string()
          .optional()
          .describe(
            'Side B instead of a connection: absolute path of a saved flow XML file under ' +
              "Contrail's staging directory.",
          ),
        label_b: z.string().max(80).optional().describe('Side B pane heading.'),
        title: z
          .string()
          .max(120)
          .optional()
          .describe('Page title (default: the flow name and the pane headings).'),
        open: z
          .boolean()
          .optional()
          .describe(
            'Ask this computer to open the page in its default app for .html files (default ' +
              'true). Pass false when the human is not at this computer.',
          ),
      },
    },
    async (args: RenderFlowArgs) =>
      guarded(async () => {
        // ---- 1. Shape ----------------------------------------------------
        const diff =
          args.connection_b !== undefined ||
          args.flow_b !== undefined ||
          args.version_b !== undefined ||
          args.file_b !== undefined;
        const refuseShape = (message: string): never => {
          throw new ContrailError(message, 'bad_render_request');
        };
        const bothGiven = (letter: 'A' | 'B'): never =>
          refuseShape(
            `Side ${letter} names both a connection and a file - give one. A connection reads ` +
              `the flow from that org; a file reads saved XML.`,
          );

        if (args.connection === undefined && args.file === undefined) {
          refuseShape('render_flow needs a source for side A: either connection + flow, or file.');
        }
        if (args.connection !== undefined && args.file !== undefined) bothGiven('A');
        if (args.file !== undefined && args.version !== undefined) {
          refuseShape('version applies to a connection, not to a file.');
        }
        if (diff) {
          if (args.connection_b !== undefined && args.file_b !== undefined) bothGiven('B');
          if (args.file_b !== undefined && args.version_b !== undefined) {
            refuseShape('version applies to a connection, not to a file.');
          }
          if (args.connection_b === undefined && args.file_b === undefined && args.file !== undefined) {
            refuseShape(
              'Side B needs connection_b or file_b: side A is a file, so there is no connection ' +
                'to reuse.',
            );
          }
        }
        const aIsConnection = args.file === undefined;
        const bIsConnection = diff && args.file_b === undefined;
        const flowA = args.flow;
        const flowB = args.flow_b ?? args.flow;
        if ((aIsConnection && flowA === undefined) || (bIsConnection && flowB === undefined)) {
          refuseShape('flow is required when a side reads from a connection.');
        }
        for (const name of [args.flow, args.flow_b]) {
          if (name !== undefined && !flowNameOk(name)) refuseShape('invalid flow name');
        }

        // ---- 2. Connections and grants, before any read -------------------
        const resolve = (ref: string): ConnectionRecord => {
          const rec = db.resolveConnection(ref);
          if (!rec) throw new ConnectionNotFoundError(ref);
          return rec;
        };
        const connA = aIsConnection ? resolve(args.connection as string) : null;
        const connB = !bIsConnection
          ? null
          : args.connection_b !== undefined
            ? resolve(args.connection_b)
            : connA;
        const distinct = new Map<string, ConnectionRecord>();
        for (const rec of [connA, connB]) if (rec) distinct.set(rec.id, rec);
        for (const rec of distinct.values()) assertGrant(rec, 'render_flow', audit);

        const sourceA: SideSource = connA
          ? { kind: 'connection', conn: connA, flow: flowA as string, version: args.version }
          : { kind: 'file', arg: 'file', given: args.file as string };
        const sourceB: SideSource | null = !diff
          ? null
          : connB
            ? { kind: 'connection', conn: connB, flow: flowB as string, version: args.version_b }
            : { kind: 'file', arg: 'file_b', given: args.file_b as string };

        // ---- 3. The same source twice --------------------------------------
        const sameSource = (description: string): never => {
          throw new ContrailError(
            `Both sides name the same source (${description}); there is nothing to compare. ` +
              `Drop the side-B arguments for a single view, or change one side.`,
            'bad_render_request',
          );
        };
        if (
          sourceB &&
          sourceA.kind === 'connection' &&
          sourceB.kind === 'connection' &&
          sourceA.conn.id === sourceB.conn.id &&
          sourceA.flow.toLowerCase() === sourceB.flow.toLowerCase() &&
          sourceA.version === sourceB.version
        ) {
          sameSource(describeSource(sourceA));
        }

        // ---- 4 + 5. Each side: read, then check ----------------------------
        const readSide = (side: SideKey, source: SideSource): Promise<ResolvedSide> | ResolvedSide =>
          source.kind === 'file' ? fileSide(side, source) : connectionSide(side, source);
        const a = await readSide('a', sourceA);
        const b = sourceB ? await readSide('b', sourceB) : null;
        // Two file sides are compared on their real paths, after both passed.
        if (b && a.origin === 'file' && b.origin === 'file' && fold(a.file ?? '') === fold(b.file ?? '')) {
          sameSource(a.description);
        }

        // ---- 6. The template -----------------------------------------------
        const template = readTemplate();

        // ---- 7. Labels, subtitle, notes, title ------------------------------
        const aLabel = args.label || a.defaultHeading;
        const bLabel = b ? args.label_b || b.defaultHeading : undefined;
        const subtitle = b ? `${a.description} → ${b.description}` : a.description;
        const titleFlow = args.flow ?? args.flow_b ?? null;
        const headings = b ? `${aLabel} vs ${bLabel} (diff)` : aLabel;
        const title = args.title || (titleFlow ? `${titleFlow} — ${headings}` : headings);

        const converted = (s: ResolvedSide): boolean =>
          s.origin === 'tooling_version' || s.origin === 'tooling_fallback';
        let fidelity: 'like_for_like' | 'mixed' | 'unknown' | undefined;
        const notes: string[] = [sideNote(a, aLabel)];
        if (b) {
          notes.push(sideNote(b, bLabel as string));
          if (a.origin === 'file' || b.origin === 'file') {
            fidelity = 'unknown';
            notes.push(FILE_IN_DIFF_NOTE);
          } else if (converted(a) === converted(b)) {
            fidelity = 'like_for_like';
          } else {
            fidelity = 'mixed';
            notes.push(MIXED_NOTE);
          }
        }
        for (const [s, heading] of [
          [a, aLabel],
          [b, bLabel],
        ] as const) {
          if (s && s.overLimit) {
            notes.push(
              `${heading} has ${s.elements} elements; above ${FLOW_DIAGRAM_MAX_NODES} the page ` +
                `shows a plain message instead of a diagram for that side.`,
            );
          }
        }
        const built = `Built by Contrail ${ENGINE_VERSION} render_flow at ${new Date().toISOString()}.`;
        // The page footer is the notes about the page; the Remote Control
        // note below is about this session, so it is in the result only.
        const footer = [...notes, built].join(' ');
        const rc = deps.remoteControl.status();
        if (rc.state === 'on') {
          notes.push(
            `Remote Control was last reported on at ${rc.at}: the human may be away from this ` +
              `computer, where an opened page is not in front of them. Publish the file as a ` +
              `private artifact.`,
          );
        }
        notes.push(built);

        const meta: FlowPageMeta = {
          aLabel,
          ...(bLabel !== undefined ? { bLabel } : {}),
          subtitle,
          note: footer,
        };
        let html: string;
        try {
          html = buildFlowPage(template.text, { title, xmlA: a.xml, xmlB: b ? b.xml : null, meta });
        } catch (err) {
          if (err instanceof ContrailError && err.code === 'template_invalid') {
            throw new ContrailError(
              `render_flow cannot build a page: the template at ${template.file} does not carry ` +
                `each placeholder exactly once, so it is not the template this engine expects. ` +
                `Nothing was written.`,
              'template_invalid',
            );
          }
          throw err;
        }

        // ---- 8. Write -------------------------------------------------------
        const dir = rendersDir();
        const realDir = fs.realpathSync(dir);
        if (!isInside(realDir, fs.realpathSync(dataDir()))) {
          throw new ContrailError(
            `Contrail's renders folder resolves outside its data directory (${realDir}); ` +
              `refusing to write there. Remove the link at ${dir} and retry.`,
            'unsafe_render_dir',
          );
        }
        sweepRenders(Date.now());
        const slug =
          (titleFlow ?? (a.basename ?? '').split('.')[0] ?? '')
            .replace(/[^A-Za-z0-9_-]/g, '')
            .slice(0, 60) || 'flow';
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        let file = '';
        for (let attempt = 0; ; attempt += 1) {
          file = path.join(
            dir,
            `${slug}-${b ? 'diff' : 'view'}-${stamp}Z-${crypto.randomBytes(2).toString('hex')}.html`,
          );
          try {
            // 'wx': never overwrite — a page on disk is what was published.
            fs.writeFileSync(file, html, { encoding: 'utf8', flag: 'wx' });
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 8) throw err;
          }
        }
        const pageBytes = Buffer.byteLength(html, 'utf8');

        // ---- 9. Open --------------------------------------------------------
        const openRequested = args.open !== false;
        let opened = false;
        if (openRequested) {
          try {
            await deps.openExternal(file);
            opened = true;
          } catch {
            opened = false;
          }
        }

        // ---- 10. Audit (never the XML) --------------------------------------
        const sides = b ? [a, b] : [a];
        audit.record('flow.rendered', {
          connectionId: a.conn?.id ?? b?.conn?.id ?? null,
          tool: 'render_flow',
          detail: {
            mode: b ? 'diff' : 'single',
            flow: titleFlow,
            sides: sides.map((s) => ({
              side: s.side,
              origin: s.origin,
              ...(s.conn ? { connection_id: s.conn.id } : {}),
              ...(s.version !== undefined ? { version: s.version } : {}),
              ...(s.file !== undefined ? { file: s.file, sha256: s.sha256 } : {}),
            })),
            file,
            page_bytes: pageBytes,
            open_requested: openRequested,
            opened,
          },
        });

        // ---- 11. Result -----------------------------------------------------
        return ok(
          {
            file,
            file_url: pathToFileURL(file).href,
            mode: b ? 'diff' : 'single',
            title,
            opened,
            sides: sides.map((s) => ({
              side: s.side,
              label: s.side === 'a' ? aLabel : bLabel,
              origin: s.origin,
              ...(s.conn ? { connection: s.conn.alias } : {}),
              ...(s.flow !== undefined ? { flow: s.flow } : {}),
              ...(s.version !== undefined ? { version: s.version } : {}),
              ...(s.status !== undefined ? { status: s.status } : {}),
              ...(s.origin === 'snapshot' ? { retrieved_at: s.retrievedAt ?? null } : {}),
              ...(s.file !== undefined ? { file: s.file, sha256: s.sha256 } : {}),
              bytes: s.bytes,
              elements: s.elements,
              over_diagram_limit: s.overLimit,
            })),
            ...(fidelity ? { fidelity } : {}),
            notes,
            page_bytes: pageBytes,
            ...(rc.state === 'on' ? { remote_control: { state: 'on', at: rc.at } } : {}),
            retention: RETENTION_TEXT,
            note: PUBLISH_NOTE,
          },
          !openRequested
            ? 'Flow page written; not opened, because open was false.'
            : opened
              ? 'Flow page written and this computer was asked to open it (its default app for .html files).'
              : 'Flow page written, but this computer could not open it automatically.',
        );
      }),
  );
}

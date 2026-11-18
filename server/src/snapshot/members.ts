import crypto from 'node:crypto';
import { ContrailError } from '../core/errors.js';
import { deployZipEntryPath, isRegisteredType, retrieveMemberFor } from '../deploy/package.js';
import { listedPropFor, preImageListQueryFor, type PreImageListing } from '../deploy/preimage.js';
import { FOLDERED_TYPES, FOLDER_TYPES, type FileProperties } from '../salesforce/metadataSoap.js';
import { indexSnapshotFiles, type IndexedArtifact } from './indexer.js';
import type { SnapshotStore } from './store.js';

/**
 * S46 Part C: member-scoped refresh — re-read ONLY named components into an
 * existing snapshot (refresh_snapshot `members`, and the automatic
 * re-baseline after a successful execute_deploy).
 *
 * A member maps to the snapshot UNIT rooted at one artifact row: the member
 * itself, or — for a child type — its container document (a CustomField,
 * ValidationRule, ListView or RecordType re-reads its whole CustomObject, a
 * CustomLabel the whole CustomLabels document, a BotVersion its Bot);
 * FlowDefinition re-reads the Flow. A unit's rows are every row sharing the
 * root row's file path; its files are chosen by INDEXING the retrieve zip
 * (the indexer is the snapshot's naming authority), never by deploy-side
 * path encoding.
 *
 * A snapshot file is only ever written from a whole document (lead ruling):
 * memberRetrieveManifest refuses a child-typed unit, and applyMemberUnits —
 * the only caller of SnapshotStore.replaceCurrentUnits — refuses, before it
 * opens the zip, a zip whose manifest names a child type. Nothing but this
 * run's own retrieve is ever a snapshot source: never a pre-image retrieve,
 * a revert pre-image file or the deploy package's bytes, and no path
 * patches a child's block into an existing document. This unit never calls
 * deploy/preimage.ts's preImageRetrieveMemberFor or deploy/stampprobe.ts.
 *
 * Flow: a named Flow retrieve and the whole-type wildcard returned
 * byte-equal files on the dev orgs probed before this was built (both the
 * latest version), so a Flow unit is retrieved by name like any document.
 *
 * Mirror unit: byte-identical in both repos. Imports only other mirror
 * units and node built-ins — never core/paths, core/config, core/db or the
 * REST client. Every user-facing text of the feature lives here.
 */

/** At most this many components in one member-scoped refresh. */
export const MEMBER_REFRESH_MAX = 100;
/** How long the post-deploy re-baseline waits behind another refresh on the connection. */
export const REBASELINE_QUEUE_WAIT_MS = 10_000;
/** A finished member job nobody collected goes to a re-send of the same members this long. */
export const MEMBER_RESULT_REUSE_MS = 60_000;
/** The deploy job's progress for the whole post-deploy re-read (the tool keys on it). */
export const REBASELINE_PROGRESS =
  'deployed — re-reading the deployed components into the local snapshot';

export interface SnapshotMember {
  type: string;
  api_name: string;
}

export interface MemberUnit {
  /** `${type}:${name.toLowerCase()}` */
  key: string;
  type: string;
  name: string;
  bundle: boolean;
  /** A folder definition a foldered member brings along; never reported as a member outcome. */
  companion: boolean;
}

export type MemberSkipReason =
  | 'unregistered_type'
  | 'profile'
  | 'type_not_in_snapshot'
  | 'type_unsupported'
  | 'package_owned'
  | 'not_returned'
  | 'presence_unknown'
  | 'not_confirmed'
  | 'child_not_in_parent'
  | 'not_indexable';

export interface MemberOutcome {
  type: string;
  api_name: string;
  outcome: 'refreshed' | 'removed' | 'skipped';
  /** The unit re-read for this member, as `Type:name`. */
  unit?: string;
  reason?: MemberSkipReason;
  detail?: string;
}

export interface MemberPlan {
  /** The members, deduplicated case-insensitively, in request order. */
  members: SnapshotMember[];
  units: MemberUnit[];
  /** Member key → unit key, for every member that has a unit. */
  unitOf: Map<string, string>;
  /** Members that never get a unit (Profile, types Contrail does not snapshot). */
  skipped: MemberOutcome[];
}

/** The index's case-insensitive key for a component. */
export function memberKey(type: string, apiName: string): string {
  return `${type}:${apiName.toLowerCase()}`;
}

/** 'members-' + 12 hex of the sorted, deduplicated member keys: order- and case-insensitive. */
export function memberJobId(members: SnapshotMember[]): string {
  const keys = [...new Set(members.map((m) => memberKey(m.type, m.api_name)))].sort();
  const digest = crypto.createHash('sha256').update(JSON.stringify(keys)).digest('hex');
  return `members-${digest.slice(0, 12)}`;
}

/** The refusal for a member whose name cannot be placed. */
export function invalidMemberText(member: SnapshotMember): string {
  return (
    `invalid member "${member.type}:${member.api_name}" — expected a metadata type name and a ` +
    'full API name (children dotted, foldered names "Folder/Name").'
  );
}

function folderedConfig(type: string): { folderType: string; unfiledFolder?: string } | undefined {
  return Object.hasOwn(FOLDERED_TYPES, type) ? FOLDERED_TYPES[type] : undefined;
}

function folderContentType(type: string): string | undefined {
  return Object.hasOwn(FOLDER_TYPES, type) ? FOLDER_TYPES[type] : undefined;
}

/**
 * Does (type, name) name a CHILD type — one whose bytes live inside a parent
 * document? A registered type with no entry path is a child whose parent
 * cannot be read from the name: that is a child type too.
 */
function namesChildType(type: string, name: string): boolean {
  const entry = deployZipEntryPath(type, name);
  return entry?.child === true || (entry === null && isRegisteredType(type));
}

function wholeDocumentError(type: string): ContrailError {
  return new ContrailError(
    `a snapshot unit must be a whole document, never a child type: ${type}`,
    'snapshot_partial_container',
  );
}

/**
 * The two states get_org_changes leaves out of its comparison — the
 * package-owned rule of Decision 15, held here for member runs (get_org_changes
 * applies the same two states in its own code): a member run never ADDS
 * a unit the org lists in one of them.
 */
export function isPackageOwnedState(p: FileProperties | undefined): boolean {
  return p?.manageableState === 'installed' || p?.manageableState === 'installedEditable';
}

/**
 * Members → units. Pure. Deduplicates members case-insensitively and keeps
 * request order. Throws `bad_member` for a member whose name cannot be
 * placed (a child with no parent in its name, or a CustomLabels member not
 * named CustomLabels).
 */
export function planMemberUnits(members: SnapshotMember[]): MemberPlan {
  const plan: MemberPlan = { members: [], units: [], unitOf: new Map(), skipped: [] };
  const byKey = new Map<string, MemberUnit>();
  const addUnit = (type: string, name: string, bundle: boolean, companion: boolean): MemberUnit => {
    const key = memberKey(type, name);
    const existing = byKey.get(key);
    if (existing) {
      // A folder named both as a member and as a companion is a member's unit.
      if (!companion) existing.companion = false;
      return existing;
    }
    const unit: MemberUnit = { key, type, name, bundle, companion };
    byKey.set(key, unit);
    plan.units.push(unit);
    return unit;
  };
  const seen = new Set<string>();
  for (const m of members) {
    const key = memberKey(m.type, m.api_name);
    if (seen.has(key)) continue;
    seen.add(key);
    const member: SnapshotMember = { type: m.type, api_name: m.api_name };
    plan.members.push(member);
    let unit: MemberUnit;
    if (m.type === 'FlowDefinition') {
      unit = addUnit('Flow', m.api_name, false, false);
    } else if (m.type === 'Profile') {
      plan.skipped.push({ ...member, outcome: 'skipped', reason: 'profile' });
      continue;
    } else if (m.type === 'CustomLabels') {
      // The labels container has no FILE_TYPES row, but the snapshot indexes
      // it (labels/CustomLabels.labels): the same unit a CustomLabel re-reads.
      if (m.api_name.toLowerCase() !== 'customlabels') {
        throw new ContrailError(invalidMemberText(member), 'bad_member');
      }
      unit = addUnit('CustomLabels', 'CustomLabels', false, false);
    } else if (!isRegisteredType(m.type)) {
      plan.skipped.push({ ...member, outcome: 'skipped', reason: 'unregistered_type' });
      continue;
    } else {
      const entry = deployZipEntryPath(m.type, m.api_name);
      const container = retrieveMemberFor(m.type, m.api_name);
      if (entry === null || container === null) {
        throw new ContrailError(invalidMemberText(member), 'bad_member');
      }
      if (entry.child) {
        // A child re-reads its WHOLE parent document, never itself alone.
        unit = addUnit(container.type, container.member, false, false);
      } else {
        unit = addUnit(m.type, m.api_name, entry.bundleDir !== undefined, false);
        const cfg = folderedConfig(m.type);
        const slash = m.api_name.indexOf('/');
        if (cfg && slash > 0) {
          const folder = m.api_name.slice(0, slash);
          // The unfiled pseudo-folder has no definition file.
          if (folder !== cfg.unfiledFolder) addUnit(cfg.folderType, folder, false, true);
        }
      }
    }
    plan.unitOf.set(key, unit.key);
  }
  return plan;
}

/**
 * The retrieve manifest for a set of units, deduplicated: each unit as
 * retrieveMemberFor names it (folders as members of their content type),
 * a container with no FILE_TYPES row (CustomLabels) by itself. Whole
 * documents only: a child-typed unit throws `snapshot_partial_container`
 * before anything is retrieved.
 */
export function memberRetrieveManifest(units: MemberUnit[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const u of units) {
    if (namesChildType(u.type, u.name)) throw wholeDocumentError(u.type);
    const target = retrieveMemberFor(u.type, u.name) ?? { type: u.type, member: u.name };
    const list = out[target.type] ?? [];
    const want = target.member.toLowerCase();
    if (!list.some((n) => n.toLowerCase() === want)) list.push(target.member);
    out[target.type] = list;
  }
  return out;
}

/**
 * Per unit type: may this run write it? Covered when the snapshot holds rows
 * of the type; for the analytics family, when it holds rows of the coupled
 * type; otherwise (never a foldered or folder type) only when the listing
 * was read, names at least one unit of this run of the type, and every
 * listed component of the type that is not package-owned is a unit of this
 * run. A listing with no entry of the type at all proves nothing.
 */
export function unitTypeCoverage(input: {
  counts: Record<string, number>;
  units: MemberUnit[];
  listing: PreImageListing;
}): Map<string, boolean> {
  const rowsOf = (type: string): number =>
    Object.hasOwn(input.counts, type) ? (input.counts[type] ?? 0) : 0;
  const out = new Map<string, boolean>();
  for (const u of input.units) {
    if (out.has(u.type)) continue;
    const t = u.type;
    if (rowsOf(t) > 0) {
      out.set(t, true);
      continue;
    }
    const coupled = folderedConfig(t)?.folderType ?? folderContentType(t);
    if (coupled !== undefined) {
      out.set(t, rowsOf(coupled) > 0);
      continue;
    }
    const props = input.listing.props;
    if (props === null || input.listing.unsupported.has(t)) {
      out.set(t, false);
      continue;
    }
    const run = new Set(
      input.units.filter((x) => x.type === t).map((x) => x.name.toLowerCase()),
    );
    const listed = props.filter((p) => p.type === t);
    out.set(
      t,
      listed.some((p) => run.has(p.fullName.toLowerCase())) &&
        listed.every((p) => isPackageOwnedState(p) || run.has(p.fullName.toLowerCase())),
    );
  }
  return out;
}

/**
 * 'remove' only when the listing positively enumerated the unit's type (read,
 * not unsupported, a name a listing can report) and does not name the unit.
 * On the execute path this is necessary but not sufficient.
 */
export function absenceVerdict(unit: MemberUnit, listing: PreImageListing): 'remove' | 'keep' {
  if (listing.props === null || listing.unsupported.has(unit.type)) return 'keep';
  if (preImageListQueryFor({ type: unit.type, api_name: unit.name }) === null) return 'keep';
  return listedPropFor(listing.props, unit.type, unit.name) === undefined ? 'remove' : 'keep';
}

/**
 * The units a removal may come from after a deploy: those a DELETED member
 * names itself. A deleted child never makes its parent removable.
 */
export function removableUnitKeys(deleted: SnapshotMember[]): Set<string> {
  const out = new Set<string>();
  const plan = planMemberUnits(deleted);
  for (const d of plan.members) {
    if (deployZipEntryPath(d.type, d.api_name)?.child === true) continue;
    const unit = plan.unitOf.get(memberKey(d.type, d.api_name));
    if (unit !== undefined) out.add(unit);
  }
  return out;
}

export interface MemberUnitInput {
  key: string;
  type: string;
  name: string;
  bundle: boolean;
  oldFilePath: string | null;
  ifAbsent: 'remove' | 'keep';
  /**
   * true when the index holds no root row for this unit: a unit the org marks
   * package-owned is then left out (Decision 15).
   */
  skipIfPackageOwned: boolean;
}

export interface MemberApplyInput {
  connectionId: string;
  zip: Buffer | Uint8Array | null;
  /**
   * The manifest `zip` was retrieved with — the proof that every document in
   * it was retrieved whole (Decision 13).
   */
  manifest: Record<string, string[]>;
  units: MemberUnitInput[];
  fileProps: FileProperties[];
  retrievedAt: string;
}

export interface MemberApplyResult {
  artifacts: IndexedArtifact[];
  units: Array<{
    key: string;
    applied: 'written' | 'removed' | 'kept';
    keptReason?: 'package_owned';
    filePath: string | null;
  }>;
  filesWritten: number;
  filesRemoved: number;
}

/**
 * The filesystem step of a member run (no SQLite). Refuses a manifest that
 * names a child type before the zip is opened; indexes the zip; per unit
 * writes the root row's files (a bundle's whole directory), removes it
 * (`ifAbsent: 'remove'` and no root row), or keeps it; then ONE
 * replaceCurrentUnits call. Returns the written units' rows — nothing else
 * from the zip (package.xml included) is ever written.
 */
export function applyMemberUnits(
  store: SnapshotStore,
  input: MemberApplyInput,
): MemberApplyResult {
  for (const [type, names] of Object.entries(input.manifest)) {
    if (namesChildType(type, '') || names.some((n) => namesChildType(type, n))) {
      throw wholeDocumentError(type);
    }
  }
  const extracted =
    input.zip === null
      ? new Map<string, Uint8Array>()
      : store.extractRetrieveZip(Buffer.isBuffer(input.zip) ? input.zip : Buffer.from(input.zip));
  const rows = indexSnapshotFiles(extracted, input.fileProps, input.retrievedAt);
  const props = new Map<string, FileProperties>();
  for (const p of input.fileProps) props.set(memberKey(p.type, p.fullName), p);

  const removeFiles = new Set<string>();
  const removeDirs = new Set<string>();
  const bundleTypeDirs = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const artifacts: IndexedArtifact[] = [];
  const units: MemberApplyResult['units'] = [];
  const dropDocument = (filePath: string | null): void => {
    if (!filePath) return;
    removeFiles.add(filePath);
    if (!filePath.endsWith('-meta.xml')) removeFiles.add(`${filePath}-meta.xml`);
  };
  const bundleDirOf = (filePath: string | null): string | null => {
    const segments = filePath?.split('/') ?? [];
    return segments.length >= 3 ? segments.slice(0, 2).join('/') : null;
  };
  const dropBundle = (unit: MemberUnitInput, filePath: string | null): void => {
    const dir = bundleDirOf(filePath);
    if (dir === null) return;
    removeDirs.add(dir);
    const declared = deployZipEntryPath(unit.type, unit.name);
    const typeDir = declared && !declared.child ? declared.bundleDir?.split('/')[0] : undefined;
    if (typeDir) bundleTypeDirs.add(typeDir);
  };

  let changed = false;
  for (const unit of input.units) {
    const want = unit.name.toLowerCase();
    const root = rows.find((r) => r.type === unit.type && r.apiName.toLowerCase() === want);
    if (root) {
      const prop = props.get(memberKey(unit.type, unit.name));
      if (unit.skipIfPackageOwned && isPackageOwnedState(prop)) {
        units.push({
          key: unit.key,
          applied: 'kept',
          keptReason: 'package_owned',
          filePath: unit.oldFilePath,
        });
        continue;
      }
      if (unit.bundle) {
        const dir = bundleDirOf(root.filePath);
        if (dir !== null) {
          for (const [rel, bytes] of extracted) {
            if (rel.startsWith(`${dir}/`)) files.set(rel, bytes);
          }
        }
        dropBundle(unit, unit.oldFilePath);
        dropBundle(unit, root.filePath);
      } else {
        const bytes = extracted.get(root.filePath);
        if (bytes) files.set(root.filePath, bytes);
        if (!root.filePath.endsWith('-meta.xml')) {
          const sidecar = extracted.get(`${root.filePath}-meta.xml`);
          if (sidecar) files.set(`${root.filePath}-meta.xml`, sidecar);
        }
        dropDocument(unit.oldFilePath);
        dropDocument(root.filePath);
      }
      for (const r of rows) if (r.filePath === root.filePath) artifacts.push(r);
      units.push({ key: unit.key, applied: 'written', filePath: root.filePath });
      changed = true;
    } else if (unit.ifAbsent === 'remove') {
      if (unit.bundle) dropBundle(unit, unit.oldFilePath);
      else dropDocument(unit.oldFilePath);
      units.push({ key: unit.key, applied: 'removed', filePath: unit.oldFilePath });
      changed = true;
    } else {
      units.push({ key: unit.key, applied: 'kept', filePath: unit.oldFilePath });
    }
  }

  let filesWritten = 0;
  let filesRemoved = 0;
  if (changed) {
    const done = store.replaceCurrentUnits(input.connectionId, {
      removeFiles: [...removeFiles],
      removeDirs: [...removeDirs],
      bundleTypeDirs: [...bundleTypeDirs],
      files,
    });
    filesWritten = done.written;
    filesRemoved = done.removed;
  }
  return { artifacts, units, filesWritten, filesRemoved };
}

export interface MemberOutcomeInput {
  plan: MemberPlan;
  origin: 'refresh_snapshot' | 'execute_deploy';
  /** The deploy's destructive members (execute path); [] on the tool path. */
  deleted: SnapshotMember[];
  /** Units left out before the retrieve, with their reason. */
  preSkipped: Map<string, MemberSkipReason>;
  /** null when no unit reached the retrieve. */
  applied: MemberApplyResult | null;
  /** The rows the snapshot held for the run's units before it wrote anything. */
  oldRows: Array<{ type: string; apiName: string }>;
  listing: PreImageListing;
  /** The retrieve's own fileProperties: what the org says it returned. */
  retrievedProps: FileProperties[];
}

const NOT_IN_PARENT_DETAIL = 'not in the parent document the org returned';
const ALREADY_ABSENT_DETAIL = 'already absent from the snapshot';

/**
 * One outcome per member, in request order (companions never appear). A
 * FlowDefinition member is judged by its Flow row. On the execute path a
 * member that is not among the deploy's deletions is never `removed`.
 */
export function memberOutcomes(input: MemberOutcomeInput): MemberOutcome[] {
  const { plan, listing } = input;
  const skippedByKey = new Map(plan.skipped.map((o) => [memberKey(o.type, o.api_name), o]));
  const unitByKey = new Map(plan.units.map((u) => [u.key, u]));
  const appliedByKey = new Map((input.applied?.units ?? []).map((u) => [u.key, u]));
  const newRows = new Set(
    (input.applied?.artifacts ?? []).map((a) => memberKey(a.type, a.apiName)),
  );
  const oldRows = new Set(input.oldRows.map((r) => memberKey(r.type, r.apiName)));
  const deleted = new Set(input.deleted.map((d) => memberKey(d.type, d.api_name)));
  const returned = new Set(
    input.retrievedProps.filter((p) => p.fileName).map((p) => memberKey(p.type, p.fullName)),
  );
  const out: MemberOutcome[] = [];
  for (const m of plan.members) {
    const key = memberKey(m.type, m.api_name);
    const planned = skippedByKey.get(key);
    if (planned) {
      out.push(planned);
      continue;
    }
    const unit = unitByKey.get(plan.unitOf.get(key) ?? '');
    if (!unit) continue;
    const base = { type: m.type, api_name: m.api_name, unit: `${unit.type}:${unit.name}` };
    const skip = (reason: MemberSkipReason, detail?: string): void => {
      out.push(
        detail === undefined
          ? { ...base, outcome: 'skipped', reason }
          : { ...base, outcome: 'skipped', reason, detail },
      );
    };
    const pre = input.preSkipped.get(unit.key);
    if (pre) {
      skip(pre);
      continue;
    }
    const own = memberKey(m.type === 'FlowDefinition' ? 'Flow' : m.type, m.api_name);
    const mayRemove = input.origin === 'refresh_snapshot' || deleted.has(key);
    const applied = appliedByKey.get(unit.key);
    if (newRows.has(own)) {
      out.push({ ...base, outcome: 'refreshed' });
    } else if (applied?.applied === 'written') {
      if (mayRemove) out.push({ ...base, outcome: 'removed', detail: NOT_IN_PARENT_DETAIL });
      else skip('child_not_in_parent');
    } else if (applied?.applied === 'removed') {
      if (!mayRemove) skip('child_not_in_parent');
      else if (oldRows.has(own)) out.push({ ...base, outcome: 'removed' });
      else out.push({ ...base, outcome: 'removed', detail: ALREADY_ABSENT_DETAIL });
    } else if (applied?.keptReason === 'package_owned') {
      skip('package_owned');
    } else {
      const enumerable =
        listing.props !== null &&
        !listing.unsupported.has(unit.type) &&
        preImageListQueryFor({ type: unit.type, api_name: unit.name }) !== null;
      const listed =
        enumerable && listedPropFor(listing.props ?? [], unit.type, unit.name) !== undefined;
      if (returned.has(unit.key)) skip('not_indexable');
      else if (listed) skip('not_returned');
      else if (!enumerable) {
        skip('presence_unknown', listing.failure ?? `${unit.type} cannot be listed by this name`);
      } else skip('not_confirmed');
    }
  }
  return out;
}

export interface MemberRefreshSummary {
  connection: string;
  members: MemberOutcome[];
  counts: { refreshed: number; removed: number; skipped: number };
  units: string[];
  artifact_counts: Record<string, number>;
  edge_counts: { extractor: number };
  retrieved_at: string | null;
  notes: string[];
  duration_ms: number;
}

export type RebaselineOutcome =
  | { status: 'ran'; summary: MemberRefreshSummary }
  | {
      status: 'unavailable';
      reason:
        | 'timeout'
        | 'locked'
        | 'refresh_running'
        | 'failed'
        | 'failed_after_write'
        | 'no_snapshot'
        | 'too_many_members'
        | 'no_metadata_read'
        | 'connection_removed';
      detail?: string;
    };

export interface ExecuteSnapshotBlock {
  status: 'complete' | 'partial' | 'none' | 'unavailable' | 'disabled' | 'pending';
  reason?: string;
  rebaselined: SnapshotMember[];
  removed: SnapshotMember[];
  skipped: Array<SnapshotMember & { code: MemberSkipReason; reason: string }>;
  retrieved_at?: string;
  note: string;
}

// ── Texts (verbatim; this unit is their one source) ─────────────────────

/** The member job's error, code `no_snapshot`. */
export function noSnapshotText(alias: string): string {
  return (
    `"${alias}" has no snapshot yet — a member-scoped refresh only updates an existing ` +
    'snapshot. Run refresh_snapshot without members first.'
  );
}

/** Commit-point refusal, code `no_metadata_read`: nothing was written. */
export function noMetadataReadText(alias: string): string {
  return `"${alias}" no longer grants metadata_read — nothing was written to the snapshot.`;
}

/** Commit-point refusal, code `connection_removed`: nothing was written. */
export const CONNECTION_REMOVED_TEXT =
  'The connection was removed while the member refresh was running — nothing was written.';

/** A failure after the commit point, code `snapshot_partial_write`. */
export function partialWriteText(message: string): string {
  return (
    `the snapshot may be only partly updated for these components (${message}) — its files ` +
    'and its index can disagree until they are re-read'
  );
}

/** A member refresh's notes[] when anything was written or removed. */
export const MEMBER_REFRESH_NOTES: readonly string[] = [
  'Dependency edges extracted FROM the re-read components were rebuilt. References TO a new or ' +
    'deleted component from other components, and the org-computed dependency data ' +
    '(MetadataComponentDependency), were not rebuilt — a whole-type refresh_snapshot does that.',
  'Only the named components were re-read (a child re-reads its whole parent document). ' +
    'Anything else that changed in the org is not in the snapshot until a whole-type ' +
    'refresh_snapshot.',
];

/** The execute result's snapshot.note for `complete`, `partial`, and `none` when a unit was written. */
const EXECUTE_REREAD_NOTE =
  'Dependency edges extracted FROM the re-read components were rebuilt. References TO a new or ' +
  'deleted component from other components, and the org-computed dependency data ' +
  '(MetadataComponentDependency), were not rebuilt — a whole-type refresh_snapshot does that. ' +
  'Only the components in this deploy were re-read (a child re-reads its whole parent ' +
  'document); anything else the deploy caused the org to create or change is not in the ' +
  'snapshot until a whole-type refresh_snapshot.';

/** Why a member was skipped, in the words the agent and the human read. */
export function memberSkipText(
  reason: MemberSkipReason,
  ctx: { type: string; unitType: string; detail?: string },
): string {
  const t = ctx.unitType;
  switch (reason) {
    case 'unregistered_type':
      return `${ctx.type} is not a type Contrail snapshots.`;
    case 'profile':
      return (
        'Profile is never snapshotted — a single-profile retrieve is package-relative, so its ' +
        'bytes would not be a faithful copy.'
      );
    case 'type_not_in_snapshot':
      return (
        `This connection's snapshot holds no ${t}, and Contrail could not confirm from the ` +
        "org's listing that the named components are the only ones of that type — writing " +
        `just these would make any other ${t} in the org read as new or missing. Run ` +
        `refresh_snapshot with types: ["${t}"].`
      );
    case 'type_unsupported':
      return `The org reports ${t} as unsupported at this API version.`;
    case 'package_owned':
      return (
        `The org lists its ${t} as package-owned and this snapshot holds no copy of it. ` +
        'get_org_changes leaves package-owned components out of its comparison, so a copy ' +
        'added here would read as gone from the org — not added. A member-scoped refresh ' +
        'will skip it again.'
      );
    case 'not_returned':
      return (
        'The org lists it, but the retrieve returned no file for it — the snapshot copy was ' +
        'left as it was.'
      );
    case 'presence_unknown':
      return (
        "The retrieve returned no file for it and the org's listing could not be read " +
        `(${ctx.detail ?? 'no detail'}) — the snapshot copy was left as it was.`
      );
    case 'not_confirmed':
      return (
        "This deploy changed it, but the org's listing did not name it and the retrieve " +
        'returned no file for it under this name — the snapshot copy was left as it was.'
      );
    case 'child_not_in_parent':
      return (
        'The re-read parent document does not contain it, so the snapshot holds no copy of it ' +
        'now. Contrail did not check the org for it separately.'
      );
    case 'not_indexable':
      return 'The org returned a file Contrail has no snapshot mapping for — nothing was written.';
  }
}

/** The distinct unit types of a member set, as `"A", "B"` for a refresh_snapshot types list. */
function unitTypesList(members: SnapshotMember[]): string {
  let types: string[];
  try {
    types = planMemberUnits(members).units.map((u) => u.type);
  } catch {
    types = members.map((m) => m.type);
  }
  return [...new Set(types)]
    .sort()
    .map((t) => `"${t}"`)
    .join(', ');
}

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

/**
 * The execute_deploy result's `snapshot` block and its top-level `note`, for
 * every state the re-baseline can be in. Built from member names and fixed
 * text only, plus, for `failed` and `failed_after_write`, at most the first
 * 200 characters of the local error.
 */
export function executeSnapshotResult(
  outcome: RebaselineOutcome | { status: 'pending' } | { status: 'disabled' },
  members: SnapshotMember[],
  timeoutMs: number,
): { snapshot: ExecuteSnapshotBlock; note: string } {
  const block = (
    status: ExecuteSnapshotBlock['status'],
    note: string,
    extra: Partial<ExecuteSnapshotBlock> = {},
  ): { snapshot: ExecuteSnapshotBlock; note: string } => ({
    snapshot: {
      status,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      rebaselined: extra.rebaselined ?? [],
      removed: extra.removed ?? [],
      skipped: extra.skipped ?? [],
      ...(extra.retrieved_at !== undefined ? { retrieved_at: extra.retrieved_at } : {}),
      note: extra.note ?? note.replace(/^Deployed\. /, ''),
    },
    note,
  });

  if (outcome.status === 'pending') {
    return block(
      'pending',
      "Deployed. Contrail had not finished re-reading this deploy's components into the local " +
        'snapshot when this result was stored. If snapshot.status still reads "pending", the ' +
        "snapshot may be stale for them — run refresh_snapshot with members set to this deploy's " +
        'components.',
    );
  }
  if (outcome.status === 'disabled') {
    return block(
      'disabled',
      'Deployed. Automatic snapshot re-baseline is turned off (snapshot.rebaselineAfterDeploy) — ' +
        'run refresh_snapshot to bring the local snapshot up to date.',
    );
  }
  if (outcome.status === 'unavailable') {
    const detail = (outcome.detail ?? 'no detail').slice(0, 200);
    const notUpdated = (why: string): string =>
      `Deployed. The local snapshot was NOT updated for this deploy (${why}). Run ` +
      "refresh_snapshot with members set to this deploy's components to bring it up to date.";
    let note: string;
    switch (outcome.reason) {
      case 'timeout':
        note = notUpdated(`the re-read did not finish within ${seconds(timeoutMs)} s`);
        break;
      case 'locked':
        note = notUpdated("another Contrail process is refreshing this connection's snapshot");
        break;
      case 'refresh_running':
        note = notUpdated('a snapshot refresh was already running on this connection');
        break;
      case 'failed':
        note = notUpdated(`the re-read failed: ${detail}`);
        break;
      case 'failed_after_write':
        note =
          'Deployed. The local snapshot may be only PARTLY updated for this deploy (the re-read ' +
          `stopped while writing: ${detail}) — its files and its index can disagree for these ` +
          "components. Run refresh_snapshot with members set to this deploy's components to " +
          'repair it.';
        break;
      case 'no_snapshot':
        note =
          'Deployed. This connection has no local snapshot, so there was nothing to ' +
          're-baseline. Run refresh_snapshot when you need one.';
        break;
      case 'too_many_members': {
        const n = new Set(members.map((m) => memberKey(m.type, m.api_name))).size;
        note =
          `Deployed. The local snapshot was NOT updated: this deploy has ${n} components, more ` +
          `than the ${MEMBER_REFRESH_MAX} a member-scoped re-read takes. Run refresh_snapshot ` +
          `with types: [${unitTypesList(members)}] to bring it up to date.`;
        break;
      }
      case 'no_metadata_read':
        note =
          'Deployed. The local snapshot was NOT updated: this connection no longer grants ' +
          'metadata_read, so Contrail did not copy org metadata into the snapshot.';
        break;
      case 'connection_removed':
        note =
          'Deployed. The local snapshot was NOT updated: this connection was removed before ' +
          'Contrail finished re-reading the deployed components.';
        break;
    }
    return block('unavailable', note, { reason: outcome.reason });
  }

  const summary = outcome.summary;
  const member = (o: MemberOutcome): SnapshotMember => ({ type: o.type, api_name: o.api_name });
  const rebaselined = summary.members.filter((o) => o.outcome === 'refreshed').map(member);
  const removed = summary.members.filter((o) => o.outcome === 'removed').map(member);
  const skipped = summary.members
    .filter((o) => o.outcome === 'skipped')
    .map((o) => {
      const code = o.reason ?? 'not_confirmed';
      const unitType = o.unit ? o.unit.slice(0, o.unit.indexOf(':')) : o.type;
      return {
        type: o.type,
        api_name: o.api_name,
        code,
        reason: memberSkipText(code, { type: o.type, unitType, detail: o.detail }),
      };
    });
  const n = summary.members.length;
  const done = rebaselined.length + removed.length;
  const extra = {
    rebaselined,
    removed,
    skipped,
    ...(summary.retrieved_at !== null ? { retrieved_at: summary.retrieved_at } : {}),
  };
  if (skipped.length === 0) {
    return block(
      'complete',
      `Deployed. Contrail re-read the ${n} component(s) in this deploy from the org into the ` +
        'local snapshot — no refresh_snapshot is needed for them.',
      { ...extra, note: EXECUTE_REREAD_NOTE },
    );
  }
  if (done === 0 && summary.units.length === 0) {
    return block(
      'none',
      'Deployed. The local snapshot was NOT updated for this deploy — snapshot.skipped gives the ' +
        'reason for each component. Run refresh_snapshot for those you need current.',
      extra,
    );
  }
  if (done === 0) {
    // Every member skipped, yet a unit was written: a child missing from its
    // re-read parent (the parent replaced whole, the child's copy dropped),
    // or a foldered member's folder. Its edges were rebuilt too.
    return block(
      'none',
      'Deployed. None of the components in this deploy was re-baselined — snapshot.skipped ' +
        'gives the reason for each. Contrail did write to the local snapshot one or more ' +
        'documents it re-read for them (a parent document or a folder). Run refresh_snapshot ' +
        'for those you need current.',
      { ...extra, note: EXECUTE_REREAD_NOTE },
    );
  }
  return block(
    'partial',
    `Deployed. Contrail re-read ${done} of ${n} component(s) in this deploy into the local ` +
      `snapshot; ${skipped.length} were not re-baselined — snapshot.skipped gives the reason ` +
      'for each. Run refresh_snapshot for those you need current.',
    { ...extra, note: EXECUTE_REREAD_NOTE },
  );
}

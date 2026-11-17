import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ContrailError } from '../core/errors.js';
import {
  FOLDERED_TYPES,
  type FileProperties,
  type ListQuery,
  type MetadataSoapClient,
} from '../salesforce/metadataSoap.js';
import { findChildBlock } from '../snapshot/indexer.js';
import {
  deployZipEntryPath,
  retrieveMemberFor,
  type ComponentPreImage,
} from './package.js';

/**
 * S45: the live pre-image — what the org holds for every member of a deploy
 * package at the moment validate_deploy runs. The approval page diffs the
 * proposal against it (never against a possibly stale snapshot), the
 * execute-time "target moved" guard compares last-modified stamps with it,
 * and the revert package under staging/_reverts/<requestId>/ is written from
 * it. One retrieve yields both the bytes and the presence verdict; the
 * listMetadata calls beside it are the ONE date source — the SAME calls the
 * execute-time guard makes, so stamps compare like with like (as epoch ms).
 *
 * Mirror unit: byte-identical in both repos. Imports only other mirror units
 * and node built-ins — never core/paths.ts (the staging directory arrives as
 * a parameter), never core/config.ts or core/db.ts.
 *
 * Honesty contract carried by the result shape: `status: 'unavailable'` is
 * reserved for the RETRIEVE path (timeout, fault, cancellation) — the only
 * case where "the org was not re-read" is true. A listing fault never
 * discards a successful retrieve: a type the org cannot enumerate leaves its
 * members with content and null dates (and lands in dates_unavailable_types);
 * a listing that throws outright leaves EVERY date null and names the reason
 * in dates_unavailable. retrievePreImages never throws.
 *
 * Cancellation: `signal` is checked before each checkRetrieveStatus and each
 * delay. It cannot interrupt an in-flight fetch — MetadataSoapClient passes
 * no signal — only the next tick; the discarded result is harmless.
 */

export type PreImageSoap = Pick<
  MetadataSoapClient,
  'retrieve' | 'checkRetrieveStatus' | 'listMetadataDetailed' | 'listMetadataQueries'
>;

export interface PreImageMember {
  type: string;
  api_name: string;
}

/**
 * One member's live pre-image. `content` is content_file-ready (the document
 * body, or a child's extracted block); bundles carry `files` instead — every
 * file under the bundle directory as a {rel: body} map, the comparison unit
 * (the `{"contrail_bundle":1,"files":{…}}` envelope is built only for the
 * revert content_file, see bundleEnvelopeJson). Documents keep their
 * `-meta.xml` sidecar in `files` under its zip-relative path. `present` is
 * null when the org could not enumerate the type at all; `comparable` is
 * false for Profile (a single-member Profile retrieve is package-relative —
 * a diff or restore from it would lie, but its presence and dates ARE
 * reliable, so the date-based moved check still applies) and for list-only
 * members; `restorable` is false whenever no bytes a revert could re-deploy
 * were captured.
 */
export interface PreImage {
  present: boolean | null;
  source: 'retrieve' | 'list';
  content?: string;
  files?: Map<string, string>;
  sha256?: string;
  last_modified_date: string | null;
  last_modified_by: string | null;
  comparable: boolean;
  restorable: boolean;
}

export interface RetrievePreImagesOptions {
  /** ISO stamp the caller took when the live check began (recorded as started_at). */
  startedAt: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** SnapshotStore.extractRetrieveZip, injected so this unit needs no store. */
  extractZip: (zip: Buffer) => Map<string, Uint8Array>;
  signal?: AbortSignal;
  onProgress?: (progress: string) => void;
}

export type PreImageResult =
  | {
      status: 'ok';
      started_at: string;
      at: string;
      images: Map<string, PreImage>;
      /** Types the listing could not enumerate (INVALID_TYPE); their members' dates are null. */
      dates_unavailable_types: string[];
      /** Set when the listing threw outright (non-INVALID_TYPE fault): every date is null. */
      dates_unavailable?: string;
    }
  | {
      status: 'unavailable';
      started_at: string;
      at: string;
      /** 'timeout' | 'cancelled' | 'retrieve_failed:<message>' */
      reason: string;
    };

/** The key `images` is addressed by — the member's own type and api_name. */
export function preImageKey(type: string, apiName: string): string {
  return `${type}:${apiName}`;
}

/**
 * The retrieve manifest for a member set: each member resolved through
 * retrieveMemberFor (children by their container, folders as members of
 * their content type), deduplicated — two fields of one object pull that
 * object once. Members with no retrieve mirror (types Contrail cannot
 * author — the destructive path admits any literal type name) are omitted
 * and receive list-only pre-images.
 */
export function buildPreImageRetrieveMembers(
  members: PreImageMember[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of members) {
    const target = retrieveMemberFor(m.type, m.api_name);
    if (!target) continue;
    const list = out[target.type] ?? [];
    if (!list.includes(target.member)) list.push(target.member);
    out[target.type] = list;
  }
  return out;
}

/**
 * How ONE member is listed for its dates — or null when no listing can
 * report its presence: a foldered member (FOLDERED_TYPES) is scoped to ITS
 * folder, never the whole Report/Dashboard tree; a slash-shaped name of a
 * type outside FOLDERED_TYPES belongs to a folder structure Contrail has no
 * folder table for (listMetadata takes the folder for such types, so a bare
 * listing cannot report presence), so its presence stays unknown.
 */
export function preImageListQueryFor(member: PreImageMember): ListQuery | null {
  const slash = member.api_name.indexOf('/');
  if (FOLDERED_TYPES[member.type]) {
    if (slash <= 0) return null;
    return { type: member.type, folder: member.api_name.slice(0, slash) };
  }
  if (slash >= 0) return null;
  return { type: member.type };
}

/**
 * The listing calls for a member set — flat types through
 * listMetadataDetailed (children by their OWN type: CustomField,
 * ValidationRule…; bundles by bundle type), foldered members through
 * listMetadataQueries scoped to each member's folder. Exported so the
 * execute-time guard issues exactly these calls.
 */
export function buildPreImageListQueries(members: PreImageMember[]): {
  types: string[];
  folderQueries: ListQuery[];
} {
  const types: string[] = [];
  const folderQueries: ListQuery[] = [];
  const seenFolders = new Set<string>();
  for (const m of members) {
    const q = preImageListQueryFor(m);
    if (!q) continue;
    if (q.folder !== undefined) {
      const key = `${q.type}\u0000${q.folder}`;
      if (seenFolders.has(key)) continue;
      seenFolders.add(key);
      folderQueries.push(q);
    } else if (!types.includes(q.type)) {
      types.push(q.type);
    }
  }
  return { types, folderQueries };
}

/**
 * The listing row describing one member (names compare case-insensitively,
 * as the platform does).
 */
export function listedPropFor(
  props: FileProperties[],
  type: string,
  apiName: string,
): FileProperties | undefined {
  const want = apiName.toLowerCase();
  return props.find((p) => p.type === type && p.fullName.toLowerCase() === want);
}

/**
 * The frozen summary persisted on ComponentChange.pre_image — the bytes stay
 * on disk (staging/_reverts/) and in the page's diff, never in summaryJson.
 */
export function summarizePreImage(image: PreImage): ComponentPreImage {
  const out: ComponentPreImage = {
    present: image.present,
    source: image.source,
    last_modified_date: image.last_modified_date,
    last_modified_by: image.last_modified_by,
    comparable: image.comparable,
    restorable: image.restorable,
  };
  if (image.sha256 !== undefined) out.sha256 = image.sha256;
  return out;
}

/**
 * The Contrail bundle envelope for a live bundle's files — accepted by
 * parseBundleEnvelope, so a revert content_file round-trips through
 * validate_deploy. Keys sorted so the JSON (and its sha256) is deterministic.
 */
export function bundleEnvelopeJson(files: Map<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const rel of [...files.keys()].sort()) sorted[rel] = files.get(rel)!;
  return JSON.stringify({ contrail_bundle: 1, files: sorted }, null, 2);
}

type RetrieveOutcome =
  | { ok: true; files: Map<string, Uint8Array> }
  | { ok: false; reason: string };

interface Listing {
  /** null when the listing threw (non-INVALID_TYPE fault). */
  props: FileProperties[] | null;
  unsupported: Set<string>;
  failure?: string;
}

/**
 * Retrieve the live pre-image of every member. Never throws; see the module
 * comment for the result contract. The retrieve and the listing run
 * concurrently; both are awaited (neither rejects) before the verdict.
 */
export async function retrievePreImages(
  soap: PreImageSoap,
  members: PreImageMember[],
  opts: RetrievePreImagesOptions,
): Promise<PreImageResult> {
  const started_at = opts.startedAt;
  const manifest = buildPreImageRetrieveMembers(members);
  const listingP = listDates(soap, members);
  const retrieveP: Promise<RetrieveOutcome> =
    Object.keys(manifest).length === 0
      ? Promise.resolve({ ok: true, files: new Map<string, Uint8Array>() })
      : runRetrieve(soap, manifest, opts);
  const [retrieved, listing] = await Promise.all([retrieveP, listingP]);
  const at = new Date().toISOString();
  if (!retrieved.ok) return { status: 'unavailable', started_at, at, reason: retrieved.reason };

  const zipEntries = [...retrieved.files.keys()];
  const images = new Map<string, PreImage>();
  for (const m of members) {
    const key = preImageKey(m.type, m.api_name);
    if (images.has(key)) continue;
    images.set(key, resolveMember(m, retrieved.files, zipEntries, listing));
  }
  const result: PreImageResult = {
    status: 'ok',
    started_at,
    at,
    images,
    dates_unavailable_types: [...listing.unsupported].sort(),
  };
  if (listing.failure !== undefined) result.dates_unavailable = listing.failure;
  return result;
}

async function runRetrieve(
  soap: PreImageSoap,
  manifest: Record<string, string[]>,
  opts: RetrievePreImagesOptions,
): Promise<RetrieveOutcome> {
  if (opts.signal?.aborted) return { ok: false, reason: 'cancelled' };
  try {
    const retrieveId = await soap.retrieve(manifest);
    // The polling loop from the snapshot refresh, bounded by opts.timeoutMs
    // and interruptible between polls.
    const deadline = Date.now() + opts.timeoutMs;
    let poll = 0;
    for (;;) {
      if (opts.signal?.aborted) return { ok: false, reason: 'cancelled' };
      const status = await soap.checkRetrieveStatus(retrieveId, true);
      if (status.done) {
        if (!status.success || !status.zipFile) {
          return { ok: false, reason: `retrieve_failed:${status.errorMessage ?? status.status}` };
        }
        return { ok: true, files: opts.extractZip(status.zipFile) };
      }
      if (Date.now() > deadline) return { ok: false, reason: 'timeout' };
      poll += 1;
      opts.onProgress?.(`retrieving live pre-images (poll ${poll}, status ${status.status})`);
      if (opts.signal?.aborted) return { ok: false, reason: 'cancelled' };
      await delay(opts.pollIntervalMs, opts.signal);
    }
  } catch (err) {
    return { ok: false, reason: `retrieve_failed:${errorMessage(err)}` };
  }
}

async function listDates(soap: PreImageSoap, members: PreImageMember[]): Promise<Listing> {
  const { types, folderQueries } = buildPreImageListQueries(members);
  const unsupported = new Set<string>();
  try {
    const none = { props: [] as FileProperties[], unsupportedTypes: [] as string[] };
    const [flat, foldered] = await Promise.all([
      types.length > 0 ? soap.listMetadataDetailed(types) : Promise.resolve(none),
      folderQueries.length > 0 ? soap.listMetadataQueries(folderQueries) : Promise.resolve(none),
    ]);
    for (const t of [...flat.unsupportedTypes, ...foldered.unsupportedTypes]) unsupported.add(t);
    return { props: [...flat.props, ...foldered.props], unsupported };
  } catch (err) {
    return { props: null, unsupported, failure: errorMessage(err) };
  }
}

function resolveMember(
  m: PreImageMember,
  files: Map<string, Uint8Array>,
  zipEntries: string[],
  listing: Listing,
): PreImage {
  const listed = listing.props ? listedPropFor(listing.props, m.type, m.api_name) : undefined;
  const enumerable =
    listing.props !== null && !listing.unsupported.has(m.type) && preImageListQueryFor(m) !== null;
  const dates = {
    last_modified_date: listed?.lastModifiedDate ? listed.lastModifiedDate : null,
    last_modified_by: listed?.lastModifiedByName ? listed.lastModifiedByName : null,
  };

  const entry =
    retrieveMemberFor(m.type, m.api_name) === null
      ? null
      : deployZipEntryPath(m.type, m.api_name, { zipEntries });
  if (!entry) {
    // No retrieve mirror: the listing is the only evidence. present is null
    // when that listing could not report presence for this type.
    return {
      present: enumerable ? listed !== undefined : null,
      source: 'list',
      ...dates,
      comparable: false,
      restorable: false,
    };
  }

  const captured = captureFromZip(entry, files);
  // The retrieve is the primary presence signal for a mapped member; a
  // listing row for a member the zip lacks still means it exists (no bytes,
  // so nothing to compare or restore).
  const present = captured !== null || listed !== undefined;
  if (captured === null) {
    return { present, source: 'retrieve', ...dates, comparable: false, restorable: false };
  }
  const usable = m.type !== 'Profile';
  return {
    present: true,
    source: 'retrieve',
    ...captured,
    ...dates,
    comparable: usable,
    restorable: usable,
  };
}

type Captured = Pick<PreImage, 'content' | 'files' | 'sha256'>;

function captureFromZip(
  entry: NonNullable<ReturnType<typeof deployZipEntryPath>>,
  files: Map<string, Uint8Array>,
): Captured | null {
  if (entry.child) {
    const parent = files.get(entry.path);
    if (!parent) return null;
    const block = findChildBlock(text(parent), entry.childTag, entry.childName);
    if (block === null) return null;
    return { content: block, sha256: sha256(block) };
  }
  if (entry.bundleDir) {
    const bundle = new Map<string, string>();
    for (const [name, bytes] of files) {
      if (name.startsWith(entry.bundleDir) && name.length > entry.bundleDir.length) {
        bundle.set(name.slice(entry.bundleDir.length), text(bytes));
      }
    }
    if (bundle.size === 0) return null;
    return { files: bundle, sha256: sha256(bundleEnvelopeJson(bundle)) };
  }
  const main = files.get(entry.path);
  if (!main) return null;
  const content = text(main);
  const out: Captured = { content, sha256: sha256(content) };
  const meta = files.get(`${entry.path}-meta.xml`);
  if (meta) out.files = new Map([[`${entry.path}-meta.xml`, text(meta)]]);
  return out;
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function errorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ── Revert package ───────────────────────────────────────────────────────

/**
 * `<stagingDir>/_reverts/<requestId>` — the staging dir arrives from the
 * caller, so this byte-copied module imports no hand-mirrored core module
 * (core/paths differs between the engines).
 */
export function revertDirFor(stagingDir: string, requestId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(requestId)) {
    throw new ContrailError(`invalid request id "${requestId}"`, 'bad_request_id');
  }
  return path.join(stagingDir, '_reverts', requestId);
}

export interface RevertPreImageEntry {
  type: string;
  api_name: string;
  image: PreImage;
}

export interface RevertPlanMember {
  type: string;
  api_name: string;
}

export interface RevertPlanComponent extends RevertPlanMember {
  /** Absolute path, content_file-ready. */
  content_file: string;
}

export interface RevertPlanReason extends RevertPlanMember {
  reason: string;
}

/** A child member restored by its container's document rather than a file of its own. */
export interface RevertPlanCovered extends RevertPlanMember {
  container: RevertPlanMember;
}

export interface RevertWriteResult {
  /** present && restorable members, written to disk. */
  components: RevertPlanComponent[];
  /** members this package cannot restore (no bytes, or bytes that are not a restorable image). */
  not_restorable: RevertPlanReason[];
  /** present === false members — nothing was there to restore. */
  absent: RevertPlanMember[];
  /**
   * Restorable children whose container document is restored too: the
   * container's retrieved bytes include them, and validate_deploy refuses a
   * container document and its own children in one package — so they get no
   * file of their own.
   */
  covered: RevertPlanCovered[];
}

export const NOT_RESTORABLE_PROFILE =
  'Profile — a single-member retrieve is package-relative, so the captured bytes are not a ' +
  'restorable image';
export const NOT_RESTORABLE_LIST_ONLY =
  'not a type Contrail can read or author — only the org listing was consulted, no bytes were ' +
  'captured';
export const NOT_RESTORABLE_UNENUMERABLE =
  'the org could not enumerate this type, so Contrail cannot say whether the member existed';
export const NOT_RESTORABLE_NO_BYTES =
  'the org listing names it, but the retrieve returned no bytes for it';

/**
 * Write the pre-image files a revert re-deploys. Layout: documents at their
 * zip-relative path (`classes/Foo.cls` + `classes/Foo.cls-meta.xml`,
 * `objects/Invoice__c.object`); children `children/<Type>/<Parent.Child>.xml`
 * (the extracted block, readOldContent altitude); bundles
 * `bundles/<Type>/<Name>.contrail-bundle.json` (the envelope — its only
 * use). restorable:false members are excluded and returned under
 * not_restorable with a reason; present:false members under absent. A
 * restorable child whose container document is also restored gets no file
 * (listed under covered — validate_deploy refuses a container and its own
 * children in one package, and the container's bytes include it). A member
 * listed twice (components and destructive) is written once.
 * Containment (defense in depth — names already passed the deploy grammar):
 * every target is lexically inside `dir`; each intermediate directory is
 * created one level at a time and an existing entry that is a link or not a
 * directory refuses the write; the parent's realpath must stay inside
 * `dir`'s; and every file is created exclusively ('wx'), so nothing an
 * agent planted at a target path is followed or overwritten.
 */
export function writeRevertPreImages(
  dir: string,
  entries: RevertPreImageEntry[],
): RevertWriteResult {
  const result: RevertWriteResult = {
    components: [],
    not_restorable: [],
    absent: [],
    covered: [],
  };
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const written = new Set<string>();
  const unsafe = (rel: string) =>
    new ContrailError(`unsafe revert path: ${rel}`, 'unsafe_zip_entry');
  const write = (rel: string, body: string): string => {
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw unsafe(rel);
    if (written.has(target)) return target;
    let cur = root;
    for (const seg of path.relative(root, path.dirname(target)).split(path.sep)) {
      if (!seg) continue;
      cur = path.join(cur, seg);
      try {
        fs.mkdirSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const stat = fs.lstatSync(cur);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(rel);
      }
    }
    const parentReal = fs.realpathSync(path.dirname(target));
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
      throw unsafe(rel);
    }
    fs.writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' });
    written.add(target);
    return target;
  };
  // One entry per member: a member in both lists is written once.
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const key = preImageKey(e.type, e.api_name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Pass 1 (order-independent — the destructive restores come after the
  // components): every container this package restores as a whole document.
  const wholeDocuments = new Map<string, RevertPlanMember>();
  for (const { type, api_name, image } of unique) {
    if (image.present !== true || !image.restorable) continue;
    const entry = deployZipEntryPath(type, api_name);
    if (!entry || entry.child || entry.bundleDir) continue;
    const target = retrieveMemberFor(type, api_name);
    if (target) wholeDocuments.set(`${target.type}:${target.member}`, { type, api_name });
  }
  for (const { type, api_name, image } of unique) {
    const member = { type, api_name };
    if (image.present === false) {
      result.absent.push(member);
      continue;
    }
    if (image.present === null) {
      result.not_restorable.push({ ...member, reason: NOT_RESTORABLE_UNENUMERABLE });
      continue;
    }
    if (!image.restorable) {
      const reason =
        type === 'Profile'
          ? NOT_RESTORABLE_PROFILE
          : image.source === 'list'
            ? NOT_RESTORABLE_LIST_ONLY
            : NOT_RESTORABLE_NO_BYTES;
      result.not_restorable.push({ ...member, reason });
      continue;
    }
    const entry = deployZipEntryPath(type, api_name);
    if (!entry) {
      result.not_restorable.push({ ...member, reason: NOT_RESTORABLE_LIST_ONLY });
      continue;
    }
    let contentFile: string;
    if (entry.child) {
      const target = retrieveMemberFor(type, api_name);
      const container = target ? wholeDocuments.get(`${target.type}:${target.member}`) : undefined;
      if (container) {
        result.covered.push({ ...member, container });
        continue;
      }
      contentFile = write(`children/${type}/${api_name}.xml`, image.content ?? '');
    } else if (entry.bundleDir && image.files) {
      contentFile = write(
        `bundles/${type}/${fileSafePathSegment(api_name)}.contrail-bundle.json`,
        bundleEnvelopeJson(image.files),
      );
    } else {
      contentFile = write(entry.path, image.content ?? '');
      for (const [rel, body] of image.files ?? []) write(rel, body);
    }
    result.components.push({ ...member, content_file: contentFile });
  }
  return result;
}

/** One filesystem segment from an api_name (bundle names carry no '/', but never trust that). */
function fileSafePathSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9 _.\-$]/g, (ch) =>
    Array.from(new TextEncoder().encode(ch))
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join(''),
  );
}

/**
 * The execute-time guard's verdict as persisted on the deploy result (F2).
 * 'ok': the guard compared stamps (`checked`), naming what it could not
 * (`unchecked`); 'not_checked': nothing was compared — every member is
 * unchecked, either because no baseline existed to compare against or
 * because each one could not be compared for its own reason (a type the
 * guard cannot enumerate, a stamp unavailable at validate), each named under
 * `unchecked`; 'unavailable': the guard could not re-read the org
 * (fail-open).
 */
export type RevertTargetCheck =
  | {
      status: 'ok' | 'not_checked';
      checked_at: string;
      checked: RevertPlanMember[];
      unchecked: RevertPlanReason[];
      note?: string;
    }
  | { status: 'unavailable'; reason: string; note?: string };

export interface RevertPlan {
  request_id: string;
  connection: string;
  /** null on the outcome-unknown path (Contrail lost track of the deploy). */
  executed_at: string | null;
  retrieved_at: string;
  retrieve_started_at: string;
  target_check: RevertTargetCheck | null;
  components: RevertPlanComponent[];
  /** pre_image.present === false adds — a revert deletes them. */
  destructive: RevertPlanMember[];
  not_restorable: RevertPlanReason[];
  /** Children restored by their container's document (no file of their own). */
  covered: RevertPlanCovered[];
  note: string;
  outcome?: 'unknown';
  deploy_id?: string;
}

/**
 * Write revert-plan.json + README.txt into the revert dir. Returns the
 * README text too, so the result note and the desktop panel show the same
 * words the file holds. Both are created exclusively ('wx'): the caller
 * removes any previous copy first, so a file or link re-planted at either
 * name fails with EEXIST instead of being followed or overwritten. When the
 * README cannot be written, the plan this call just wrote is removed before
 * the error is rethrown: a revert-plan.json without its README would read as
 * a finalized package (the revert sweep keys on that file) while the caller
 * reports that none was finalized. That removal is best-effort, so the
 * caller checks the disk before saying what is there.
 */
export function finalizeRevertPackage(
  dir: string,
  plan: RevertPlan,
): { plan_path: string; readme_path: string; readme: string } {
  fs.mkdirSync(dir, { recursive: true });
  const plan_path = path.join(dir, 'revert-plan.json');
  const readme_path = path.join(dir, 'README.txt');
  const readme = revertReadmeText(plan);
  fs.writeFileSync(plan_path, JSON.stringify(plan, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    fs.writeFileSync(readme_path, readme + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    try {
      fs.rmSync(plan_path, { force: true });
    } catch {
      // Best-effort: the caller re-checks the disk.
    }
    throw err;
  }
  return { plan_path, readme_path, readme };
}

function reasonList(items: RevertPlanReason[]): string {
  return items.map((i) => `${i.type} ${i.api_name} — ${i.reason}`).join(', ');
}

/**
 * The revert README / result note — ONE text source for both repos. The
 * executed-and-checked path is the plan's verbatim text; the two conditional
 * sentences are appended only when their lists are non-empty. When the
 * execute-time check could not re-read the org (fail-open with disclosure)
 * or the deploy's outcome is unknown, the comparison sentence says so
 * instead of claiming a comparison that did not happen.
 */
export function revertReadmeText(plan: RevertPlan): string {
  const check = plan.target_check;
  // Only a guard that actually compared stamps ('ok', with at least one
  // member checked) may be described as a comparison — 'not_checked' (and
  // a 0-of-N pass) compared nothing.
  const passed =
    check !== null && check.status === 'ok' && check.checked.length > 0 ? check : null;
  // <m> counts every member the guard considered (checked + unchecked), never
  // this package's own lists: a delete of a member the org already lacked is
  // checked but has nothing to restore, so those lists can be shorter.
  const considered = passed ? passed.checked.length + passed.unchecked.length : 0;
  const when =
    plan.executed_at === null
      ? 'Before submitting this deploy (whose outcome Contrail lost track of — see the note in ' +
        'revert-plan.json)'
      : `Before executing at ${plan.executed_at}`;
  const compared = passed
    ? `${when}, Contrail compared the org's last-modified stamps against that retrieve for ` +
      `${passed.checked.length} of ${considered} members and found them unchanged; it did not ` +
      `re-read their contents, and a matching stamp is evidence, not a byte comparison.`
    : check !== null && check.status === 'unavailable'
      ? `${when}, Contrail could not re-read the org to compare last-modified stamps ` +
        `(${check.reason}); the deploy was submitted unverified, and these files describe the ` +
        `org as of the validate-time retrieve only.`
      : `${when}, Contrail did not re-check the org's last-modified stamps; these files describe ` +
        `the org as of the validate-time retrieve only.`;
  let text =
    `A revert re-deploys what Contrail retrieved from "${plan.connection}" at ` +
    `${plan.retrieved_at}, when this deploy was validated. ${compared} It does not undo data ` +
    `changes, automation that ran, permission effects, or changes made since to components ` +
    `outside this package. For the components it restores it is a wholesale replace: ` +
    `re-deploying these files OVERWRITES anything changed in them since that retrieve, another ` +
    `user's edits included — the revert's own validate_deploy page diffs it against the org as ` +
    `it is then (or against the local snapshot when the org cannot be re-read). ` +
    `Re-deploying a Flow whose latest version is active creates a NEW version; an inactive ` +
    `latest version is overwritten in place. Deleting the components this deploy added is ` +
    `destructive; revert-plan.json lists them under "destructive". Contrail never deploys a ` +
    `revert on its own: pass each component's content_file (and the destructive list) to ` +
    `validate_deploy, and a human approves it like any deploy. DML is out of scope — the ` +
    `persisted before-values and created_ids make a manual revert possible.`;
  if (passed && passed.unchecked.length > 0) {
    text +=
      ` ${passed.unchecked.length} member(s) could not be re-checked ` +
      `(${reasonList(passed.unchecked)}); their pre-image is as of ${plan.retrieved_at} only.`;
  }
  if (plan.not_restorable.length > 0) {
    text +=
      ` ${plan.not_restorable.length} member(s) cannot be restored from this package ` +
      `(${reasonList(plan.not_restorable)}) — if this deploy changed or deleted them, ` +
      `reverting that needs another source.`;
  }
  const covered = plan.covered ?? [];
  if (covered.length > 0) {
    const children = covered.map((c) => `${c.type} ${c.api_name}`).join(', ');
    const containers = [
      ...new Set(covered.map((c) => `${c.container.type} ${c.container.api_name}`)),
    ].join(', ');
    text +=
      ` ${covered.length} child member(s) (${children}) are restored by their container's ` +
      `document (${containers}), whose retrieved bytes include them; they have no file of ` +
      `their own because validate_deploy refuses a container document and its own children ` +
      `in one package.`;
  }
  if (plan.outcome === 'unknown' && plan.note) text += `\n\n${plan.note}`;
  return text;
}

// ── Target-moved refusals ────────────────────────────────────────────────

/** HH:MM in the host's local time — the page's and the refusals' clock face. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DeployMovedMember {
  type: string;
  api_name: string;
  /** The live listing's stamps (null when the member is gone). */
  last_modified_by: string | null;
  last_modified_date: string | null;
  /** The validate-time baseline stamp (null when none was captured). */
  frozen_date: string | null;
  /** Default 'changed'. */
  state?: 'changed' | 'gone' | 'created';
}

export interface DeployTargetMoved {
  /** HH:MM of the execute-time listing. */
  at: string;
  alias: string;
  moved: DeployMovedMember[];
  /**
   * The degrade variant: no live baseline was captured at validate, so the
   * guard compared against the org-side validation time (the checkOnly
   * DeployResult's createdDate) minus a 5-second ordering margin.
   */
  degrade?: { org_clock_created_date: string; live_check_reason: string };
}

export interface DmlTargetMoved {
  /** HH:MM of the re-run preview query. */
  at: string;
  changed: Array<{ object: string; id: string; field: string; now: string; before: string }>;
  missing: Array<{ object: string; id: string }>;
}

export interface ActivationTargetMoved {
  /** HH:MM of the SELECT Status query. */
  at: string;
  version: string;
  agent: string;
  now: string;
  from: string;
}

/**
 * ONE text source for the three TARGET MOVED refusals (deploy incl. its
 * degrade variant, DML, activation), used by both engines and replayed
 * verbatim when a voided code is re-sent. Consequence first, so a truncated
 * line keeps its actionable clause.
 */
export function targetMovedRefusalText(kind: 'deploy', details: DeployTargetMoved): string;
export function targetMovedRefusalText(kind: 'dml', details: DmlTargetMoved): string;
export function targetMovedRefusalText(kind: 'activation', details: ActivationTargetMoved): string;
export function targetMovedRefusalText(
  kind: 'deploy' | 'dml' | 'activation',
  details: DeployTargetMoved | DmlTargetMoved | ActivationTargetMoved,
): string {
  const head = 'TARGET MOVED — not executed, and this code is now void. ';
  if (kind === 'deploy') {
    const d = details as DeployTargetMoved;
    const clauses = d.moved.map((m) => deployMovedClause(m, d.degrade));
    // The degrade comparison voids stamps up to 5 s BEFORE the org-side
    // validation started too: the head must not claim "since" for those.
    const degrade = d.degrade;
    const inMargin = degrade !== undefined && d.moved.some((m) => withinMargin(m, degrade));
    return (
      head +
      `listMetadata (${d.at}) reports members changed in "${d.alias}" since` +
      (inMargin ? ', or within 5 seconds before,' : '') +
      ` this package was ` +
      `validated: ${clauses.join('; ')}. The approved diff no longer describes what this deploy ` +
      `would overwrite. Re-run validate_deploy to see the current state and get a fresh code. ` +
      `This check is best-effort: Contrail re-reads the org immediately before claiming the code ` +
      `and compares last-modified stamps, not bytes; a change landing after that read — while ` +
      `the deploy is submitted and processed by the org — is not caught.`
    );
  }
  if (kind === 'dml') {
    const d = details as DmlTargetMoved;
    const clauses = d.changed.map(
      (c) => `${c.object} ${c.id} ${c.field} is now ${c.now} (the approval showed ${c.before})`,
    );
    d.missing.forEach((m, i) => {
      let clause =
        `${m.object} ${m.id} was returned by the preview query at propose but not at ${d.at}`;
      if (i === d.missing.length - 1) {
        clause +=
          (d.missing.length > 1 ? ' — each' : ' — it') +
          ` was deleted, or is no longer visible to this connection's user (a converted ` +
          `Lead also drops out); those cases look identical from here`;
      }
      clauses.push(clause);
    });
    return (
      head +
      `Re-running the preview query at ${d.at} shows the records you approved have changed since ` +
      `dml_propose: ${clauses.join('; ')}. Re-run dml_propose to see the current values and get ` +
      `a fresh code.`
    );
  }
  const a = details as ActivationTargetMoved;
  return (
    head +
    `SELECT Status at ${a.at} reports BotVersion ${a.version} of ${a.agent} is ${a.now}; the ` +
    `approval was for a change from ${a.from}. Re-run agent_activation_propose.`
  );
}

function deployMovedClause(
  m: DeployMovedMember,
  degrade: DeployTargetMoved['degrade'],
): string {
  const who = m.last_modified_by ?? 'an unknown user';
  const when = m.last_modified_date ?? 'an unknown time';
  const name = `${m.type} ${m.api_name}`;
  const baseline =
    m.frozen_date !== null
      ? `the approval was based on the version last modified at ${m.frozen_date}`
      : 'the approval was based on the version then in the org';
  switch (m.state ?? 'changed') {
    case 'gone':
      return `${name} — listMetadata no longer reports it (${baseline})`;
    case 'created':
      return (
        `${name} — listMetadata now reports it, last modified by ${who} at ${when} (the ` +
        `approval was based on the org reporting no such member)`
      );
    default:
      if (degrade && !withinMargin(m, degrade)) {
        return (
          `${name} — last modified by ${who} at ${when}, after this package was validated at ` +
          `${degrade.org_clock_created_date} (no live baseline was captured at validate: ` +
          `${degrade.live_check_reason}; Contrail compared against the org-side validation ` +
          `time, minus a 5-second ordering margin)`
        );
      }
      if (degrade) {
        // A stamp inside the 5-second margin BEFORE the org-side validation
        // start: voided (fail-closed), but never described as "after".
        return (
          `${name} — last modified by ${who} at ${when}, within 5 seconds before this ` +
          `package's org-side validation started at ${degrade.org_clock_created_date}, too ` +
          `close to rule out that the approved diff missed it (no live baseline was captured ` +
          `at validate: ${degrade.live_check_reason}; Contrail compared against the org-side ` +
          `validation time, minus a 5-second ordering margin)`
        );
      }
      return `${name} — last modified by ${who} at ${when} (${baseline})`;
  }
}

/**
 * Degrade variant: is this moved member's stamp NOT at or after the
 * org-side validation start (inside the 5-second margin before it, or not
 * parseable on either side)? Only then may the refusal not say "after".
 */
function withinMargin(
  m: DeployMovedMember,
  degrade: NonNullable<DeployTargetMoved['degrade']>,
): boolean {
  if ((m.state ?? 'changed') !== 'changed') return false;
  const stamp = Date.parse(m.last_modified_date ?? '');
  const created = Date.parse(degrade.org_clock_created_date);
  return Number.isNaN(stamp) || Number.isNaN(created) || stamp < created;
}

import type { ContrailDb } from '../core/db.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord } from '../core/types.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import {
  FOLDERED_TYPES,
  FOLDER_TYPES,
  MetadataSoapClient,
  type FileProperties,
} from '../salesforce/metadataSoap.js';
import { RestClient } from '../salesforce/rest.js';
import { SnapshotStore } from './store.js';
import { indexSnapshotFiles } from './indexer.js';
import crypto from 'node:crypto';
import { buildKnownArtifacts, extractAllEdges } from '../deps/extract.js';
import { fetchOrgDependencyEdges } from '../deps/orgdeps.js';
import { ContrailError } from '../core/errors.js';
import { log } from '../core/log.js';

/**
 * The snapshot pipeline: listMetadata → retrieve → unzip → index → extract
 * references. Runs as a per-connection background job with a short inline
 * wait, mirroring the connect_org pattern, so MCP client timeouts never bite
 * on large orgs.
 */

export interface RefreshSummary {
  connection: string;
  types: string[];
  artifact_counts: Record<string, number>;
  edge_counts: { extractor: number; org: number };
  warnings: string[];
  duration_ms: number;
}

export interface RefreshJobState {
  job_id: string;
  types: string[];
  startedAt: string;
  progress: string;
  done: boolean;
  result?: RefreshSummary;
  error?: string;
}

interface RefreshJob extends RefreshJobState {
  promise: Promise<RefreshSummary>;
  finishedAt?: number;
}

/** Finished-but-never-collected jobs are swept after this long. */
const STALE_JOB_MS = 30 * 60_000;

/** Matches the desktop app's snapshot lease TTL (its app_locks lease). */
const SNAPSHOT_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * S41 (§3.1): a refresh job's identity is its REQUESTED TYPE SET, never the
 * connection alone — so a caller can only ever collect the result of the
 * refresh it asked for, and two sessions' refreshes cannot cross-deliver.
 */
function refreshJobId(normalizedTypes: string[]): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([...normalizedTypes].sort()))
    .digest('hex');
  return `refresh-${digest.slice(0, 12)}`;
}

/** Container types whose children are re-indexed alongside them. */
const CHILD_TYPES: Record<string, string[]> = {
  CustomObject: ['CustomField', 'ValidationRule', 'ListView', 'RecordType'],
  CustomLabels: ['CustomLabel'],
  // S30: Bot versions live inline in the Bot document (metadata format).
  Bot: ['BotVersion'],
};

/**
 * S29: content and folder types share a snapshot directory, so refreshing one
 * without the other would clear the other's files while leaving its index
 * rows — they always refresh (and staleness-check) together.
 */
const COUPLED_TYPES: Record<string, string> = {
  Report: 'ReportFolder',
  ReportFolder: 'Report',
  Dashboard: 'DashboardFolder',
  DashboardFolder: 'Dashboard',
};

function normalizeRefreshTypes(types: string[]): string[] {
  const all = new Set(types);
  for (const t of types) {
    const coupled = COUPLED_TYPES[t];
    if (coupled) all.add(coupled);
  }
  return [...all];
}

export class SnapshotEngine {
  /** Keyed `${conn.id}:${job_id}` — job identity is the requested input (S41 §3.1). */
  private readonly jobs = new Map<string, RefreshJob>();
  /**
   * Per-connection tail of the refresh EXECUTION chain. Results are keyed by
   * request, but runs stay serialised per connection: each refresh rewrites
   * snapshot dirs and index rows wholesale (writeCurrent/replaceArtifacts),
   * so two running at once would corrupt each other.
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lockHolder = `plugin:${process.pid}`;

  constructor(
    private readonly db: ContrailDb,
    private readonly store: SnapshotStore,
    private readonly tokenMgr: AccessTokenManager,
    private readonly config: ContrailConfig,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Start (or observe) a refresh. Returns within ~toolWaitMs either the
   * finished summary or an in-progress state the caller reports back.
   * Pass pollJobId (alone) to check on a job from an earlier call without
   * re-sending types; a result is only ever delivered to the input that
   * asked for it.
   */
  async refresh(
    conn: ConnectionRecord,
    types?: string[],
    pollJobId?: string,
  ): Promise<
    | { status: 'complete'; job_id: string; summary: RefreshSummary }
    | { status: 'failed'; job_id: string; error: string }
    | { status: 'in_progress'; job_id: string; state: RefreshJobState }
    | { status: 'unknown_job'; job_id: string }
  > {
    this.sweepStaleJobs();
    let jobId: string;
    let normalized: string[] | null = null;
    if (pollJobId !== undefined) {
      jobId = pollJobId;
      if (!this.jobs.has(`${conn.id}:${jobId}`)) return { status: 'unknown_job', job_id: jobId };
    } else {
      normalized = normalizeRefreshTypes(types ?? this.config.snapshot.types);
      jobId = refreshJobId(normalized);
    }
    const key = `${conn.id}:${jobId}`;
    let job = this.jobs.get(key);
    if (job?.done) {
      this.jobs.delete(key);
      // A finished job whose result was never collected is delivered now.
      // `!== undefined`, never truthiness: an empty error string must still
      // deliver as FAILED, not fall through and restart work under a poll.
      if (job.result !== undefined) {
        return { status: 'complete', job_id: jobId, summary: job.result };
      }
      if (job.error !== undefined) return { status: 'failed', job_id: jobId, error: job.error };
      job = undefined;
    }
    if (!job) {
      // Poll mode never starts work: the has() check above returned, and a
      // done job always carries result or error (set before done flips).
      job = this.startJob(conn, normalized!, jobId);
      this.jobs.set(key, job);
    }
    const winner = await Promise.race([
      job.promise.then(
        (summary) => ({ status: 'complete' as const, job_id: jobId, summary }),
        (err) => ({
          status: 'failed' as const,
          job_id: jobId,
          error: String(err instanceof Error ? err.message : err),
        }),
      ),
      delay(this.config.snapshot.toolWaitMs).then(() => null),
    ]);
    if (winner) {
      this.jobs.delete(key);
      return winner;
    }
    return { status: 'in_progress', job_id: jobId, state: publicState(job) };
  }

  private sweepStaleJobs(): void {
    const cutoff = Date.now() - STALE_JOB_MS;
    for (const [key, job] of this.jobs) {
      if (job.done && job.finishedAt !== undefined && job.finishedAt < cutoff) {
        this.jobs.delete(key);
      }
    }
  }

  private startJob(conn: ConnectionRecord, types: string[], jobId: string): RefreshJob {
    const job: RefreshJob = {
      job_id: jobId,
      types,
      startedAt: new Date().toISOString(),
      progress: 'starting',
      done: false,
      promise: undefined as unknown as Promise<RefreshSummary>,
    };
    // Serialise RUNS per connection: a second refresh queues behind the
    // running one and starts only after it settles (success or failure).
    // Across PROCESSES the desktop app's snapshot lease applies too — the
    // plugin participates opportunistically (see db.tryAcquireAppLock): on a
    // machine where the desktop app shares ~/.contrail, a refresh held by
    // the other process fails honestly instead of interleaving wholesale
    // snapshot-dir rewrites with it.
    const prev = this.chains.get(conn.id);
    if (prev) job.progress = 'queued behind an earlier refresh on this connection';
    const lockName = `snapshot:${conn.id}`;
    const run = (prev ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.db.tryAcquireAppLock(lockName, this.lockHolder, SNAPSHOT_LOCK_TTL_MS)) {
          throw new ContrailError(
            'another Contrail process (the desktop app) is refreshing this connection — ' +
              'try again once its sync finishes',
            'snapshot_locked',
          );
        }
        try {
          return await this.runRefresh(conn, types, job);
        } finally {
          this.db.releaseAppLock(lockName, this.lockHolder);
        }
      });
    const tail = run.catch(() => {});
    this.chains.set(conn.id, tail);
    void tail.then(() => {
      if (this.chains.get(conn.id) === tail) this.chains.delete(conn.id);
    });
    job.promise = run
      .then((summary) => {
        job.done = true;
        job.finishedAt = Date.now();
        job.result = summary;
        return summary;
      })
      .catch((err) => {
        job.done = true;
        job.finishedAt = Date.now();
        job.error = String(err instanceof Error ? err.message : err);
        this.audit.record('snapshot.refresh_failed', {
          connectionId: conn.id,
          tool: 'refresh_snapshot',
          outcome: 'error',
          detail: { error: job.error },
        });
        throw err;
      });
    // Prevent unhandled rejection when nobody is awaiting after soft-return.
    job.promise.catch(() => {});
    return job;
  }

  private async runRefresh(
    conn: ConnectionRecord,
    types: string[],
    job: RefreshJob,
  ): Promise<RefreshSummary> {
    const started = Date.now();
    const warnings: string[] = [];
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const rest = new RestClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);

    job.progress = 'listing metadata';
    let listedProps: FileProperties[] = [];
    let unsupportedTypes: string[] = [];
    try {
      const detailed = await soap.listMetadataDetailed(types);
      listedProps = detailed.props;
      unsupportedTypes = detailed.unsupportedTypes;
    } catch (err) {
      warnings.push(`listMetadata failed (${String(err instanceof Error ? err.message : err)}); staleness data will be limited`);
    }
    // S30: a type this org/API version does not know (older version, or an
    // unlicensed feature like the Agentforce types) drops out per-type with
    // an honest warning — it never sinks the healthy types' refresh.
    let retrieveTypes = types;
    if (unsupportedTypes.length > 0) {
      const unsupported = new Set(unsupportedTypes);
      retrieveTypes = types.filter((t) => !unsupported.has(t));
      warnings.push(
        `${unsupportedTypes.join(', ')} not supported by this org/API version — skipped ` +
          `(feature not licensed, or salesforce.apiVersion too old).`,
      );
    }

    job.progress = 'starting retrieve';
    const retrieveMembers = buildRetrieveMembers(retrieveTypes, listedProps, warnings);
    if (Object.keys(retrieveMembers).length === 0) {
      // Loud, never a silent dir wipe: foldered types with no listable
      // inventory leave nothing to retrieve.
      throw new ContrailError(
        `nothing retrievable for the requested types (${types.join(', ')}): ${warnings.join(' ')}`,
        'retrieve_failed',
      );
    }
    const retrieveId = await soap.retrieve(retrieveMembers);

    const deadline = Date.now() + this.config.snapshot.retrieveTimeoutMs;
    let status = await soap.checkRetrieveStatus(retrieveId, true);
    let poll = 0;
    while (!status.done) {
      if (Date.now() > deadline) {
        throw new ContrailError(
          `retrieve did not complete within ${Math.round(
            this.config.snapshot.retrieveTimeoutMs / 60000,
          )} minutes (status: ${status.status})`,
          'retrieve_timeout',
        );
      }
      poll += 1;
      job.progress = `retrieving (poll ${poll}, status ${status.status})`;
      await delay(this.config.snapshot.pollIntervalMs);
      status = await soap.checkRetrieveStatus(retrieveId, true);
    }
    if (!status.success || !status.zipFile) {
      throw new ContrailError(
        `retrieve failed: ${status.errorMessage ?? status.status}`,
        'retrieve_failed',
      );
    }

    job.progress = 'extracting snapshot';
    const retrievedAt = new Date().toISOString();
    this.store.saveZip(conn.id, status.zipFile, retrievedAt);
    const extracted = this.store.extractRetrieveZip(status.zipFile);
    // Downstream authority is scoped to what was actually RETRIEVED — an
    // unsupported type that was skipped must keep its snapshot/index state.
    const affectedTypes = withChildTypes(retrieveTypes);
    const affectedSet = new Set(affectedTypes);
    const fullManifest = this.config.snapshot.types.every((t) => retrieveTypes.includes(t));

    // A refresh is authoritative ONLY for the types it asked for. On a
    // partial refresh, both the files written and the artifacts indexed are
    // filtered to the requested types' directories, and only those
    // directories are cleared — whatever else the zip carries cannot clobber
    // other types' snapshot or index state.
    let files = extracted;
    let clearDirs: string[] | undefined;
    if (!fullManifest) {
      const ownedDirs = ownedDirsForTypes(retrieveTypes);
      if (ownedDirs) {
        files = new Map(
          [...extracted].filter(([rel]) => {
            const top = rel.split('/')[0] ?? '';
            return rel.includes('/') ? ownedDirs.has(top) : rel === 'package.xml';
          }),
        );
        clearDirs = [...ownedDirs];
      } else {
        clearDirs = dirsForTypes(retrieveTypes, extracted);
      }
    }
    this.store.writeCurrent(conn.id, files, clearDirs ? { clearDirs } : undefined);

    job.progress = 'indexing artifacts';
    const fileProps = mergeProps(status.fileProperties, listedProps);
    const artifacts = indexSnapshotFiles(files, fileProps, retrievedAt).filter(
      (a) => fullManifest || affectedSet.has(a.type),
    );
    this.db.replaceArtifactsForTypes(
      conn.id,
      affectedTypes,
      artifacts.map((a) => ({ ...a, connectionId: conn.id })),
    );

    job.progress = 'extracting references';
    // Known-artifact maps span the whole index (post-replace) so a partial
    // refresh still resolves cross-type references from untouched types.
    const known = buildKnownArtifacts(this.db.listArtifacts(conn.id));
    const extractorEdges = extractAllEdges(conn.id, artifacts, known);
    this.db.replaceEdges(conn.id, 'extractor', affectedTypes, extractorEdges);

    job.progress = 'querying org dependency data';
    const orgDeps = await fetchOrgDependencyEdges(rest, conn.id, retrieveTypes);
    warnings.push(...orgDeps.warnings);
    this.db.replaceEdges(conn.id, 'org', retrieveTypes, orgDeps.edges);

    const summary: RefreshSummary = {
      connection: conn.alias,
      types,
      artifact_counts: countByType(artifacts),
      edge_counts: { extractor: extractorEdges.length, org: orgDeps.edges.length },
      warnings,
      duration_ms: Date.now() - started,
    };
    this.audit.record('snapshot.refreshed', {
      connectionId: conn.id,
      tool: 'refresh_snapshot',
      outcome: 'success',
      detail: {
        types,
        artifacts: artifacts.length,
        edges: extractorEdges.length + orgDeps.edges.length,
        duration_ms: summary.duration_ms,
      },
    });
    log('info', 'snapshot refreshed', { connection: conn.alias, artifacts: artifacts.length });
    return summary;
  }

  /** Compare org-side lastModifiedDate against the index (on-demand staleness check, spec §4). */
  async checkStaleness(
    conn: ConnectionRecord,
    types?: string[],
  ): Promise<{
    checked_types: string[];
    stale: Array<{ type: string; api_name: string; org_modified: string; index_modified: string | null }>;
    missing_from_index: number;
    note: string;
  }> {
    const checkTypes = normalizeRefreshTypes(types ?? this.config.snapshot.types);
    const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
    const { props, unsupportedTypes } = await soap.listMetadataDetailed(checkTypes);
    const stale: Array<{
      type: string;
      api_name: string;
      org_modified: string;
      index_modified: string | null;
    }> = [];
    let missing = 0;
    for (const p of props) {
      // Package-owned components are excluded from wildcard retrieves by
      // the platform; counting them as "missing" would be permanent noise.
      if (isPackageOwned(p)) continue;
      const artifact = this.db.getArtifact(conn.id, p.type, p.fullName);
      if (!artifact) {
        missing += 1;
        continue;
      }
      if (
        p.lastModifiedDate &&
        (!artifact.lastModifiedDate ||
          new Date(p.lastModifiedDate).getTime() >
            new Date(artifact.lastModifiedDate).getTime())
      ) {
        stale.push({
          type: p.type,
          api_name: p.fullName,
          org_modified: p.lastModifiedDate,
          index_modified: artifact.lastModifiedDate,
        });
      }
    }
    const unsupportedNote =
      unsupportedTypes.length > 0
        ? ` ${unsupportedTypes.join(', ')} not supported by this org/API version — not checked.`
        : '';
    return {
      checked_types: checkTypes,
      stale: stale.slice(0, 100),
      missing_from_index: missing,
      note:
        (stale.length || missing
          ? 'Run refresh_snapshot to bring the local snapshot up to date.'
          : 'Snapshot is current for the checked types.') + unsupportedNote,
    };
  }
}

/**
 * Build the retrieve package members. The package.xml wildcard only matches
 * CUSTOM objects — standard objects (which carry most real-world custom
 * fields) must be named explicitly, so CustomObject members are expanded
 * from the listMetadata inventory when available.
 */
function buildRetrieveMembers(
  types: string[],
  listedProps: FileProperties[],
  warnings: string[],
): Record<string, string[]> {
  const members: Record<string, string[]> = {};
  for (const t of types) {
    // Folder types fold into their content type's members below — package.xml
    // addresses folders as members of the CONTENT type.
    if (Object.hasOwn(FOLDER_TYPES, t)) continue;
    members[t] = ['*'];
  }
  if ('CustomObject' in members) {
    const objectNames = listedProps
      .filter((p) => p.type === 'CustomObject' && !isManaged(p))
      .map((p) => p.fullName);
    if (objectNames.length > 0) {
      members.CustomObject = objectNames;
      if (objectNames.length > 1000) {
        warnings.push(
          `CustomObject inventory is large (${objectNames.length}); the retrieve may be slow or hit platform size limits.`,
        );
      }
    } else {
      warnings.push(
        'listMetadata returned no CustomObject inventory; falling back to the * wildcard, which misses standard objects.',
      );
    }
  }
  // S41: Aura wildcard retrieves exclude namespace-free installedEditable
  // bundles (live-confirmed 2026-11-04: a wildcard returned 3 of an org's 6
  // namespace-free bundles, dropping the installedEditable trio) — expand to
  // NAMED members from the inventory, keeping the namespace-keyed isManaged
  // test so those bundles stay retrievable (by-name retrieves DO return
  // namespace-free installed components; the S36 LWC note below).
  if ('AuraDefinitionBundle' in members) {
    const bundleNames = listedProps
      .filter((p) => p.type === 'AuraDefinitionBundle' && !isManaged(p))
      .map((p) => p.fullName);
    if (bundleNames.length > 0) {
      members.AuraDefinitionBundle = bundleNames;
      if (bundleNames.length > 2000) {
        warnings.push(
          `AuraDefinitionBundle inventory is large (${bundleNames.length}); the retrieve may be slow or hit platform size limits.`,
        );
      }
    } else {
      warnings.push(
        'listMetadata returned no AuraDefinitionBundle inventory; falling back to the * wildcard, which misses installed-package bundles.',
      );
    }
  }
  // S29: foldered types NEVER use the wildcard (unsupported for folder-based
  // types) — members are the folder names (their -meta.xml definitions) plus
  // every folder-qualified content path from the per-folder listing.
  for (const [content, cfg] of Object.entries(FOLDERED_TYPES)) {
    if (!(content in members)) continue;
    const named = (type: string) =>
      listedProps.filter((p) => p.type === type && !isManaged(p)).map((p) => p.fullName);
    const folders = named(cfg.folderType);
    const items = named(content);
    if (folders.length + items.length > 0) {
      members[content] = [...folders, ...items];
      if (items.length > 2000) {
        warnings.push(
          `${content} inventory is large (${items.length}); the retrieve may be slow or hit platform size limits.`,
        );
      }
    } else {
      delete members[content];
      warnings.push(
        `listMetadata returned no ${content} inventory; ${content} skipped in this retrieve ` +
          `(wildcard retrieval is unsupported for folder-based types).`,
      );
    }
  }
  return members;
}

/**
 * S36: two predicates, deliberately split. Wildcard retrieves exclude
 * package-owned components whether or not they carry a namespace — UNLOCKED
 * packages install namespace-free with manageableState 'installed'
 * (live-confirmed: an org's installed LWC library listed 50 bundles and a
 * wildcard retrieved zero) — so STALENESS missing-counting keys on state
 * alone (isPackageOwned; get_org_changes skips the same states). NAMED-member
 * expansion keeps the namespace-keyed test (isManaged):
 * the platform DOES return namespace-free installed components to a
 * by-name retrieve, and dropping them there would silently shrink
 * long-standing CustomObject/Report snapshots.
 */
function isPackageOwned(p: FileProperties): boolean {
  // 'installedEditable' included (live-confirmed): an unmanaged-package
  // install carries it, and the platform still excludes those components
  // from wildcard retrieves (an org's 44 installedEditable LWC bundles
  // listed but zero retrieved).
  return (
    p.manageableState === 'installed' ||
    p.manageableState === 'installedEditable' ||
    p.manageableState === 'released'
  );
}

function isManaged(p: FileProperties): boolean {
  return isPackageOwned(p) ? p.namespacePrefix !== undefined && p.namespacePrefix !== '' : false;
}

function withChildTypes(types: string[]): string[] {
  const all = new Set(types);
  for (const t of types) for (const child of CHILD_TYPES[t] ?? []) all.add(child);
  return [...all];
}

/** Top-level snapshot directories owned by each retrievable type. */
const TYPE_DIRS: Record<string, string> = {
  ApexClass: 'classes',
  ApexTrigger: 'triggers',
  Flow: 'flows',
  CustomObject: 'objects',
  CustomLabels: 'labels',
  PermissionSet: 'permissionsets',
  CustomTab: 'tabs',
  FlexiPage: 'flexipages',
  CustomApplication: 'applications',
  ReportType: 'reportTypes',
  ApexPage: 'pages',
  GlobalValueSet: 'globalValueSets',
  ConnectedApp: 'connectedApps',
  NamedCredential: 'namedCredentials',
  ExternalCredential: 'externalCredentials',
  AuthProvider: 'authproviders',
  PlatformEventChannel: 'platformEventChannels',
  PlatformEventChannelMember: 'platformEventChannelMembers',
  ManagedEventSubscription: 'managedEventSubscriptions',
  Layout: 'layouts',
  CustomMetadata: 'customMetadata',
  // S31: the lead-conversion singleton (capitalized dir is the platform's).
  LeadConvertSettings: 'LeadConvertSettings',
  // S29: the first shared-dir case — content and folder types own ONE
  // directory. Sound only because normalizeRefreshTypes couples them into
  // every refresh/staleness check (a lone 'Report' request would otherwise
  // clear the folder files while leaving ReportFolder index rows behind).
  Report: 'reports',
  ReportFolder: 'reports',
  Dashboard: 'dashboards',
  DashboardFolder: 'dashboards',
  // S30: Agentforce types (v66+; explicit-refresh-only, like the analytics
  // and integration families).
  Bot: 'bots',
  GenAiPlugin: 'genAiPlugins',
  GenAiFunction: 'genAiFunctions',
  GenAiPlannerBundle: 'genAiPlannerBundles',
  AiAuthoringBundle: 'aiAuthoringBundles',
  GenAiPromptTemplate: 'genAiPromptTemplates',
  GenAiPromptTemplateActv: 'genAiPromptTemplateActivations',
  AiEvaluationDefinition: 'aiEvaluationDefinitions',
  BotTemplate: 'botTemplates',
  BotBlock: 'botBlocks',
  // S36: permissions & UI-action types (default-manifest members).
  CustomPermission: 'customPermissions',
  PermissionSetGroup: 'permissionsetgroups',
  MutingPermissionSet: 'mutingpermissionsets',
  QuickAction: 'quickActions',
  LightningComponentBundle: 'lwc',
  // S41: Aura component bundles.
  AuraDefinitionBundle: 'aura',
};

/** The refreshed types' own directories — null if any requested type has no known mapping. */
function ownedDirsForTypes(types: string[]): Set<string> | null {
  const dirs = new Set<string>();
  for (const t of types) {
    const dir = Object.hasOwn(TYPE_DIRS, t) ? TYPE_DIRS[t] : undefined;
    if (!dir) return null;
    dirs.add(dir);
  }
  return dirs;
}

/** Fallback for unmapped types: the refreshed types' known dirs plus whatever the zip contains. */
function dirsForTypes(types: string[], files: Map<string, Uint8Array>): string[] {
  const dirs = new Set<string>();
  for (const t of types) {
    const dir = Object.hasOwn(TYPE_DIRS, t) ? TYPE_DIRS[t] : undefined;
    if (dir) dirs.add(dir);
  }
  for (const rel of files.keys()) {
    const top = rel.split('/')[0];
    if (top && rel.includes('/')) dirs.add(top);
  }
  return [...dirs];
}

function mergeProps(primary: FileProperties[], secondary: FileProperties[]): FileProperties[] {
  const seen = new Set(primary.map((p) => `${p.type}:${p.fullName.toLowerCase()}`));
  return [
    ...primary,
    ...secondary.filter((p) => !seen.has(`${p.type}:${p.fullName.toLowerCase()}`)),
  ];
}

function countByType(artifacts: Array<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of artifacts) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return counts;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function publicState(job: RefreshJob): RefreshJobState {
  return {
    job_id: job.job_id,
    types: job.types,
    startedAt: job.startedAt,
    progress: job.progress,
    done: job.done,
    result: job.result,
    error: job.error,
  };
}

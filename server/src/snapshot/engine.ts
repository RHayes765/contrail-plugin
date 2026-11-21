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
import {
  OMNISTUDIO_SETTING_TIMEOUT_MS,
  omniStudioRefreshText,
  readOmniStudioMetadataSetting,
} from '../salesforce/omnistudioSettings.js';
import { RestClient } from '../salesforce/rest.js';
import { SnapshotStore } from './store.js';
import { indexSnapshotFiles } from './indexer.js';
import crypto from 'node:crypto';
import { buildKnownArtifacts, extractAllEdges } from '../deps/extract.js';
import { fetchOrgDependencyEdges } from '../deps/orgdeps.js';
import {
  listDates,
  listedPropFor,
  retrieveNamedMembers,
  type PreImageListing,
} from '../deploy/preimage.js';
import {
  CONNECTION_REMOVED_TEXT,
  MEMBER_REFRESH_MAX,
  MEMBER_REFRESH_NOTES,
  MEMBER_RESULT_REUSE_MS,
  REBASELINE_QUEUE_WAIT_MS,
  absenceVerdict,
  applyMemberUnits,
  isPackageOwnedState,
  memberJobId,
  memberKey,
  memberOutcomes,
  memberRetrieveManifest,
  noMetadataReadText,
  noSnapshotText,
  partialWriteText,
  planMemberUnits,
  removableUnitKeys,
  unitTypeCoverage,
  type MemberApplyResult,
  type MemberOutcome,
  type MemberRefreshSummary,
  type MemberSkipReason,
  type RebaselineOutcome,
  type SnapshotMember,
} from './members.js';
import { ContrailError } from '../core/errors.js';
import { log } from '../core/log.js';

/**
 * The snapshot pipeline: listMetadata → retrieve → unzip → index → extract
 * references. Runs as a per-connection background job with a short inline
 * wait, mirroring the connect_org pattern, so MCP client timeouts never bite
 * on large orgs.
 *
 * S46 Part C adds member-scoped runs (refreshMembers, and rebaselineMembers
 * after a deploy): only the named components' units are re-read, into an
 * existing snapshot, on the same per-connection chain and the same lease.
 * The planning, coverage, absence, whole-document and filesystem rules and
 * every text live in the byte-identical snapshot/members.ts; this file keeps
 * the org calls, the commit point and every SQLite write. Hand-mirror to the
 * desktop snapshot/engine.ts.
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
  /** The requested type set; [] for a member job. */
  types: string[];
  /** S46: the requested members of a member job. */
  members?: SnapshotMember[];
  startedAt: string;
  progress: string;
  done: boolean;
  result?: RefreshSummary | MemberRefreshSummary;
  error?: string;
}

interface RefreshJob extends RefreshJobState {
  kind: 'types' | 'members';
  promise: Promise<RefreshSummary | MemberRefreshSummary>;
  finishedAt?: number;
}

/**
 * S46: what a refresh call hands back. `complete` is discriminated by `kind`
 * — whichever entry delivered it, a job_id poll included — and a consumer
 * branches on `kind`, never on the summary's shape.
 */
export type RefreshComplete =
  | { status: 'complete'; kind: 'types'; job_id: string; summary: RefreshSummary }
  | { status: 'complete'; kind: 'members'; job_id: string; summary: MemberRefreshSummary };

type JobOutcome =
  | RefreshComplete
  | { status: 'failed'; job_id: string; error: string }
  | { status: 'in_progress'; job_id: string; state: RefreshJobState };

export type MemberRefreshOutcome =
  | { status: 'complete'; kind: 'members'; job_id: string; summary: MemberRefreshSummary }
  | { status: 'failed'; job_id: string; error: string }
  | { status: 'in_progress'; job_id: string; state: RefreshJobState };

/**
 * S46: what a refresh called WITHOUT a job_id returns. Its job id is always
 * `refresh-…` (the type set), so only a type job can answer it; a job_id
 * poll may deliver either kind.
 */
export type TypeRefreshOutcome =
  | { status: 'complete'; kind: 'types'; job_id: string; summary: RefreshSummary }
  | { status: 'failed'; job_id: string; error: string }
  | { status: 'in_progress'; job_id: string; state: RefreshJobState };

/** How a member run was started, and what it reports to. */
interface MemberRunContext {
  origin: 'refresh_snapshot' | 'execute_deploy';
  /** The deploy request (execute path only). */
  requestId?: string;
  /** The deploy's destructive members (execute path; possibly empty). */
  deleted?: SnapshotMember[];
  signal?: AbortSignal;
  /** Epoch ms the re-read must finish by (execute path). */
  deadline?: number;
  /** Progress sink (tool path). */
  job?: RefreshJob;
  /** Called once, at the commit point. */
  onCommit?: () => void;
}

/** Finished-but-never-collected jobs are swept after this long. */
const STALE_JOB_MS = 30 * 60_000;

/** Matches the desktop app's snapshot lease TTL (its app_locks lease). */
const SNAPSHOT_LOCK_TTL_MS = 15 * 60 * 1000;

const QUEUED_PROGRESS = 'queued behind an earlier refresh on this connection';

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
  /** S46: told which members a member run wrote or removed (the plugin leaves it unset). */
  private membersObserver:
    | ((info: { connectionId: string; members: MemberOutcome[] }) => void)
    | null = null;

  constructor(
    private readonly db: ContrailDb,
    private readonly store: SnapshotStore,
    private readonly tokenMgr: AccessTokenManager,
    private readonly config: ContrailConfig,
    private readonly audit: AuditLog,
  ) {}

  setMembersObserver(
    obs: (info: { connectionId: string; members: MemberOutcome[] }) => void,
  ): void {
    this.membersObserver = obs;
  }

  /**
   * Start (or observe) a refresh. Returns within ~toolWaitMs either the
   * finished summary or an in-progress state the caller reports back.
   * Pass pollJobId (alone) to check on a job from an earlier call without
   * re-sending types; a result is only ever delivered to the input that
   * asked for it. A poll serves type jobs and member jobs alike.
   */
  refresh(conn: ConnectionRecord, types?: string[]): Promise<TypeRefreshOutcome>;
  refresh(
    conn: ConnectionRecord,
    types?: string[],
    pollJobId?: string,
  ): Promise<JobOutcome | { status: 'unknown_job'; job_id: string }>;
  async refresh(
    conn: ConnectionRecord,
    types?: string[],
    pollJobId?: string,
  ): Promise<JobOutcome | { status: 'unknown_job'; job_id: string }> {
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
      if (job.result !== undefined) return completeOutcome(job, job.result);
      if (job.error !== undefined) return { status: 'failed', job_id: jobId, error: job.error };
      job = undefined;
    }
    if (!job) {
      // Poll mode never starts work: the has() check above returned, and a
      // done job always carries result or error (set before done flips).
      job = this.startJob(conn, normalized!, jobId);
      this.jobs.set(key, job);
    }
    return this.awaitJob(key, job);
  }

  /**
   * S46: re-read ONLY the named components into an existing snapshot. Its
   * own job id (`members-…`, the sorted member set), the same job map, the
   * same per-connection chain and lease as a whole-type refresh. A re-send
   * of the same members (any order or case) attaches to a RUNNING job; a
   * finished one nobody collected is handed to a re-send only within
   * MEMBER_RESULT_REUSE_MS, so a re-send never returns an older re-read as
   * its own — a job_id poll still collects it until the 30-minute sweep.
   */
  async refreshMembers(
    conn: ConnectionRecord,
    members: SnapshotMember[],
  ): Promise<MemberRefreshOutcome> {
    this.sweepStaleJobs();
    const jobId = memberJobId(members);
    const distinct = new Set(members.map((m) => memberKey(m.type, m.api_name))).size;
    if (distinct > MEMBER_REFRESH_MAX) {
      return {
        status: 'failed',
        job_id: jobId,
        error:
          `a member-scoped refresh takes at most ${MEMBER_REFRESH_MAX} components ` +
          `(${distinct} were named)`,
      };
    }
    const key = `${conn.id}:${jobId}`;
    let job = this.jobs.get(key);
    if (job?.done) {
      this.jobs.delete(key);
      const fresh =
        job.finishedAt !== undefined && Date.now() - job.finishedAt <= MEMBER_RESULT_REUSE_MS;
      if (fresh && job.result !== undefined) {
        return completeOutcome(job, job.result) as MemberRefreshOutcome;
      }
      if (fresh && job.error !== undefined) {
        return { status: 'failed', job_id: jobId, error: job.error };
      }
      job = undefined;
    }
    if (!job) {
      job = this.startMemberJob(conn, members, jobId);
      this.jobs.set(key, job);
    }
    // A member job only ever completes with kind 'members'.
    return (await this.awaitJob(key, job)) as MemberRefreshOutcome;
  }

  /**
   * S46: the re-baseline after a successful deploy. Never throws and
   * registers no job (nothing polls it). Waits at most
   * min(timeoutMs, REBASELINE_QUEUE_WAIT_MS) for its turn on the connection
   * (else `refresh_running`) and at most timeoutMs in all (else `timeout`) —
   * unless the run has reached its commit point, which is always awaited. An
   * aborted run that later reaches the front of the chain returns before
   * taking the lease, and a run aborted before its commit point writes
   * nothing.
   */
  async rebaselineMembers(
    conn: ConnectionRecord,
    members: SnapshotMember[],
    opts: { timeoutMs: number; requestId: string; deleted: SnapshotMember[] },
  ): Promise<RebaselineOutcome> {
    try {
      const distinct = new Set(members.map((m) => memberKey(m.type, m.api_name))).size;
      if (distinct > MEMBER_REFRESH_MAX) {
        let types: string[];
        try {
          types = planMemberUnits(members).units.map((u) => u.type);
        } catch {
          types = members.map((m) => m.type);
        }
        return {
          status: 'unavailable',
          reason: 'too_many_members',
          detail: [...new Set(types)].sort().join(', '),
        };
      }
      const timeoutMs = Math.max(0, opts.timeoutMs);
      // The budget runs from this call, not from the run's turn on the
      // chain: the retrieve gets only what the queue left of it (§C1 step 5).
      const deadline = Date.now() + timeoutMs;
      const controller = new AbortController();
      let started = false;
      let committing = false;
      const run = this.chainRun(
        conn,
        () =>
          this.runMemberRefresh(conn, members, {
            origin: 'execute_deploy',
            requestId: opts.requestId,
            deleted: opts.deleted,
            signal: controller.signal,
            deadline,
            onCommit: () => {
              committing = true;
            },
          }),
        {
          signal: controller.signal,
          onStart: () => {
            started = true;
          },
        },
      );
      run.catch(() => {});
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const first = await new Promise<'settled' | 'queue' | 'timeout'>((resolve) => {
        run.then(
          () => resolve('settled'),
          () => resolve('settled'),
        );
        timers.push(
          setTimeout(() => {
            if (!started) resolve('queue');
          }, Math.min(timeoutMs, REBASELINE_QUEUE_WAIT_MS)),
        );
        timers.push(setTimeout(() => resolve('timeout'), timeoutMs));
      });
      for (const t of timers) clearTimeout(t);
      if (first === 'queue') {
        controller.abort();
        return { status: 'unavailable', reason: 'refresh_running' };
      }
      if (first === 'timeout' && !committing) {
        controller.abort();
        return { status: 'unavailable', reason: 'timeout' };
      }
      return { status: 'ran', summary: await run };
    } catch (err) {
      return rebaselineFailure(err);
    }
  }

  private sweepStaleJobs(): void {
    const cutoff = Date.now() - STALE_JOB_MS;
    for (const [key, job] of this.jobs) {
      if (job.done && job.finishedAt !== undefined && job.finishedAt < cutoff) {
        this.jobs.delete(key);
      }
    }
  }

  /** The soft wait both entries share: the result, or an in-progress state after toolWaitMs. */
  private async awaitJob(key: string, job: RefreshJob): Promise<JobOutcome> {
    const jobId = job.job_id;
    const winner = await Promise.race([
      job.promise.then(
        (summary): JobOutcome => completeOutcome(job, summary),
        (err): JobOutcome => ({
          status: 'failed',
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

  /**
   * Serialise RUNS per connection: a run queues behind the one before it and
   * starts only after it settles (success or failure). Across PROCESSES the
   * desktop app's snapshot lease applies too — the plugin participates
   * opportunistically (see db.tryAcquireAppLock): on a machine where the
   * desktop app shares ~/.contrail, a refresh held by the other process
   * fails honestly instead of interleaving snapshot rewrites with it. A run
   * whose signal was aborted while it queued returns before taking the
   * lease; `onStart` marks that its turn has come.
   */
  private chainRun<T>(
    conn: ConnectionRecord,
    work: () => Promise<T>,
    gate?: { signal?: AbortSignal; onStart?: () => void },
  ): Promise<T> {
    const prev = this.chains.get(conn.id);
    const lockName = `snapshot:${conn.id}`;
    const run = (prev ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (gate?.signal?.aborted) throw cancelledError();
        gate?.onStart?.();
        if (!this.db.tryAcquireAppLock(lockName, this.lockHolder, SNAPSHOT_LOCK_TTL_MS)) {
          throw new ContrailError(
            'another Contrail process (the desktop app) is refreshing this connection — ' +
              'try again once its sync finishes',
            'snapshot_locked',
          );
        }
        try {
          return await work();
        } finally {
          this.db.releaseAppLock(lockName, this.lockHolder);
        }
      });
    const tail = run.catch(() => {});
    this.chains.set(conn.id, tail);
    void tail.then(() => {
      if (this.chains.get(conn.id) === tail) this.chains.delete(conn.id);
    });
    return run;
  }

  /** Record a job's settlement (and audit its failure) on the job itself. */
  private settleJob(
    conn: ConnectionRecord,
    job: RefreshJob,
    run: Promise<RefreshSummary | MemberRefreshSummary>,
    failedEvent: 'snapshot.refresh_failed' | 'snapshot.members_refresh_failed',
  ): void {
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
        this.audit.record(failedEvent, {
          connectionId: conn.id,
          tool: 'refresh_snapshot',
          outcome: 'error',
          detail: { error: job.error },
        });
        throw err;
      });
    // Prevent unhandled rejection when nobody is awaiting after soft-return.
    job.promise.catch(() => {});
  }

  private startJob(conn: ConnectionRecord, types: string[], jobId: string): RefreshJob {
    const job: RefreshJob = {
      kind: 'types',
      job_id: jobId,
      types,
      startedAt: new Date().toISOString(),
      progress: 'starting',
      done: false,
      promise: undefined as unknown as Promise<RefreshSummary>,
    };
    if (this.chains.has(conn.id)) job.progress = QUEUED_PROGRESS;
    const run = this.chainRun(conn, () => this.runRefresh(conn, types, job));
    this.settleJob(conn, job, run, 'snapshot.refresh_failed');
    return job;
  }

  private startMemberJob(
    conn: ConnectionRecord,
    members: SnapshotMember[],
    jobId: string,
  ): RefreshJob {
    const job: RefreshJob = {
      kind: 'members',
      job_id: jobId,
      types: [],
      members: members.map((m) => ({ type: m.type, api_name: m.api_name })),
      startedAt: new Date().toISOString(),
      progress: 'starting',
      done: false,
      promise: undefined as unknown as Promise<MemberRefreshSummary>,
    };
    if (this.chains.has(conn.id)) job.progress = QUEUED_PROGRESS;
    const run = this.chainRun(conn, () =>
      this.runMemberRefresh(conn, members, { origin: 'refresh_snapshot', job }),
    );
    this.settleJob(conn, job, run, 'snapshot.members_refresh_failed');
    return job;
  }

  /**
   * One member run, in the order of design C §C1: snapshot check → plan →
   * unit-level listing (never a child type) → coverage, unsupported and
   * package-owned skips → ONE retrieve of whole documents → the commit
   * point (the connection and its metadata_read grant re-read; nothing has
   * been written before it, and everything after it runs to completion) →
   * files (staged, then swapped) → rows → extractor edges → outcomes →
   * audit. A failure after the commit point is `snapshot_partial_write`.
   */
  private async runMemberRefresh(
    conn: ConnectionRecord,
    members: SnapshotMember[],
    ctx: MemberRunContext,
  ): Promise<MemberRefreshSummary> {
    const started = Date.now();
    const progress = (p: string): void => {
      if (ctx.job) ctx.job.progress = p;
    };
    const checkAbort = (): void => {
      if (ctx.signal?.aborted) throw cancelledError();
    };
    const deleted = ctx.deleted ?? [];

    // 1. Only an existing snapshot is updated.
    const counts = this.db.countArtifactsByType(conn.id);
    if (Object.keys(counts).length === 0) {
      throw new ContrailError(noSnapshotText(conn.alias), 'no_snapshot');
    }
    // 2. Members → units; no unit means no org call.
    const plan = planMemberUnits(members);
    const preSkipped = new Map<string, MemberSkipReason>();
    let listing: PreImageListing = { props: [], unsupported: new Set() };
    let retrievedAt: string | null = null;
    let applied: MemberApplyResult | null = null;
    let retrievedProps: FileProperties[] = [];
    const oldRows: Array<{ type: string; apiName: string }> = [];
    const touched: string[] = [];
    let edgeCount = 0;

    if (plan.units.length > 0) {
      const soap = new MetadataSoapClient(this.tokenMgr, conn, this.config.salesforce.apiVersion);
      // 3. The unit-level listing: unit types only, never a child type.
      checkAbort();
      progress('listing members');
      listing = await listDates(
        soap,
        plan.units.map((u) => ({ type: u.type, api_name: u.name })),
      );
      checkAbort();

      // 4. Unsupported, uncovered and package-owned units are left out.
      const coverage = unitTypeCoverage({ counts, units: plan.units, listing });
      for (const u of plan.units) {
        if (listing.unsupported.has(u.type)) preSkipped.set(u.key, 'type_unsupported');
        else if (!coverage.get(u.type)) preSkipped.set(u.key, 'type_not_in_snapshot');
        else if (
          listing.props !== null &&
          this.db.getArtifact(conn.id, u.type, u.name) === null &&
          isPackageOwnedState(listedPropFor(listing.props, u.type, u.name))
        ) {
          preSkipped.set(u.key, 'package_owned');
        }
      }
      const units = plan.units.filter((u) => !preSkipped.has(u.key));
      // After a deploy only the deploy's own deletions may be removed. Planned
      // here, before the commit point, so a deleted member that cannot be
      // placed fails the run with nothing written.
      const removable = ctx.origin === 'execute_deploy' ? removableUnitKeys(deleted) : null;

      if (units.length > 0) {
        // 5. ONE retrieve of whole documents (the manifest refuses a child type).
        const manifest = memberRetrieveManifest(units);
        const timeoutMs =
          ctx.deadline !== undefined
            ? Math.max(0, ctx.deadline - Date.now())
            : this.config.snapshot.retrieveTimeoutMs;
        progress('retrieving members');
        const retrieved = await retrieveNamedMembers(soap, manifest, {
          timeoutMs,
          pollIntervalMs: this.config.snapshot.pollIntervalMs,
          signal: ctx.signal,
          label: 'retrieving members',
          onProgress: progress,
        });
        if (!retrieved.ok) {
          if (retrieved.reason === 'cancelled') throw cancelledError();
          if (retrieved.reason === 'timeout') {
            throw new ContrailError(
              `retrieve did not complete within ${Math.round(timeoutMs / 1000)} s`,
              'retrieve_timeout',
            );
          }
          throw new ContrailError(
            `retrieve failed: ${retrieved.reason.replace(/^retrieve_failed:/, '')}`,
            'retrieve_failed',
          );
        }
        // 6. After the retrieve, as a whole refresh stamps it. No saveZip.
        const at = new Date().toISOString();
        retrievedAt = at;
        retrievedProps = retrieved.fileProperties;

        // 7. Last abort checkpoint, then the commit point: the connection
        // and its grant are re-read once, synchronously. Nothing has been
        // written yet; from here the write runs to completion.
        checkAbort();
        const live = this.db.getConnection(conn.id);
        if (!live) throw new ContrailError(CONNECTION_REMOVED_TEXT, 'connection_removed');
        if (!live.grants.metadata_read) {
          throw new ContrailError(noMetadataReadText(conn.alias), 'no_metadata_read');
        }
        ctx.onCommit?.();
        progress('writing the snapshot');
        try {
          // 8. What the snapshot holds for each unit now.
          const before = new Map<string, Array<{ type: string; apiName: string }>>();
          const inputs = units.map((u) => {
            const oldRoot = this.db.getArtifact(conn.id, u.type, u.name);
            const rows = oldRoot?.filePath
              ? this.db.listArtifactsByFilePath(conn.id, oldRoot.filePath)
              : oldRoot
                ? [oldRoot]
                : [];
            before.set(
              u.key,
              rows.map((r) => ({ type: r.type, apiName: r.apiName })),
            );
            const verdict = absenceVerdict(u, listing);
            return {
              key: u.key,
              type: u.type,
              name: u.name,
              bundle: u.bundle,
              oldFilePath: oldRoot?.filePath ?? null,
              // After a deploy only the deploy's own deletions may be removed.
              ifAbsent:
                removable === null || (verdict === 'remove' && removable.has(u.key))
                  ? verdict
                  : ('keep' as const),
              skipIfPackageOwned: oldRoot === null,
            };
          });
          // 9. Files: staged, then swapped; only this run's own retrieve.
          const done = applyMemberUnits(this.store, {
            connectionId: conn.id,
            zip: retrieved.zip,
            manifest,
            units: inputs,
            fileProps: mergeProps(
              (listing.props ?? []).filter((p) => p.lastModifiedDate),
              retrieved.fileProperties,
            ),
            retrievedAt: at,
          });
          applied = done;
          // 10. Rows: the old rows of every written or removed unit go.
          const replaced = done.units.filter((u) => u.applied !== 'kept');
          for (const u of replaced) {
            oldRows.push(...(before.get(u.key) ?? []));
            const unit = units.find((x) => x.key === u.key);
            if (unit) touched.push(`${unit.type}:${unit.name}`);
          }
          this.db.replaceArtifactRows(
            conn.id,
            oldRows,
            done.artifacts.map((a) => ({ ...a, connectionId: conn.id })),
          );
          // 11. Extractor edges FROM the re-read components, against the
          // whole post-replace index; org edges are not re-queried.
          progress('extracting references');
          const known = buildKnownArtifacts(this.db.listArtifacts(conn.id));
          const edges = extractAllEdges(conn.id, done.artifacts, known);
          const fresh = new Set(done.artifacts.map((a) => memberKey(a.type, a.apiName)));
          this.db.replaceEdgesFromArtifacts(conn.id, {
            refreshed: done.artifacts.map((a) => ({ type: a.type, name: a.apiName })),
            removed: oldRows
              .filter((r) => !fresh.has(memberKey(r.type, r.apiName)))
              .map((r) => ({ type: r.type, name: r.apiName })),
            edges,
          });
          edgeCount = edges.length;
        } catch (err) {
          throw new ContrailError(
            partialWriteText(err instanceof Error ? err.message : String(err)),
            'snapshot_partial_write',
          );
        }
      }
    }

    // 12. One outcome per member.
    const outcomes = memberOutcomes({
      plan,
      origin: ctx.origin,
      deleted,
      preSkipped,
      applied,
      oldRows,
      listing,
      retrievedProps,
    });
    const tally = { refreshed: 0, removed: 0, skipped: 0 };
    for (const o of outcomes) tally[o.outcome] += 1;
    const summary: MemberRefreshSummary = {
      connection: conn.alias,
      members: outcomes,
      counts: tally,
      units: touched,
      artifact_counts: countByType(applied?.artifacts ?? []),
      edge_counts: { extractor: edgeCount },
      retrieved_at: retrievedAt,
      notes: touched.length > 0 ? [...MEMBER_REFRESH_NOTES] : [],
      duration_ms: Date.now() - started,
    };

    // 13. Audit (the six keys a dossier may show, plus requestId), then the observer.
    this.audit.record('snapshot.members_refreshed', {
      connectionId: conn.id,
      tool: ctx.origin,
      outcome: 'success',
      detail: {
        origin: ctx.origin,
        ...(ctx.origin === 'execute_deploy' && ctx.requestId !== undefined
          ? { requestId: ctx.requestId }
          : {}),
        refreshed: tally.refreshed,
        removed: tally.removed,
        skipped: tally.skipped,
        units: touched,
        duration_ms: summary.duration_ms,
      },
    });
    log('info', 'snapshot members refreshed', {
      connection: conn.alias,
      refreshed: tally.refreshed,
      removed: tally.removed,
      skipped: tally.skipped,
    });
    const changed = outcomes.filter((o) => o.outcome !== 'skipped');
    if (this.membersObserver && changed.length > 0) {
      try {
        this.membersObserver({ connectionId: conn.id, members: changed });
      } catch (err) {
        log('warn', 'members observer failed', { error: String(err) });
      }
    }
    return summary;
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
    let listed = false;
    try {
      const detailed = await soap.listMetadataDetailed(types);
      listedProps = detailed.props;
      unsupportedTypes = detailed.unsupportedTypes;
      listed = true;
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
    // S47: a Data Mapper listing that came back EMPTY may be the org's
    // Omnistudio Metadata setting, not an empty org — read the setting
    // alongside the retrieve (never rejects). A failed listing or a type the
    // org refused already carries its own warning.
    const omniP =
      listed &&
      types.includes('OmniDataTransform') &&
      !unsupportedTypes.includes('OmniDataTransform') &&
      !listedProps.some((p) => p.type === 'OmniDataTransform')
        ? readOmniStudioMetadataSetting(soap, {
            timeoutMs: OMNISTUDIO_SETTING_TIMEOUT_MS,
            pollIntervalMs: this.config.snapshot.pollIntervalMs,
          })
        : null;

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

    if (omniP) {
      job.progress = 'reading the Omnistudio Metadata setting';
      const omniWarning = omniStudioRefreshText(await omniP);
      if (omniWarning) warnings.push(omniWarning);
    }

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

function cancelledError(): ContrailError {
  return new ContrailError(
    'the member refresh was cancelled before it wrote anything',
    'cancelled',
  );
}

/** A finished job's `complete` outcome, discriminated by the job's kind. */
function completeOutcome(
  job: RefreshJob,
  summary: RefreshSummary | MemberRefreshSummary,
): RefreshComplete {
  return job.kind === 'members'
    ? {
        status: 'complete',
        kind: 'members',
        job_id: job.job_id,
        summary: summary as MemberRefreshSummary,
      }
    : { status: 'complete', kind: 'types', job_id: job.job_id, summary: summary as RefreshSummary };
}

/**
 * Map a member run's failure to the re-baseline outcome. `failed` is only
 * ever a failure BEFORE the commit point, where nothing was written; a
 * failure after it is `failed_after_write`.
 */
function rebaselineFailure(err: unknown): RebaselineOutcome {
  const code = err instanceof ContrailError ? err.code : '';
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  switch (code) {
    case 'snapshot_locked':
      return { status: 'unavailable', reason: 'locked' };
    case 'no_snapshot':
      return { status: 'unavailable', reason: 'no_snapshot' };
    case 'retrieve_timeout':
    case 'cancelled':
      return { status: 'unavailable', reason: 'timeout' };
    case 'no_metadata_read':
      return { status: 'unavailable', reason: 'no_metadata_read' };
    case 'connection_removed':
      return { status: 'unavailable', reason: 'connection_removed' };
    case 'snapshot_partial_write':
      return { status: 'unavailable', reason: 'failed_after_write', detail: message };
    default:
      return { status: 'unavailable', reason: 'failed', detail: message };
  }
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
  // S44: Studio test suites (Beta type) and custom scorers.
  AiTestingDefinition: 'aiTestingDefinitions',
  AiAgentScorerDefinition: 'aiAgentScorerDefinitions',
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
  // S47: Omnistudio Data Mappers (explicit-refresh-only).
  OmniDataTransform: 'omniDataTransforms',
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
    ...(job.members !== undefined ? { members: job.members } : {}),
    startedAt: job.startedAt,
    progress: job.progress,
    done: job.done,
    result: job.result,
    error: job.error,
  };
}

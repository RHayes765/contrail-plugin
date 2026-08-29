import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../core/log.js';
import { LspClient } from './lspClient.js';
import { startApexServer, checkApexOnce, DeadlineError } from './apex.js';
import { startSoqlServer, checkSoqlOnce } from './soql.js';
import type {
  ApexSourceKind,
  LocalDiagResult,
  LocalDiagRunner,
  SpawnLsp,
  UnavailableCode,
} from './types.js';

/**
 * Lifecycle owner for the vendored language servers.
 * MIRROR UNIT (desktop counterpart: packages/engine/src/localdiag/runner.ts).
 *
 * Two deliberately different lifecycles, both calibrated against the real
 * bundles:
 *   - APEX is ONE-SHOT: a fresh server per check, disposed with the answer.
 *     A long-lived apex-ls silently stops analyzing new documents, and a
 *     blind server's empty pull is indistinguishable from a clean result —
 *     the one failure mode this feature must never have. A fresh spawn costs
 *     ~3s and makes every answer trustworthy.
 *   - SOQL is KEEP-ALIVE with an idle reap: the server is tiny, proven
 *     stable across checks, and answers in milliseconds warm.
 *
 * Everything tolerates a host that exits without calling shutdown(): timers
 * are unref()'d and the servers die on stdin EOF with their parent (the
 * plugin has no shutdown hooks; the desktop app calls shutdown() on quit).
 *
 * Honesty contract: every failure path maps to a structured unavailable code.
 * A check that did not run NEVER reports clean.
 */

const SOQL_IDLE_REAP_MS = 10 * 60 * 1000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 1000;

/** The gate file that satisfies apex-ls's classes-dir workspace check at spawn. */
const SEED_NAME = 'ContrailSeed.cls';
const SEED_SOURCE = 'public class ContrailSeed {}\n';

export interface LocalDiagRunnerOptions {
  /** Root of the vendored bundles (…/vendor) — null means not installed. */
  vendorDir: string | null;
  enabled: boolean;
  /** Whole-check budget, cold spawn included. */
  timeoutMs: number;
  /** Scratch workspace root (created lazily; holds the seed + per-check files). */
  workspaceRoot: string;
  /** Host-specific node spawn; the default assumes process.execPath IS node. */
  spawnLsp?: SpawnLsp;
  idleReapMs?: number;
}

const defaultSpawnLsp: SpawnLsp = (scriptPath, args, cwd) =>
  spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

interface Lane {
  /** Keep-alive client (SOQL only — the apex lane never stores one). */
  client: LspClient | null;
  idleTimer: NodeJS.Timeout | null;
  failures: number;
  cooldownUntil: number;
  version: number;
  chain: Promise<unknown>;
}

function newLane(): Lane {
  return {
    client: null,
    idleTimer: null,
    failures: 0,
    cooldownUntil: 0,
    version: 0,
    chain: Promise.resolve(),
  };
}

function unavailable(code: UnavailableCode, detail: string): LocalDiagResult {
  return { checked: false, unavailable: code, detail };
}

/** Scratch filename must carry the DECLARED type name — a mismatch would itself diagnose. */
export function apexScratchName(source: string, kind: ApexSourceKind): string {
  if (kind === 'anonymous') return '__anon__.apex';
  if (kind === 'trigger') {
    const m = /\btrigger\s+([A-Za-z_]\w*)\s+on\b/.exec(source);
    return `${m?.[1] ?? 'ContrailCheck'}.trigger`;
  }
  const m = /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/.exec(source);
  return `${m?.[1] ?? 'ContrailCheck'}.cls`;
}

export function createLocalDiagRunner(opts: LocalDiagRunnerOptions): LocalDiagRunner {
  const spawnLsp = opts.spawnLsp ?? defaultSpawnLsp;
  const idleReapMs = opts.idleReapMs ?? SOQL_IDLE_REAP_MS;
  const lanes: Record<'apex' | 'soql', Lane> = { apex: newLane(), soql: newLane() };
  /** Live one-shot apex client (for shutdown() while a check is in flight). */
  let apexInFlight: LspClient | null = null;

  const classesDir = () =>
    path.join(opts.workspaceRoot, 'force-app', 'main', 'default', 'classes');

  /**
   * The workspace gate is evaluated at server SPAWN — the seed must exist
   * before it. Scratch files are wiped here, between one-shot servers, when
   * nothing is watching: apex-ls's file watcher fires a
   * workspace/diagnostic/refresh on file events, and the less churn a live
   * server sees, the better.
   */
  function ensureWorkspace(): void {
    const dir = classesDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (name === SEED_NAME) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* a locked stray is harmless — it is just a .cls file */
      }
    }
    fs.writeFileSync(path.join(dir, SEED_NAME), SEED_SOURCE, 'utf8');
  }

  function scriptFor(lane: 'apex' | 'soql'): string | null {
    if (!opts.vendorDir) return null;
    const script =
      lane === 'apex'
        ? path.join(opts.vendorDir, 'apex-ls', 'dist', 'server.node.js')
        : path.join(opts.vendorDir, 'bin', 'soql-lsp.bundled.js');
    return fs.existsSync(script) ? script : null;
  }

  /** Serialize checks per language: kills poll interleave and filename races. */
  function enqueue<T>(name: 'apex' | 'soql', work: () => Promise<T>): Promise<T> {
    const lane = lanes[name];
    const run = lane.chain.then(work, work);
    lane.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function gates(name: 'apex' | 'soql'): LocalDiagResult | { script: string } {
    if (!opts.enabled) {
      return unavailable('disabled', 'localDiagnostics.enabled is false in config.json.');
    }
    const script = scriptFor(name);
    if (!script) {
      return unavailable(
        'not_installed',
        'This install carries no vendored language servers (server/vendor is absent).',
      );
    }
    if (Date.now() < lanes[name].cooldownUntil) {
      return unavailable(
        'server_error',
        `The ${name} language server failed repeatedly — cooling down before another attempt.`,
      );
    }
    return { script };
  }

  function classify(name: 'apex' | 'soql', err: unknown): LocalDiagResult {
    registerFailure(name);
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof DeadlineError || detail.includes('timed out')) {
      return unavailable(
        detail.includes('initialize') ? 'spawn_timeout' : 'check_timeout',
        `The ${name} check did not finish in time: ${detail}`,
      );
    }
    return unavailable('server_error', `The ${name} language server misbehaved: ${detail}`);
  }

  function registerFailure(name: 'apex' | 'soql'): void {
    const lane = lanes[name];
    lane.failures += 1;
    if (lane.failures >= BREAKER_THRESHOLD) {
      lane.cooldownUntil = Date.now() + BREAKER_COOLDOWN_MS;
      lane.failures = 0;
      log('warn', `${name} language server breaker tripped — cooling down`, {
        cooldownMs: BREAKER_COOLDOWN_MS,
      });
    }
  }

  function killSoql(): void {
    const lane = lanes.soql;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    lane.client?.dispose();
    lane.client = null;
  }

  function scheduleSoqlReap(): void {
    const lane = lanes.soql;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      log('debug', 'reaping idle soql language server');
      killSoql();
    }, idleReapMs);
    lane.idleTimer.unref?.();
  }

  return {
    checkApex(source, kind) {
      return enqueue('apex', async () => {
        const gate = gates('apex');
        if ('checked' in gate) return gate;
        const lane = lanes.apex;
        const deadline = Date.now() + opts.timeoutMs;
        ensureWorkspace();
        const filename = apexScratchName(source, kind);
        const filePath = path.join(classesDir(), filename);
        fs.writeFileSync(filePath, source, 'utf8');
        let client: LspClient | null = null;
        try {
          client = await startApexServer(spawnLsp, gate.script, opts.workspaceRoot);
          apexInFlight = client;
          const diagnostics = await checkApexOnce(
            client,
            pathToFileURL(filePath).toString(),
            source,
            ++lane.version,
            deadline,
          );
          lane.failures = 0;
          return { checked: true, diagnostics } as LocalDiagResult;
        } catch (err) {
          return classify('apex', err);
        } finally {
          apexInFlight = null;
          client?.dispose();
        }
      });
    },

    checkSoql(query) {
      return enqueue('soql', async () => {
        const gate = gates('soql');
        if ('checked' in gate) return gate;
        const lane = lanes.soql;
        const deadline = Date.now() + opts.timeoutMs;
        try {
          if (!lane.client?.alive) {
            killSoql(); // clear a dead husk before respawning
            fs.mkdirSync(opts.workspaceRoot, { recursive: true });
            lane.client = await startSoqlServer(spawnLsp, gate.script, opts.workspaceRoot);
          }
          const diagnostics = await checkSoqlOnce(
            lane.client,
            opts.workspaceRoot,
            query,
            ++lane.version,
            deadline,
          );
          lane.failures = 0;
          scheduleSoqlReap();
          return { checked: true, diagnostics } as LocalDiagResult;
        } catch (err) {
          killSoql(); // discard a misbehaving server; next check respawns fresh
          return classify('soql', err);
        }
      });
    },

    async shutdown() {
      apexInFlight?.dispose();
      apexInFlight = null;
      killSoql();
    },
  };
}

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Per-user application data directory. Holds the SQLite database, config
 * file, and (from P0.2) snapshot zips. Tokens never live here — they go to
 * the OS keychain only.
 *
 * WINDOWS: `%USERPROFILE%\.contrail`, deliberately NOT under AppData. MSIX
 * package virtualization (Claude Desktop hosts the plugin in one) gives
 * containerized processes a copy-on-write overlay of AppData, so a path
 * there is TWO different files depending on who opens it — which forked the
 * shared database into divergent lineages and corrupted it (2026-08-26).
 * The profile root passes through the container untouched (verified
 * empirically), so every process converges on one physical file and normal
 * SQLite locking actually applies.
 *
 * Override with CONTRAIL_DATA_DIR (used by tests and portable setups).
 */
export function dataDir(): string {
  const override = process.env.CONTRAIL_DATA_DIR;
  if (override) return ensureDir(override);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const dir = path.join(home, '.contrail');
      migrateLegacyWindowsDataDir(
        dir,
        path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Contrail'),
      );
      return ensureDir(dir);
    }
    case 'darwin':
      return ensureDir(path.join(home, 'Library', 'Application Support', 'Contrail'));
    default:
      return ensureDir(
        path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'contrail'),
      );
  }
}

/**
 * One-time move of an existing install's data out of the virtualized zone.
 * Copies THIS PROCESS'S VIEW of the legacy directory — on a healthy machine
 * views agree and this is simply the data; on a machine with a forked overlay
 * each process would bring its own lineage, so first-to-migrate wins and the
 * lineage guard (db.ts) arbitrates any stragglers instead of letting them
 * silently merge.
 *
 * Exported for tests. Never deletes the legacy directory — it leaves a
 * breadcrumb and keeps the original as its own backup.
 */
export function migrateLegacyWindowsDataDir(newDir: string, legacyDir: string): void {
  try {
    if (path.resolve(newDir) === path.resolve(legacyDir)) return;
    const newDb = path.join(newDir, 'contrail.db');
    const legacyDb = path.join(legacyDir, 'contrail.db');
    // Already migrated (or a fresh machine): nothing to do.
    if (fs.existsSync(newDb) || !fs.existsSync(legacyDb)) return;

    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(legacyDir, newDir, { recursive: true, force: false, errorOnExist: false });

    // The copy is a different physical file: pre-authorize it with the
    // lineage guard so the engine's first open adopts instead of refusing.
    fs.writeFileSync(`${newDb}.adopt`, '', 'utf8');

    // Best-effort: absolute paths stored inside the database still point at
    // the legacy dir. Fix the two columns that carry them so transcripts
    // replay and pending deploy payloads resolve. Raw handle on purpose —
    // the engine's guard/migrations run later, on ITS open.
    // Path fixups only affect replay of OLD sessions/deploys — a failure on
    // any single statement (e.g. a table this schema version lacks) degrades
    // history, never the migration, and never leaks the handle.
    const raw = new Database(newDb);
    try {
      for (const [table, column] of [
        ['sessions', 'transcript_path'],
        ['deploy_requests', 'payload_path'],
      ] as const) {
        try {
          raw
            .prepare(
              `UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ? || '%'`,
            )
            .run(legacyDir, newDir, legacyDir);
        } catch {
          /* table/column absent at this schema version — skip */
        }
      }
    } finally {
      raw.close();
    }

    try {
      fs.writeFileSync(
        path.join(legacyDir, 'MIGRATED-TO.txt'),
        `This data moved to ${newDir} (out of the MSIX-virtualized zone). ` +
          `This directory is kept as a backup and is no longer used.\n`,
        'utf8',
      );
    } catch {
      /* breadcrumb is best-effort */
    }
  } catch (err) {
    // A half-migrated target must not masquerade as a fresh install: remove
    // the partial database so the next start retries, and fail LOUDLY.
    try {
      fs.rmSync(path.join(newDir, 'contrail.db'), { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(
      `Contrail could not move its data from ${legacyDir} to ${newDir}: ${String(err)}. ` +
        `Copy the directory manually (then create an empty contrail.db.adopt file next to ` +
        `the copied database) or set CONTRAIL_DATA_DIR.`,
    );
  }
}

export function dbPath(): string {
  return path.join(dataDir(), 'contrail.db');
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

/** Validated deploy zips awaiting (or past) execution. */
export function deploysDir(): string {
  return ensureDir(path.join(dataDir(), 'deploys'));
}

/** Extracted org snapshots. Also a read-only source root for deploys. */
export function snapshotsDir(): string {
  return ensureDir(path.join(dataDir(), 'snapshots'));
}

/**
 * Scratch space an agent can write edited metadata into and then name in
 * validate_deploy's content_file. Contrail owns the directory, so it is an
 * allowed deploy source with no configuration at all — which is what makes
 * "edit a 133 KB flow and deploy it" work without the XML ever passing
 * through a model's output.
 */
export function stagingDir(): string {
  return ensureDir(path.join(dataDir(), 'staging'));
}

/**
 * The vendored language-server bundles (server/vendor/ — see its
 * PROVENANCE.md), resolved relative to the RUNNING CODE, not the data dir:
 * they ship with the install, in every channel. The candidate walk covers
 * every layout this code runs from — the committed dist-plugin bundle and
 * the mcpb staging entry sit one level under the root that carries vendor/
 * (`../vendor`), the tsc dist/ tree and vitest's src/ imports sit two levels
 * under it (`../../vendor`). Returns null when no candidate holds the apex-ls
 * server — callers report "not installed" honestly rather than guessing.
 *
 * Override with CONTRAIL_VENDOR_DIR (tests and portable setups), mirroring
 * CONTRAIL_DATA_DIR.
 */
export function vendorDir(): string | null {
  const override = process.env.CONTRAIL_VENDOR_DIR;
  if (override) return override;
  // fileURLToPath, not URL.pathname: this repo's own path has spaces, which
  // pathname would leave percent-encoded.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', 'vendor'), path.join(here, '..', '..', 'vendor')]) {
    if (fs.existsSync(path.join(candidate, 'apex-ls', 'dist', 'server.node.js'))) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

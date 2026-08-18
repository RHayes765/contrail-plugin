import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Per-user application data directory. Holds the SQLite database, config
 * file, and (from P0.2) snapshot zips. Tokens never live here — they go to
 * the OS keychain only.
 *
 * Override with CONTRAIL_DATA_DIR (used by tests and portable setups).
 */
export function dataDir(): string {
  const override = process.env.CONTRAIL_DATA_DIR;
  if (override) return ensureDir(override);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return ensureDir(
        path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Contrail'),
      );
    case 'darwin':
      return ensureDir(path.join(home, 'Library', 'Application Support', 'Contrail'));
    default:
      return ensureDir(
        path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'contrail'),
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

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

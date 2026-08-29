import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';
import { log } from './log.js';

/**
 * In-band update notification — the only update channel a hand-installed
 * .mcpb extension can have. One anonymous GET to the GitHub Releases API per
 * 24h (the product's sole phone-home, killable via config updates.checkEnabled),
 * cached in the data dir. NOTHING here may ever block or fail a tool call:
 * reads are synchronous against the cache; refreshes are fire-and-forget with
 * a short timeout; every failure path is silent and still stamps the cache so
 * a broken network is probed once a day, not once a call.
 */

const CACHE_FILE = 'update-check.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

interface RepoCache {
  checkedAt: string;
  latestVersion: string | null;
}

export interface UpdateNotice {
  installed: string;
  latest: string;
  download_url: string;
}

function cachePath(): string {
  return path.join(dataDir(), CACHE_FILE);
}

function readCache(repo: string): RepoCache | null {
  try {
    const all = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Record<string, RepoCache>;
    const entry = all[repo];
    return entry && typeof entry.checkedAt === 'string' ? entry : null;
  } catch {
    return null;
  }
}

function writeCache(repo: string, latestVersion: string | null): void {
  let all: Record<string, RepoCache> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      all = parsed as Record<string, RepoCache>;
    }
  } catch {
    /* fresh cache */
  }
  all[repo] = { checkedAt: new Date().toISOString(), latestVersion };
  fs.writeFileSync(cachePath(), JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/** a > b for x.y.z triplets; anything unparsable is never "newer". */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return false;
}

/**
 * Fetch the latest release tag for the repo and stamp the cache. Silent on
 * every failure; a miss (404, no releases, bad shape) still stamps so the TTL
 * holds. Exported for the startup fire-and-forget and for tests.
 */
export async function refreshUpdateCache(repo: string): Promise<void> {
  let latest: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown };
      const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
      if (/^\d+\.\d+\.\d+$/.test(tag)) latest = tag;
    }
  } catch {
    /* offline / timeout — stamp and move on */
  }
  try {
    writeCache(repo, latest);
  } catch (err) {
    log('debug', 'update-check cache write failed', { err: String(err) });
  }
}

/**
 * The cached answer, never the network: returns a notice when the cache holds
 * a newer version than the one running, and quietly kicks a background
 * refresh when the cache is stale. Disabled => null and NO network, ever.
 */
export function getUpdateNotice(
  installedVersion: string,
  repo: string,
  enabled: boolean,
): UpdateNotice | null {
  if (!enabled) return null;
  const cache = readCache(repo);
  const stale = !cache || Date.now() - Date.parse(cache.checkedAt) > TTL_MS;
  if (stale) {
    refreshUpdateCache(repo).catch(() => {});
  }
  if (!cache?.latestVersion) return null;
  if (!isNewerVersion(cache.latestVersion, installedVersion)) return null;
  return {
    installed: installedVersion,
    latest: cache.latestVersion,
    download_url: `https://github.com/${repo}/releases/latest`,
  };
}

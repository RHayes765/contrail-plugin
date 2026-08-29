import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUpdateNotice, isNewerVersion, refreshUpdateCache } from '../core/updateCheck.js';

/**
 * The in-band update check: cached-only reads, one background GET a day, and
 * a kill-switch that means ZERO network. Nothing here may ever block or fail
 * a tool call — the failure tests matter more than the happy path.
 */

const REPO = 'RHayes765/contrail-plugin';
let tmp: string;
let fetchCalls: number;

function stubRelease(tag: string | null, status = 200): void {
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    if (status !== 200) return new Response('nope', { status });
    return new Response(JSON.stringify(tag === null ? {} : { tag_name: tag }));
  });
}

function seedCache(latestVersion: string | null, ageMs = 0): void {
  fs.writeFileSync(
    path.join(tmp, 'update-check.json'),
    JSON.stringify({
      [REPO]: {
        checkedAt: new Date(Date.now() - ageMs).toISOString(),
        latestVersion,
      },
    }),
    'utf8',
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-upd-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  fetchCalls = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isNewerVersion', () => {
  it('compares triplets and refuses garbage', () => {
    expect(isNewerVersion('0.14.0', '0.13.0')).toBe(true);
    expect(isNewerVersion('0.13.1', '0.13.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.13.0', '0.13.0')).toBe(false);
    expect(isNewerVersion('0.12.9', '0.13.0')).toBe(false);
    expect(isNewerVersion('banana', '0.13.0')).toBe(false);
    expect(isNewerVersion('1.2', '0.13.0')).toBe(false);
  });
});

describe('refreshUpdateCache', () => {
  it('stamps the latest tag (v-prefix stripped)', async () => {
    stubRelease('v0.14.0');
    await refreshUpdateCache(REPO);
    const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'update-check.json'), 'utf8'));
    expect(cache[REPO].latestVersion).toBe('0.14.0');
  });

  it('stamps null (still honoring the TTL) on API errors, bad shapes, and network failure', async () => {
    stubRelease(null, 404);
    await refreshUpdateCache(REPO);
    let cache = JSON.parse(fs.readFileSync(path.join(tmp, 'update-check.json'), 'utf8'));
    expect(cache[REPO].latestVersion).toBeNull();

    stubRelease('not-a-version');
    await refreshUpdateCache(REPO);
    cache = JSON.parse(fs.readFileSync(path.join(tmp, 'update-check.json'), 'utf8'));
    expect(cache[REPO].latestVersion).toBeNull();

    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      throw new Error('offline');
    });
    await expect(refreshUpdateCache(REPO)).resolves.toBeUndefined(); // silent
  });
});

describe('getUpdateNotice', () => {
  it('disabled means null AND zero network, even with a stale cache', () => {
    stubRelease('v9.9.9');
    seedCache('9.9.9', 48 * 60 * 60 * 1000);
    expect(getUpdateNotice('0.13.0', REPO, false)).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it('a fresh cache answers without touching the network', () => {
    stubRelease('v9.9.9');
    seedCache('0.14.0');
    const notice = getUpdateNotice('0.13.0', REPO, true);
    expect(notice).toMatchObject({
      installed: '0.13.0',
      latest: '0.14.0',
      download_url: `https://github.com/${REPO}/releases/latest`,
    });
    expect(fetchCalls).toBe(0);
  });

  it('up to date (or unknown latest) means no notice', () => {
    seedCache('0.13.0');
    expect(getUpdateNotice('0.13.0', REPO, true)).toBeNull();
    seedCache(null);
    expect(getUpdateNotice('0.13.0', REPO, true)).toBeNull();
  });

  it('a stale cache kicks ONE background refresh but still answers from cache now', async () => {
    stubRelease('v0.15.0');
    seedCache('0.14.0', 25 * 60 * 60 * 1000);
    const notice = getUpdateNotice('0.13.0', REPO, true);
    expect(notice?.latest).toBe('0.14.0'); // the cached answer, not the network's
    await vi.waitFor(() => expect(fetchCalls).toBe(1));
  });

  it('no cache at all: null now, refresh fired for next time', async () => {
    stubRelease('v0.14.0');
    expect(getUpdateNotice('0.13.0', REPO, true)).toBeNull();
    // Wait for the WRITE, not just the fetch — the stamp lands after the response.
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(tmp, 'update-check.json'))).toBe(true),
    );
    expect(fetchCalls).toBe(1);
    expect(getUpdateNotice('0.13.0', REPO, true)?.latest).toBe('0.14.0');
  });
});

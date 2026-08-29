import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDiagRunner } from '../localdiag/runner.js';
import { vendorDir } from '../core/paths.js';
import type { LocalDiagRunner } from '../localdiag/types.js';

/**
 * REAL spawns of the vendored language servers — opt-in via
 * CONTRAIL_LOCALDIAG_IT=1 (each apex check cold-starts a ~9.6MB server; the
 * whole file runs ~60s). ONE file on purpose: vitest parallelizes files, and
 * these want the machine to themselves. This suite is the proof the
 * transcribed protocol still matches the vendored bytes — run it on every
 * vendor refresh (see server/vendor/PROVENANCE.md).
 */

const run = process.env.CONTRAIL_LOCALDIAG_IT === '1';

describe.skipIf(!run)('localdiag integration (real servers)', () => {
  let tmp: string;
  let runner: LocalDiagRunner;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-ldit-'));
    process.env.CONTRAIL_DATA_DIR = tmp;
    runner = createLocalDiagRunner({
      vendorDir: vendorDir(),
      enabled: true,
      timeoutMs: 45_000,
      workspaceRoot: path.join(tmp, 'localdiag-workspace'),
    });
  });

  afterEach(async () => {
    await runner.shutdown();
    // The killed server releases its workspace watcher handles a beat after
    // SIGTERM — Windows reports EBUSY on an immediate rmdir. Wait, then retry.
    await new Promise((r) => setTimeout(r, 750));
    delete process.env.CONTRAIL_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('apex: clean class is clean; broken syntax is caught; both are honest', async () => {
    const clean = await runner.checkApex(
      'public class ItClean { public Integer one() { return 1; } }',
      'class',
    );
    expect(clean).toEqual({ checked: true, diagnostics: [] });

    const broken = await runner.checkApex(
      'public class ItBroken { Integer x() { return 1 } }',
      'class',
    );
    expect(broken.checked).toBe(true);
    if (broken.checked) {
      expect(broken.diagnostics.some((d) => d.code === 'missing.syntax')).toBe(true);
      expect(broken.diagnostics[0]?.line).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it('apex: settle logic survives the semantic warm-up wave (stdlib refs stay clean)', async () => {
    // Calibrated: for ~3s after spawn the semantic validator false-flags
    // System.debug and standard fields, then clears. First-non-empty would
    // report garbage here; the settle window must not.
    const result = await runner.checkApex(
      "public class ItStd { void go() { System.debug('y'); Contact c = new Contact(LastName='z'); } }",
      'class',
    );
    expect(result).toEqual({ checked: true, diagnostics: [] });
  }, 120_000);

  it('apex: org-only types are TOLERATED, not flagged (the documented blind spot)', async () => {
    const result = await runner.checkApex(
      'public class ItOrg { void go() { Broker__c b = new Broker__c(); System.debug(b); } }',
      'class',
    );
    expect(result).toEqual({ checked: true, diagnostics: [] });
  }, 120_000);

  it('apex: triggers and anonymous blocks route to their parsers', async () => {
    const trig = await runner.checkApex(
      'trigger ItTrig on Account (before insert) { System.debug(1); }',
      'trigger',
    );
    expect(trig).toEqual({ checked: true, diagnostics: [] });

    const anon = await runner.checkApex("System.debug('hi');", 'anonymous');
    expect(anon).toEqual({ checked: true, diagnostics: [] });
  }, 240_000);

  it('soql: keep-alive server parses good and bad queries correctly across checks', async () => {
    const good = await runner.checkSoql('SELECT Id, Name FROM Account LIMIT 5');
    expect(good).toEqual({ checked: true, diagnostics: [] });

    const bad = await runner.checkSoql('SELECT FROM WHERE LIMIT');
    expect(bad.checked).toBe(true);
    if (bad.checked) {
      expect(bad.diagnostics.length).toBeGreaterThan(0);
      expect(bad.diagnostics[0]?.severity).toBe('error');
    }

    // A prior check's didClose-clear must never race in as this one's answer.
    const goodAgain = await runner.checkSoql('SELECT Id FROM Contact');
    expect(goodAgain).toEqual({ checked: true, diagnostics: [] });
  }, 60_000);

  it('reports not_installed honestly when the vendor payload is absent', async () => {
    const bare = createLocalDiagRunner({
      vendorDir: path.join(tmp, 'nowhere'),
      enabled: true,
      timeoutMs: 5_000,
      workspaceRoot: path.join(tmp, 'ws2'),
    });
    const result = await bare.checkApex('public class X {}', 'class');
    expect(result).toEqual({
      checked: false,
      unavailable: 'not_installed',
      detail: expect.stringContaining('vendored') as unknown as string,
    });
    await bare.shutdown();
  });
});

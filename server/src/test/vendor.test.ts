import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vendorDir } from '../core/paths.js';

/**
 * THE VENDOR TRIPWIRE. The repo's `.gitignore` has an unanchored `dist/`
 * line that once nearly swallowed server/vendor/apex-ls/dist/** silently —
 * out of git add, out of the teammate zip, and out of CI's clean checkout,
 * which would have shipped every release with check_apex/check_soql
 * permanently "not_installed" and no error anywhere. This test fails loudly
 * (in CI's clean checkout above all) if the payload ever goes missing or
 * drifts from the pinned upstream bytes. Pins live in
 * server/vendor/PROVENANCE.md — update BOTH on a deliberate refresh.
 */

const EXPECTED: Array<{ rel: string; bytes: number; sha256: string | null }> = [
  {
    rel: 'apex-ls/dist/server.node.js',
    bytes: 9_594_907,
    sha256: '4a3c59a2b83a19190e2404036d77ad5b18c15d35d92b9b2e95739298ed9a88f0',
  },
  {
    rel: 'apex-ls/dist/worker.platform.js',
    bytes: 9_372_762,
    sha256: '3429659b0dad5f1f4626ec3878063c00e72c6566eaad8afc850b85d1db29eaec',
  },
  {
    rel: 'bin/soql-lsp.bundled.js',
    bytes: 715_769,
    sha256: 'c96d08d5fb656b2fc72feb4c655be2494e8ad9278df4b57073fa1b142dc71023',
  },
  // Anchors: load-bearing for module-type and worker resolution; content ours.
  { rel: 'apex-ls/package.json', bytes: -1, sha256: null },
  { rel: 'apex-ls/VERSION', bytes: -1, sha256: null },
  { rel: 'bin/package.json', bytes: -1, sha256: null },
];

describe('vendored language-server payload', () => {
  it('resolves via vendorDir() and matches the pinned bytes', () => {
    const dir = vendorDir();
    expect(dir, 'vendorDir() must resolve in the source tree').not.toBeNull();
    for (const entry of EXPECTED) {
      const file = path.join(dir!, entry.rel);
      expect(fs.existsSync(file), `${entry.rel} must exist (gitignore ate it?)`).toBe(true);
      const data = fs.readFileSync(file);
      if (entry.bytes >= 0) {
        expect(data.length, `${entry.rel} byte size`).toBe(entry.bytes);
      }
      if (entry.sha256) {
        expect(createHash('sha256').update(data).digest('hex'), `${entry.rel} sha256`).toBe(
          entry.sha256,
        );
      }
    }
  });

  it('the soql bin anchor pins CommonJS (ESM fallthrough crashes the bundle at startup)', () => {
    const dir = vendorDir();
    const anchor = JSON.parse(
      fs.readFileSync(path.join(dir!, 'bin', 'package.json'), 'utf8'),
    ) as { type?: string };
    expect(anchor.type).toBe('commonjs');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SOURCE_FILE_BYTES,
  allowedSourceRoots,
  resolveSourceFile,
  resolveSourcePath,
} from '../deploy/sources.js';

/**
 * Deploy-from-file confinement.
 *
 * Whatever resolveSourceFile returns gets deployed to a Salesforce org, so the
 * question these tests answer is not "does it read a file" but "what can it be
 * pointed at". The threat is concrete: a path to an SSH key or a .env,
 * deployed as a static resource and read back out of the org — an exfiltration
 * channel wearing the costume of a metadata deploy. The agent reads untrusted
 * org text (flow descriptions, Apex comments), so intent is not a control.
 */

let tmp: string;
let staging: string;
let outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-sources-'));
  process.env.CONTRAIL_DATA_DIR = tmp; // stagingDir()/snapshotsDir() live under here
  staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-outside-'));
});

afterEach(() => {
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('what it will read', () => {
  it('reads a file in the staging directory byte-exactly and fingerprints it', () => {
    // The whole point: content that a model could not retype without risk.
    const xml = `<?xml version="1.0"?>\n<Flow><label>Bíg — flow</label>${'<x/>'.repeat(5000)}</Flow>`;
    const file = path.join(staging, 'Big_Flow.flow');
    fs.writeFileSync(file, xml, 'utf8');

    const src = resolveSourceFile(file);
    expect(src.content).toBe(xml);
    expect(src.sourcePath).toBe(fs.realpathSync(file));
    expect(src.sourceSha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    );
  });

  it('reads from the snapshot tree — deploying org A’s copy into org B', () => {
    const snapDir = path.join(tmp, 'snapshots', 'conn-1', 'current', 'flows');
    fs.mkdirSync(snapDir, { recursive: true });
    const file = path.join(snapDir, 'Send_Invoice.flow');
    fs.writeFileSync(file, '<Flow/>', 'utf8');
    expect(resolveSourceFile(file).content).toBe('<Flow/>');
  });

  it('reads from a root the HUMAN configured, and only because they configured it', () => {
    const repo = path.join(outside, 'sfdx', 'force-app');
    fs.mkdirSync(repo, { recursive: true });
    const file = path.join(repo, 'Thing.cls');
    fs.writeFileSync(file, 'public class Thing {}', 'utf8');

    expect(() => resolveSourceFile(file)).toThrow(/outside every allowed/);
    expect(resolveSourceFile(file, [outside]).content).toBe('public class Thing {}');
  });
});

describe('what it refuses', () => {
  it('refuses a path outside every root, and names the roots so the caller can recover', () => {
    const file = path.join(outside, 'id_rsa');
    fs.writeFileSync(file, 'PRIVATE KEY', 'utf8');
    expect(() => resolveSourceFile(file)).toThrow(/outside every allowed deploy source root/);
    // The error has to be actionable, not just a refusal.
    expect(() => resolveSourceFile(file)).toThrow(/staging/);
  });

  it('refuses a symlink that escapes an allowed root (the classic bypass)', () => {
    const secret = path.join(outside, 'secret.env');
    fs.writeFileSync(secret, 'ANTHROPIC_API_KEY=sk-ant-real', 'utf8');
    const link = path.join(staging, 'innocent.flow');
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return; // Windows without developer mode: no symlink privilege, skip
    }
    // The link SITS in staging; only realpath-before-check catches this.
    expect(() => resolveSourceFile(link)).toThrow(/outside every allowed/);
  });

  it('refuses a relative path rather than resolving it against an unknown cwd', () => {
    expect(() => resolveSourceFile('staging/Thing.cls')).toThrow(/absolute path/);
  });

  it('refuses a directory, a missing file, and an empty argument', () => {
    expect(() => resolveSourceFile(staging)).toThrow(/not a regular file/);
    expect(() => resolveSourceFile(path.join(staging, 'nope.flow'))).toThrow(/does not exist/);
    expect(() => resolveSourceFile('   ')).toThrow(/empty/);
  });

  it('refuses an absurdly large file instead of building a deploy out of it', () => {
    const file = path.join(staging, 'huge.cls');
    fs.writeFileSync(file, 'x'.repeat(MAX_SOURCE_FILE_BYTES + 1), 'utf8');
    expect(() => resolveSourceFile(file)).toThrow(/limit is/);
  });
});

describe('resolveSourcePath (the shared containment chain, parameterized)', () => {
  it('resolves without reading, honoring a caller-supplied size cap', () => {
    const file = path.join(staging, 'rows.csv');
    fs.writeFileSync(file, 'Name\nAcme\n', 'utf8');
    const { absPath, size } = resolveSourcePath(file, [], { maxBytes: 1_000, noun: 'csv_file' });
    expect(absPath).toBe(fs.realpathSync(file));
    expect(size).toBe(fs.statSync(file).size);
    // A cap smaller than the file refuses — the bulk cap is not the deploy cap.
    expect(() => resolveSourcePath(file, [], { maxBytes: 3 })).toThrow(/limit is 3/);
  });

  it('names the caller-facing argument in every refusal, not "content_file"', () => {
    expect(() => resolveSourcePath('rel/x.csv', [], { noun: 'csv_file' })).toThrow(
      /csv_file must be an absolute path/,
    );
    expect(() =>
      resolveSourcePath(path.join(staging, 'nope.csv'), [], { noun: 'csv_file' }),
    ).toThrow(/csv_file does not exist/);
    const secret = path.join(outside, 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY', 'utf8');
    expect(() => resolveSourcePath(secret, [], { noun: 'csv_file' })).toThrow(
      /csv_file is outside every allowed deploy source root/,
    );
  });

  it('keeps resolveSourceFile behaviour identical after the extraction', () => {
    const file = path.join(staging, 'Thing.cls');
    fs.writeFileSync(file, 'public class Thing {}', 'utf8');
    const src = resolveSourceFile(file);
    expect(src.content).toBe('public class Thing {}');
    expect(src.sourcePath).toBe(fs.realpathSync(file));
    expect(() => resolveSourceFile('rel/x.cls')).toThrow(/content_file must be an absolute path/);
  });
});

describe('the root list itself', () => {
  it("always includes Contrail's own directories, with no configuration", () => {
    const roots = allowedSourceRoots();
    expect(roots.some((r) => r.endsWith(`${path.sep}staging`))).toBe(true);
    expect(roots.some((r) => r.endsWith(`${path.sep}snapshots`))).toBe(true);
  });

  it('ignores configured roots that are relative or do not exist', () => {
    const roots = allowedSourceRoots(['./relative', path.join(outside, 'not-created-yet')]);
    expect(roots).toHaveLength(2); // staging + snapshots only
  });
});

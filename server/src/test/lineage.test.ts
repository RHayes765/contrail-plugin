import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ContrailDb } from '../core/db.js';

/**
 * The split-brain guard. The incident it exists for: an MSIX overlay gave two
 * processes different copy-on-write views of one database path; both were
 * self-consistent, so nothing refused, and interleaved checkpoints destroyed
 * the file. The guard stamps the file's OS identity into the SQLite header
 * (application_id) — any COPY of the file is a different physical file, so a
 * forked view is refused on open, before a single byte is written.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-lineage-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('split-brain guard (db lineage)', () => {
  it('stamps a fresh database and reopens it freely', () => {
    const file = path.join(tmp, 'a.db');
    new ContrailDb(file).close();
    const raw = new Database(file, { readonly: true });
    const stamp = raw.pragma('application_id', { simple: true }) as number;
    raw.close();
    expect(stamp).toBeGreaterThan(0); // stamped on first open

    // Same physical file: reopening is normal life, never refused.
    const again = new ContrailDb(file);
    again.close();
  });

  it('adopts a pre-guard database (application_id 0) without ceremony', () => {
    // A database from before the guard existed: fully migrated, but never
    // stamped. Simulate by clearing the stamp on a real one.
    const file = path.join(tmp, 'old.db');
    new ContrailDb(file).close();
    const raw = new Database(file);
    raw.pragma('application_id = 0');
    raw.close();
    const db = new ContrailDb(file);
    db.close();
    const check = new Database(file, { readonly: true });
    expect(check.pragma('application_id', { simple: true })).toBeGreaterThan(0);
    check.close();
  });

  it('REFUSES a copy of a stamped database — the exact split-brain signature', () => {
    const original = path.join(tmp, 'real.db');
    new ContrailDb(original).close();

    // The overlay scenario: same bytes, different physical file.
    const clone = path.join(tmp, 'overlay-copy.db');
    fs.copyFileSync(original, clone);

    expect(() => new ContrailDb(clone)).toThrow(/split-brain/);
    expect(() => new ContrailDb(clone)).toThrow(/\.adopt/); // the way out is named

    // The refusal wrote nothing to the DATABASE. (Opening a WAL-mode file
    // creates an empty -wal as a side effect of the connection itself; the
    // data file and its stamp are untouched.)
    const rawClone = new Database(clone, { readonly: true });
    expect(rawClone.pragma('application_id', { simple: true })).toBeGreaterThan(0);
    rawClone.close();

    // The original is unaffected.
    new ContrailDb(original).close();
  });

  it('the adopt marker turns a deliberate replacement into the new lineage', () => {
    const original = path.join(tmp, 'real.db');
    new ContrailDb(original).close();
    const restored = path.join(tmp, 'restored.db');
    fs.copyFileSync(original, restored);

    expect(() => new ContrailDb(restored)).toThrow(/split-brain/);

    fs.writeFileSync(`${restored}.adopt`, '', 'utf8');
    const db = new ContrailDb(restored); // adopted
    db.close();
    expect(fs.existsSync(`${restored}.adopt`)).toBe(false); // marker consumed

    // Adoption is single-use and sticky: reopening needs no marker…
    new ContrailDb(restored).close();
    // …and a FURTHER copy of the adopted file is refused again.
    const clone2 = path.join(tmp, 'clone2.db');
    fs.copyFileSync(restored, clone2);
    expect(() => new ContrailDb(clone2)).toThrow(/split-brain/);
  });

  it('a rename on the same volume keeps the lineage (same physical file)', () => {
    const a = path.join(tmp, 'a.db');
    new ContrailDb(a).close();
    const b = path.join(tmp, 'b.db');
    fs.renameSync(a, b); // same NTFS file id — identity is the file, not the name
    new ContrailDb(b).close();
  });
});

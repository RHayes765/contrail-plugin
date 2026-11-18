import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { dataDir } from '../core/paths.js';
import { ContrailError } from '../core/errors.js';

/**
 * On-disk snapshot layout (spec §6: snapshot zips on disk, index in SQLite):
 *
 *   {dataDir}/snapshots/{connectionId}/archive/{timestamp}.zip   raw retrieve zips (diff history for P0.3)
 *   {dataDir}/snapshots/{connectionId}/current/...               extracted latest tree
 */
export class SnapshotStore {
  constructor(private readonly baseDir: string = path.join(dataDir(), 'snapshots')) {}

  private connDir(connectionId: string): string {
    // connection ids are UUIDs we mint; keep the guard anyway.
    if (!/^[A-Za-z0-9-]+$/.test(connectionId)) {
      throw new ContrailError('invalid connection id', 'bad_connection_id');
    }
    return path.join(this.baseDir, connectionId);
  }

  saveZip(connectionId: string, zip: Buffer, timestamp: string): string {
    const dir = path.join(this.connDir(connectionId), 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${timestamp.replaceAll(':', '-')}.zip`);
    fs.writeFileSync(file, zip);
    return file;
  }

  /**
   * Extract a Metadata API retrieve zip into a path→bytes map, stripping the
   * "unpackaged/" prefix and refusing traversal-shaped entry names.
   */
  extractRetrieveZip(zip: Buffer): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const entries = unzipSync(new Uint8Array(zip));
    for (const [rawName, bytes] of Object.entries(entries)) {
      const name = rawName.replaceAll('\\', '/').replace(/^unpackaged\//, '');
      if (!name || name.endsWith('/')) continue;
      const segments = name.split('/');
      if (segments.some((s) => s === '..' || s === '' || path.isAbsolute(s))) {
        throw new ContrailError(`unsafe zip entry path: ${rawName}`, 'unsafe_zip_entry');
      }
      out.set(name, bytes);
    }
    return out;
  }

  /**
   * Replace the current/ tree with a freshly extracted snapshot. A partial
   * refresh passes `clearDirs` (the top-level directories it actually
   * re-retrieved) so previously snapshotted types survive on disk; only a
   * full-manifest refresh wipes the whole tree.
   */
  writeCurrent(
    connectionId: string,
    files: Map<string, Uint8Array>,
    options?: { clearDirs?: string[] },
  ): void {
    const dir = path.join(this.connDir(connectionId), 'current');
    if (options?.clearDirs) {
      for (const sub of options.clearDirs) {
        if (!/^[A-Za-z0-9_-]+$/.test(sub)) {
          throw new ContrailError(`unsafe snapshot subdirectory: ${sub}`, 'unsafe_zip_entry');
        }
        fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const [rel, bytes] of files) {
      const target = path.join(dir, rel);
      if (!target.startsWith(dir + path.sep) && target !== dir) {
        throw new ContrailError(`unsafe snapshot path: ${rel}`, 'unsafe_zip_entry');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
  }

  /**
   * S46 (member-scoped refresh): replace named units of the current/ tree —
   * remove `removeFiles` and `removeDirs`, write `files` — without touching
   * anything else. applyMemberUnits is its only caller.
   *
   * Every entry is validated BEFORE the first filesystem change, so a bad
   * entry changes nothing: forward-slash relative, no empty, `.` or `..`
   * segment, no backslash, no absolute or drive segment, at least two
   * segments (a top-level directory and package.xml are unrepresentable);
   * a `removeDirs` entry has exactly two segments (`<typeDir>/<bundle>`)
   * and its first is one of `bundleTypeDirs` — the store deletes a
   * directory only under a type directory the caller declared as holding
   * bundles, so `reports/<Folder>` can never be removed; each target stays
   * inside current/ lexically and by the realpath of its nearest existing
   * ancestor, so with no current/ tree every entry is refused; a directory
   * at a `removeFiles` or `files` path is refused, and so is a file where a
   * parent directory must go — unless the path is a `files` entry and that
   * file is one of the removals, which the swap makes first.
   *
   * Then stage, then swap. Every new file is first written under a sibling
   * staged/ directory (cleared first — a leftover from a crash included); a
   * failure there removes staged/ and rethrows with current/ untouched.
   * Only then are the removals made and each staged file renamed into
   * place; a failure in that phase is `snapshot_partial_write`. Never
   * touches archive/, never creates or removes current/ itself.
   */
  replaceCurrentUnits(
    connectionId: string,
    input: {
      removeFiles: string[];
      removeDirs: string[];
      bundleTypeDirs: string[];
      files: Map<string, Uint8Array>;
    },
  ): { removed: number; written: number } {
    const conn = this.connDir(connectionId);
    const current = path.join(conn, 'current');
    const staged = path.join(conn, 'staged');
    const currentResolved = path.resolve(current);
    const currentReal = fs.existsSync(current) ? fs.realpathSync(current) : null;
    const present = (p: string): boolean => {
      try {
        return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
      } catch {
        return false; // ENOTDIR: a file stands where a directory would be; the walk finds it
      }
    };

    const check = (rel: string, kind: 'file' | 'dir', removing?: Set<string>): string => {
      const unsafe = (): never => {
        throw new ContrailError(`unsafe snapshot path: ${rel}`, 'unsafe_zip_entry');
      };
      if (typeof rel !== 'string' || rel.includes('\\')) unsafe();
      const segments = rel.split('/');
      if (
        segments.some(
          (s) => s === '' || s === '.' || s === '..' || path.isAbsolute(s) || /^[A-Za-z]:/.test(s),
        )
      ) {
        unsafe();
      }
      if (segments.length < 2) unsafe();
      if (kind === 'dir' && (segments.length !== 2 || !input.bundleTypeDirs.includes(segments[0]!))) {
        unsafe();
      }
      const target = path.resolve(current, ...segments);
      if (!target.startsWith(currentResolved + path.sep)) unsafe();
      // No current/ tree: the nearest existing ancestor lies outside it, and
      // the store never creates current/.
      if (currentReal === null) return unsafe();
      // The nearest existing ancestor (the target itself when it exists)
      // must really live inside current/ — no link may carry the write out.
      let probe = target;
      while (probe !== currentResolved && !present(probe)) {
        probe = path.dirname(probe);
      }
      let real: string;
      let isDir: boolean;
      try {
        real = fs.realpathSync(probe);
        isDir = fs.statSync(probe).isDirectory();
      } catch {
        return unsafe();
      }
      if (real !== currentReal && !real.startsWith(currentReal + path.sep)) unsafe();
      if (probe === target) {
        if (kind === 'file' && isDir) unsafe();
      } else if (!isDir && !removing?.has(probe)) {
        // A file where a parent directory must go: only a write may land
        // under it, and only when that file is one of the removals.
        unsafe();
      }
      return target;
    };

    const dirTargets = input.removeDirs.map((rel) => check(rel, 'dir'));
    const fileTargets = input.removeFiles.map((rel) => check(rel, 'file'));
    const removing = new Set([...dirTargets, ...fileTargets]);
    const writes = [...input.files].map(([rel, bytes]) => ({
      target: check(rel, 'file', removing),
      rel,
      bytes,
    }));

    // 1. Stage: current/ is not touched until every new file exists on disk.
    try {
      fs.rmSync(staged, { recursive: true, force: true });
      for (const w of writes) {
        const file = path.join(staged, ...w.rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, w.bytes);
      }
    } catch (err) {
      try {
        fs.rmSync(staged, { recursive: true, force: true });
      } catch {
        /* best-effort: the next run clears staged/ before staging */
      }
      throw err;
    }

    // 2. Swap: remove, then move each staged file into place.
    let removed = 0;
    try {
      for (const target of [...dirTargets, ...fileTargets]) {
        if (fs.lstatSync(target, { throwIfNoEntry: false })) removed += 1;
      }
      for (const target of dirTargets) fs.rmSync(target, { recursive: true, force: true });
      for (const target of fileTargets) fs.rmSync(target, { force: true });
      for (const w of writes) {
        fs.mkdirSync(path.dirname(w.target), { recursive: true });
        fs.renameSync(path.join(staged, ...w.rel.split('/')), w.target);
      }
    } catch (err) {
      throw new ContrailError(
        `snapshot files only partly replaced: ${err instanceof Error ? err.message : String(err)}`,
        'snapshot_partial_write',
      );
    } finally {
      try {
        fs.rmSync(staged, { recursive: true, force: true });
      } catch {
        /* best-effort: the next run clears staged/ before staging */
      }
    }
    return { removed, written: writes.length };
  }

  /**
   * Absolute path of a file in the current/ tree, or null if it would escape.
   * retrieve_metadata hands this back so a caller holding real file tools can
   * read a huge artifact directly instead of paging it through tool results.
   */
  currentFilePath(connectionId: string, relPath: string): string | null {
    const dir = path.join(this.connDir(connectionId), 'current');
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(path.resolve(dir) + path.sep)) return null;
    return fs.existsSync(target) ? target : null;
  }

  readCurrentFile(connectionId: string, relPath: string): string | null {
    const dir = path.join(this.connDir(connectionId), 'current');
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(path.resolve(dir) + path.sep)) return null;
    try {
      return fs.readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * S30: every file under a directory prefix of the current/ tree, as
   * relative paths (forward slashes), sorted — the read surface for bundle
   * types, where one component is a directory of files. Same containment
   * discipline as the single-file reads; empty when the prefix is absent or
   * would escape.
   */
  listCurrentFiles(connectionId: string, relDirPrefix: string): string[] {
    const dir = path.join(this.connDir(connectionId), 'current');
    const target = path.resolve(dir, relDirPrefix);
    if (!target.startsWith(path.resolve(dir) + path.sep)) return [];
    const out: string[] = [];
    const walk = (abs: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = path.join(abs, e.name);
        if (e.isDirectory()) walk(child);
        else if (e.isFile()) {
          out.push(path.relative(dir, child).replaceAll(path.sep, '/'));
        }
      }
    };
    walk(target);
    return out.sort();
  }

  removeConnection(connectionId: string): void {
    fs.rmSync(this.connDir(connectionId), { recursive: true, force: true });
  }
}

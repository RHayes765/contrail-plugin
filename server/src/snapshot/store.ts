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

  removeConnection(connectionId: string): void {
    fs.rmSync(this.connDir(connectionId), { recursive: true, force: true });
  }
}

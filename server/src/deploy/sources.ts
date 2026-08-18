import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ContrailError } from '../core/errors.js';
import { snapshotsDir, stagingDir } from '../core/paths.js';

/**
 * Deploy payloads that come from a file on disk instead of a tool argument.
 *
 * Why this exists: a 133 KB flow cannot travel through a model's output
 * byte-exactly. One transposed character in flow XML is a failed deploy or,
 * worse, a silently wrong behaviour. So the agent writes the file and names
 * the path, and the bytes never pass through a language model.
 *
 * Why it is confined: whatever this returns gets deployed to a Salesforce org.
 * An unconstrained path would let anything readable on this machine — an SSH
 * key, a .env, Contrail's own config — be deployed as a static resource and
 * read back out of the org. That is an exfiltration channel through the
 * safest-looking tool in the set, and the agent reads untrusted org metadata
 * (flow descriptions, Apex comments are injection surface), so "the agent
 * would not do that" is not a control. Hence: an allowlist of roots, with the
 * human's own config as the only way to widen it.
 *
 * Note the ordering that makes this safe overall: the file is read at VALIDATE
 * time and frozen into the deploy zip (engine.ts writes it to deploysDir), and
 * execute_deploy replays only that zip. Swapping the file after approval
 * changes nothing — the human approved bytes that were already fixed.
 */

/** A single deployable file. Metadata source is text; 5 MB is far past real. */
export const MAX_SOURCE_FILE_BYTES = 5_000_000;

export interface ResolvedSource {
  content: string;
  /** Absolute, symlink-resolved path the bytes actually came from. */
  sourcePath: string;
  /** SHA-256 of the raw bytes — shown to the human, recorded in the audit. */
  sourceSha256: string;
}

/**
 * Roots a deploy may read from. The first two are Contrail's own directories
 * and need no configuration; the rest come from the human's config.json
 * (`deploy.allowedSourceRoots`), which the agent cannot write.
 */
export function allowedSourceRoots(configured: string[] = []): string[] {
  const roots = [stagingDir(), snapshotsDir(), ...configured];
  const real: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue; // a relative root is meaningless here
    try {
      real.push(fs.realpathSync(root));
    } catch {
      // A configured root that does not exist yet is not an error — it just
      // cannot match anything.
    }
  }
  return real;
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Read one deploy component from disk. Throws a ContrailError the agent can
 * act on — the message names the staging directory, because that is the path
 * that always works.
 */
export function resolveSourceFile(rawPath: string, configuredRoots: string[] = []): ResolvedSource {
  const given = rawPath.trim();
  if (!given) throw new ContrailError('content_file was empty.', 'bad_source_path');
  if (!path.isAbsolute(given)) {
    throw new ContrailError(
      `content_file must be an absolute path (got "${given}"). Write the file under ` +
        `${stagingDir()} and pass that full path.`,
      'bad_source_path',
    );
  }

  // realpath BEFORE the containment check: a symlink inside an allowed root
  // pointing at /etc/shadow must fail, not pass.
  let real: string;
  try {
    real = fs.realpathSync(given);
  } catch {
    throw new ContrailError(`content_file does not exist: ${given}`, 'source_not_found');
  }

  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    throw new ContrailError(`content_file is not a regular file: ${given}`, 'bad_source_path');
  }
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw new ContrailError(
      `content_file is ${stat.size} bytes; the limit is ${MAX_SOURCE_FILE_BYTES}.`,
      'source_too_large',
    );
  }

  const roots = allowedSourceRoots(configuredRoots);
  if (!roots.some((root) => isInside(real, root))) {
    throw new ContrailError(
      `content_file is outside every allowed deploy source root, so Contrail will not ` +
        `deploy it. Allowed: ${roots.join(', ')}. Write the file under ${stagingDir()}, or add ` +
        `its directory to deploy.allowedSourceRoots in config.json (only you can edit that).`,
      'source_outside_roots',
    );
  }

  const bytes = fs.readFileSync(real);
  return {
    content: bytes.toString('utf8'),
    sourcePath: real,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

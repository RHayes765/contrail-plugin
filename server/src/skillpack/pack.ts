import fs from 'node:fs';
import path from 'node:path';
import type { SkillsDirResolution } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';

/**
 * The skill pack that ships inside this install (the root-level skills/
 * folder): loaded once at startup, then served by name. Plugin-only — the
 * desktop app has its own skill library.
 *
 * Two rules shape everything here:
 *   - A broken pack never stops the server. loadSkillPack never throws; any
 *     filesystem error yields an empty pack, which the callers report.
 *   - The agent's `name` is only ever COMPARED against Contrail's own listing,
 *     never joined into a path; a `file` is served only when it is an exact
 *     member of that listing. The lstat walk and the realpath containment
 *     behind it are the backstop, not the gate.
 */

export interface SkillEntry {
  name: string;
  description: string;
  /** Absolute, under the realpath root. */
  dir: string;
  /** Relative, forward slashes, sorted; excludes SKILL.md. */
  files: string[];
  /** The listing was cut at the 200-entry cap. */
  filesTruncated?: true;
}

export interface SkillPack {
  root: string | null;
  source: 'bundled' | 'override' | 'override_missing' | 'absent';
  looked: string[];
  /** Sorted by code point. */
  skills: SkillEntry[];
  skipped: Array<{ dir: string; reason: 'no_frontmatter' | 'name_mismatch' }>;
}

export const READ_SKILL_MAX_CHARS = 40_000;
export const READ_SKILL_MAX_FILE_BYTES = 5_000_000;
/** Files listed (and therefore served) per skill. */
export const SKILL_FILES_CAP = 200;

/** What a pack with nothing to serve says, by source (list_skills, read_skill). */
export const SKILLS_ABSENT_NOTE =
  "This Contrail install has no bundled skills folder. Contrail's other tools work " +
  'normally. Reinstalling Contrail from its release restores the skills; ' +
  'CONTRAIL_SKILLS_DIR can point at a skills folder explicitly.';
export const SKILLS_OVERRIDE_MISSING_NOTE =
  'CONTRAIL_SKILLS_DIR is set, but the folder it names is missing or holds no valid ' +
  "skill, so there are no skills to serve. Contrail's other tools work normally. " +
  'Correct or unset CONTRAIL_SKILLS_DIR.';

const SKILL_DIR_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAMESPACE_PREFIX = /^[a-z0-9][a-z0-9._-]*:/i;
const OVERLAY_PATCH = 'skill.overlay.patch';

/**
 * Minimal frontmatter reader: top-level `name:` and `description:` scalars
 * (bare or single-line quoted) between the leading `---` fences. Deliberately
 * NOT a YAML parser — a skill whose identity fields need more than this is a
 * skill whose identity fields should be simplified.
 *
 * A line-for-line port of the desktop app's parser (its packages/skills): the
 * same regexes and the same refusals, so both read one pack the same way.
 */
export function parseSkillFrontmatter(md: string): { name: string; description: string } | null {
  const fence = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return null;
  const body = fence[1] ?? '';
  const scalar = (key: string): string | null => {
    const line = body.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    if (!line) return null;
    let v = (line[1] ?? '').trim();
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) return null; // multi-line: unsupported
      v = v.slice(1, -1).replaceAll('\\"', '"');
    } else if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) return null;
      v = v.slice(1, -1);
    }
    return v.length > 0 ? v : null;
  };
  const name = scalar('name');
  const description = scalar('description');
  return name && description ? { name, description } : null;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A skill folder's SKILL.md frontmatter, or null when the folder has no
 * SKILL.md that can be one: absent, not a regular file (a link is not followed
 * here either), over the served size, or without parsable frontmatter.
 */
function readFrontmatter(mdPath: string): { name: string; description: string } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(mdPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  if (!st.isFile() || st.size > READ_SKILL_MAX_FILE_BYTES) return null;
  return parseSkillFrontmatter(fs.readFileSync(mdPath, 'utf8'));
}

/**
 * The files a skill carries besides SKILL.md: regular files only, at any
 * depth, in a sorted walk that stops at the cap. Left out: SKILL.md itself,
 * SKILL.overlay.patch (repository bookkeeping), links (a Dirent for a symlink
 * or junction is neither a file nor a directory), dotfiles, and any name
 * read_skill's path check would refuse — this listing IS the set read_skill
 * serves, so it never names a file that cannot be asked for.
 */
function listSkillFiles(skillDir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (abs: string, rel: string): void => {
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => byCodePoint(a.name, b.name));
    for (const entry of entries) {
      if (truncated) return;
      // Also drops dotfiles: a segment must start with a letter or digit.
      if (!FILE_SEGMENT.test(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(abs, entry.name), relPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower === OVERLAY_PATCH) continue;
        if (rel === '' && lower === 'skill.md') continue;
        if (files.length >= SKILL_FILES_CAP) {
          truncated = true;
          return;
        }
        files.push(relPath);
      }
    }
  };
  walk(skillDir, '');
  files.sort(byCodePoint);
  return { files, truncated };
}

/**
 * Read the pack a resolution points at. Never throws: any filesystem error
 * yields an empty pack.
 *
 * The pack's source is the resolution's, with one rule: an override is never
 * turned into `absent`. When CONTRAIL_SKILLS_DIR was set and no skill could be
 * loaded (folder missing, unreadable, or holding no valid skill) the source is
 * `override_missing`; an empty pack from any other resolution is `absent`.
 */
export function loadSkillPack(res: SkillsDirResolution): SkillPack {
  const overridden = res.source === 'override' || res.source === 'override_missing';
  const empty = (skipped: SkillPack['skipped'] = []): SkillPack => ({
    root: null,
    source: overridden ? 'override_missing' : 'absent',
    looked: res.looked,
    skills: [],
    skipped,
  });
  if (!res.dir) return empty();
  try {
    // The resolver already hands over a real path; resolving again keeps the
    // containment check in readSkillFile true for any caller's resolution.
    const root = fs.realpathSync(res.dir);
    const skills: SkillEntry[] = [];
    const skipped: SkillPack['skipped'] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      // Real directories only: a Dirent for a symlink or junction is not a
      // directory, so a linked folder is never listed.
      if (!entry.isDirectory() || !SKILL_DIR_NAME.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const fm = readFrontmatter(path.join(dir, 'SKILL.md'));
      if (!fm) {
        skipped.push({ dir, reason: 'no_frontmatter' });
        continue;
      }
      if (fm.name !== entry.name) {
        skipped.push({ dir, reason: 'name_mismatch' });
        continue;
      }
      const listing = listSkillFiles(dir);
      skills.push({
        name: fm.name,
        description: fm.description,
        dir,
        files: listing.files,
        ...(listing.truncated ? { filesTruncated: true as const } : {}),
      });
    }
    skipped.sort((a, b) => byCodePoint(a.dir, b.dir));
    if (skills.length === 0) return empty(skipped);
    skills.sort((a, b) => byCodePoint(a.name, b.name));
    return {
      root,
      source: overridden ? 'override' : 'bundled',
      looked: res.looked,
      skills,
      skipped,
    };
  } catch {
    return empty();
  }
}

/**
 * Find a skill by the name an agent gave: trimmed, ONE leading namespace
 * prefix dropped (`contrail:`, `anthropic-skills:`, ...), case-insensitive. A
 * name copied from a client's own skill list therefore resolves to the
 * bundled copy.
 */
export function findSkill(pack: SkillPack, rawName: string): SkillEntry | null {
  const wanted = rawName.trim().replace(NAMESPACE_PREFIX, '').toLowerCase();
  return pack.skills.find((s) => s.name === wanted) ?? null;
}

export type SkillReadRefusal =
  | 'no_pack'
  | 'unknown_skill' // U1
  | 'bad_path' // U2
  | 'no_such_file' // U3
  | 'link_or_escape' // U4
  | 'overlay_patch' // U5
  | 'not_text' // U6
  | 'offset_past_end'; // U7

export type SkillRead =
  | {
      ok: true;
      /** The skill's own name, whatever spelling was asked for. */
      skill: string;
      /** The file served, relative to the skill's folder. */
      file: string;
      /** Absolute path, as this server sees it. */
      path: string;
      /** Size of the file on disk. */
      bytes: number;
      /** Characters in the whole decoded file. */
      total: number;
      /** Character offsets of the part returned: from inclusive, to exclusive. */
      from: number;
      to: number;
      truncated: boolean;
      /** The offset that continues the read, when truncated. */
      nextOffset: number | null;
      /** The part itself, verbatim. */
      content: string;
      /** The one text block to return: header, the part, trailers. */
      text: string;
    }
  | {
      ok: false;
      refusal: SkillReadRefusal;
      message: string;
      /** The resolved skill name, once one was found. */
      skill: string | null;
      /** `file` as given. */
      file: string | null;
    };

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Read SKILL.md (or, with `file`, one of the skill's listed files) as text,
 * at most READ_SKILL_MAX_CHARS characters from `offset`. Never throws: every
 * refusal comes back as `{ ok: false }` with its text.
 */
export function readSkillFile(
  pack: SkillPack,
  name: string,
  file?: string,
  offset?: number,
): SkillRead {
  const given = file ?? null;
  const refuse = (
    refusal: SkillReadRefusal,
    message: string,
    skill: string | null = null,
  ): SkillRead => ({ ok: false, refusal, message, skill, file: given });

  // 1. Nothing to serve.
  if (pack.skills.length === 0) {
    return refuse(
      'no_pack',
      pack.source === 'override_missing' ? SKILLS_OVERRIDE_MISSING_NOTE : SKILLS_ABSENT_NOTE,
    );
  }

  // 2. The skill, from Contrail's own listing.
  const skill = findSkill(pack, name);
  if (!skill) {
    return refuse(
      'unknown_skill',
      `No bundled skill named "${name}". Bundled skills: ${pack.skills.map((s) => s.name).join(', ')}.`,
    );
  }

  // 3. The path, validated before the disk is touched.
  const rel = file ?? 'SKILL.md';
  const segments = rel.split('/');
  if (
    rel.includes('\\') ||
    rel.includes('\0') ||
    rel.includes(':') ||
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    segments.some((s) => s === '' || s === '.' || s === '..' || !FILE_SEGMENT.test(s))
  ) {
    return refuse(
      'bad_path',
      `file must be a relative path inside the skill's folder, with forward slashes and no ".." (got "${rel}").`,
      skill.name,
    );
  }
  // Case-insensitive: NTFS and default APFS would otherwise serve
  // skill.overlay.patch.
  if ((segments[segments.length - 1] ?? '').toLowerCase() === OVERLAY_PATCH) {
    return refuse(
      'overlay_patch',
      'SKILL.overlay.patch is repository bookkeeping, not part of the skill; read_skill does not serve it.',
      skill.name,
    );
  }
  const noSuchFile = (): SkillRead =>
    refuse(
      'no_such_file',
      `Skill "${skill.name}" has no file "${rel}". Its files: ${['SKILL.md', ...skill.files].join(', ')}.` +
        (skill.filesTruncated ? ' Only the first 200 files of this skill are listed and served.' : ''),
      skill.name,
    );
  // Exact and case-sensitive: read_skill serves only what the listing names.
  if (rel !== 'SKILL.md' && !skill.files.includes(rel)) return noSuchFile();

  const linkOrEscape = (): SkillRead =>
    refuse(
      'link_or_escape',
      `"${rel}" in skill "${skill.name}" is a link or resolves outside the skill's folder; read_skill does not follow links.`,
      skill.name,
    );

  // 4. Walk one segment at a time; a link at any component is refused.
  let target = skill.dir;
  let st: fs.Stats | null = null;
  for (const segment of segments) {
    target = path.join(target, segment);
    try {
      st = fs.lstatSync(target);
    } catch {
      return noSuchFile();
    }
    if (st.isSymbolicLink()) return linkOrEscape();
  }

  // 5. Containment on real paths: the file inside the skill's folder, the
  // skill's folder inside the pack's root.
  try {
    const realSkill = fs.realpathSync(skill.dir);
    const realTarget = fs.realpathSync(target);
    if (
      pack.root === null ||
      !isInside(realSkill, pack.root) ||
      !(realTarget === realSkill || isInside(realTarget, realSkill))
    ) {
      return linkOrEscape();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? noSuchFile() : linkOrEscape();
  }

  // 6. A regular file within the size limit.
  const notText = (bytes: number): SkillRead =>
    refuse(
      'not_text',
      `"${rel}" in skill "${skill.name}" is not a text file read_skill can serve (${bytes} bytes). ` +
        `It is on disk at ${target}, as this server sees that path.`,
      skill.name,
    );
  if (!st || !st.isFile() || st.size > READ_SKILL_MAX_FILE_BYTES) return notText(st ? st.size : 0);

  // 7. Text only: no NUL near the start, and strict UTF-8.
  let buf: Buffer;
  try {
    buf = fs.readFileSync(target);
  } catch {
    return noSuchFile();
  }
  if (buf.length > READ_SKILL_MAX_FILE_BYTES || buf.subarray(0, 8192).includes(0)) {
    return notText(buf.length);
  }
  let whole: string;
  try {
    whole = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return notText(buf.length);
  }

  // 8. The part asked for. A cut never lands between a surrogate pair.
  const from = offset === undefined ? 0 : Math.max(0, Math.trunc(offset));
  if (from > whole.length) {
    return refuse(
      'offset_past_end',
      `offset ${offset} is past the end of "${rel}" (${whole.length} characters).`,
      skill.name,
    );
  }
  let to = Math.min(from + READ_SKILL_MAX_CHARS, whole.length);
  if (to < whole.length && to > from) {
    const last = whole.charCodeAt(to - 1);
    const next = whole.charCodeAt(to);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) to -= 1;
  }
  const content = whole.slice(from, to);
  const truncated = to < whole.length;

  // 9. One block: header, blank line, the part verbatim, then the trailers.
  const parts = [
    `[Contrail skill "${skill.name}" - ${rel} - ${buf.length} bytes - engine ${ENGINE_VERSION} - folder ${skill.dir}]`,
    content,
  ];
  if (truncated) {
    parts.push(
      `[truncated: characters ${from}-${to} of ${whole.length} shown. Continue with read_skill ` +
        `${JSON.stringify({ name: skill.name, file: rel, offset: to })}. The whole file is on ` +
        `disk at ${target}, as this server sees that path.]`,
    );
  }
  if (rel === 'SKILL.md' && skill.files.length > 0) {
    parts.push(
      `[Other files in this skill - read one with read_skill ` +
        `{"name":${JSON.stringify(skill.name)},"file":"<path>"}: ${skill.files.join(', ')}]`,
    );
  }
  return {
    ok: true,
    skill: skill.name,
    file: rel,
    path: target,
    bytes: buf.length,
    total: whole.length,
    from,
    to,
    truncated,
    nextOffset: truncated ? to : null,
    content,
    text: parts.join('\n\n'),
  };
}

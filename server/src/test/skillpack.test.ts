import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendersDir, resolveSkillsDir, skillsDir } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';
import {
  findSkill,
  loadSkillPack,
  parseSkillFrontmatter,
  readSkillFile,
  READ_SKILL_MAX_CHARS,
  READ_SKILL_MAX_FILE_BYTES,
  SKILL_FILES_CAP,
  SKILLS_ABSENT_NOTE,
  SKILLS_OVERRIDE_MISSING_NOTE,
  type SkillPack,
  type SkillRead,
} from '../skillpack/pack.js';

/**
 * The skill pack: where it is found (every shipped depth, driven on temp
 * trees — under vitest only server/src/core runs, and a wrong depth would
 * otherwise show up as the silent "absent" variant on a real install), what
 * the loader lists, and what readSkillFile serves and refuses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// The suite reads the repo's own pack; an override from the outside would
// point it somewhere else.
delete process.env.CONTRAIL_SKILLS_DIR;

let tmp: string;

beforeEach(() => {
  // realpath: the loader hands back real paths, and a temp dir can sit behind
  // a link (macOS /var).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-skillpack-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTRAIL_SKILLS_DIR;
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: "Does ${name} things for the test suite."\n---\n\n# ${name}\n\nBody of ${name}.\n`;
}

/** Write `<root>/<name>/SKILL.md` plus the given files (relative, forward slashes). */
function writeSkill(
  root: string,
  name: string,
  files: Record<string, string | Buffer> = {},
  md: string = skillMd(name),
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function packAt(root: string): SkillPack {
  return loadSkillPack({ dir: root, source: 'override', looked: [root] });
}

/** Make a link; false where this account may not (Windows without the symlink privilege). */
function tryLink(target: string, link: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

/** Count every fs call readSkillFile could make, so "no disk access" is a number. */
function watchDisk(): () => number {
  const spies = [
    vi.spyOn(fs, 'readFileSync'),
    vi.spyOn(fs, 'lstatSync'),
    vi.spyOn(fs, 'statSync'),
    vi.spyOn(fs, 'realpathSync'),
    vi.spyOn(fs, 'readdirSync'),
    vi.spyOn(fs, 'existsSync'),
    vi.spyOn(fs, 'openSync'),
  ];
  return () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
}

function refusalOf(read: SkillRead): { refusal: string; message: string } {
  if (read.ok) throw new Error(`expected a refusal, got ${read.file}`);
  return { refusal: read.refusal, message: read.message };
}

function served(read: SkillRead): Extract<SkillRead, { ok: true }> {
  if (!read.ok) throw new Error(`expected a read, got ${read.refusal}: ${read.message}`);
  return read;
}

describe('parseSkillFrontmatter', () => {
  it('reads bare and quoted scalars', () => {
    expect(parseSkillFrontmatter('---\nname: a-skill\ndescription: "Does a thing."\n---\nbody')).toEqual({
      name: 'a-skill',
      description: 'Does a thing.',
    });
    expect(parseSkillFrontmatter("---\nname: x\ndescription: 'single'\n---\n")).toEqual({
      name: 'x',
      description: 'single',
    });
  });

  it('refuses missing fences, missing fields, and multi-line values', () => {
    expect(parseSkillFrontmatter('no frontmatter at all')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: only-name\n---\n')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "starts but\nnever ends on this line\n---\n')).toBeNull();
  });

  it('ignores indented keys inside metadata blocks', () => {
    const md = '---\nname: outer\nmetadata:\n  name: inner\n  description: inner-desc\ndescription: "real one"\n---\n';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'outer', description: 'real one' });
  });
});

describe('the pack this repository ships', () => {
  const res = resolveSkillsDir();
  const pack = loadSkillPack(res);

  it('resolves to <repo>/skills as bundled', () => {
    expect(res.source).toBe('bundled');
    expect(res.dir).toBe(fs.realpathSync(path.join(repoRoot, 'skills')));
    expect(skillsDir()).toBe(res.dir);
    expect(pack.source).toBe('bundled');
    expect(pack.root).toBe(res.dir);
  });

  it('loads every skill: at least 22, none skipped, each named after its folder', () => {
    expect(pack.skipped).toEqual([]);
    expect(pack.skills.length).toBeGreaterThanOrEqual(22);
    const names = pack.skills.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('salesforce-house-rules');
    for (const skill of pack.skills) {
      expect(skill.name, `${skill.dir} frontmatter name matches its folder`).toBe(path.basename(skill.dir));
      expect(skill.description.length).toBeGreaterThan(20);
      expect(path.dirname(skill.dir)).toBe(pack.root);
    }
  });

  it('every SKILL.md fits one read_skill call', () => {
    for (const skill of pack.skills) {
      const chars = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8').length;
      expect(chars, `${skill.name}/SKILL.md characters`).toBeLessThanOrEqual(READ_SKILL_MAX_CHARS);
      const read = served(readSkillFile(pack, skill.name));
      expect(read.truncated, `${skill.name}/SKILL.md comes back whole`).toBe(false);
    }
  });

  it('no skill reaches the 200-file cap, and no listing names an overlay patch', () => {
    for (const skill of pack.skills) {
      expect(skill.filesTruncated, `${skill.name} listing is complete`).toBeUndefined();
      expect(skill.files.length).toBeLessThan(SKILL_FILES_CAP);
      expect(skill.files.filter((f) => /overlay\.patch$/i.test(f))).toEqual([]);
      expect(skill.files).not.toContain('SKILL.md');
    }
  });

  it('the manifests whose name marks a Contrail root both say "contrail"', () => {
    for (const rel of ['.claude-plugin/plugin.json', 'server/mcpb/manifest.template.json']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as { name?: string };
      expect(manifest.name, rel).toBe('contrail');
    }
  });
});

describe('resolveSkillsDir on each shipped layout', () => {
  type Layout = { label: string; from: string[]; marker: string[] };
  const LAYOUTS: Layout[] = [
    // The Claude Code plugin: <root>/server/dist-plugin/index.mjs.
    { label: 'plugin (server/dist-plugin)', from: ['server', 'dist-plugin'], marker: ['.claude-plugin', 'plugin.json'] },
    // The .mcpb: <ext>/server/index.mjs beside <ext>/manifest.json.
    { label: 'mcpb (server)', from: ['server'], marker: ['manifest.json'] },
    // tsc output: <root>/server/dist/core/paths.js.
    { label: 'tsc (server/dist/core)', from: ['server', 'dist', 'core'], marker: ['.claude-plugin', 'plugin.json'] },
  ];

  function build(layout: Layout, markerText: string | null): { fromDir: string; skills: string } {
    const fromDir = path.join(tmp, ...layout.from);
    fs.mkdirSync(fromDir, { recursive: true });
    const skills = path.join(tmp, 'skills');
    writeSkill(skills, 'salesforce-house-rules');
    if (markerText !== null) {
      const marker = path.join(tmp, ...layout.marker);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, markerText);
    }
    return { fromDir, skills };
  }

  it.each(LAYOUTS)('$label with a Contrail marker resolves as bundled', (layout) => {
    const { fromDir, skills } = build(layout, JSON.stringify({ name: 'contrail', version: '0.0.0' }));
    const res = resolveSkillsDir(fromDir);
    expect(res.source).toBe('bundled');
    expect(res.dir).toBe(fs.realpathSync(skills));
    expect(res.looked).toContain(skills);
    expect(loadSkillPack(res).skills.map((s) => s.name)).toEqual(['salesforce-house-rules']);
  });

  it.each(LAYOUTS)('$label with no marker is absent', (layout) => {
    const { fromDir, skills } = build(layout, null);
    const res = resolveSkillsDir(fromDir);
    expect(res).toMatchObject({ dir: null, source: 'absent' });
    expect(res.looked).toHaveLength(3);
    expect(res.looked).toContain(skills);
    expect(loadSkillPack(res).source).toBe('absent');
  });

  it.each(LAYOUTS)('$label with a marker of another name is absent', (layout) => {
    const { fromDir } = build(layout, JSON.stringify({ name: 'some-other-extension' }));
    expect(resolveSkillsDir(fromDir)).toMatchObject({ dir: null, source: 'absent' });
  });

  it.each(LAYOUTS)('$label with an unparsable marker is absent', (layout) => {
    const { fromDir } = build(layout, '{ "name": "contrail", ');
    expect(resolveSkillsDir(fromDir)).toMatchObject({ dir: null, source: 'absent' });
  });

  it('a marker without the house rules is absent', () => {
    const fromDir = path.join(tmp, 'server', 'dist-plugin');
    fs.mkdirSync(fromDir, { recursive: true });
    writeSkill(path.join(tmp, 'skills'), 'some-other-skill');
    fs.mkdirSync(path.join(tmp, '.claude-plugin'));
    fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'contrail' }));
    expect(resolveSkillsDir(fromDir)).toMatchObject({ dir: null, source: 'absent' });
  });

  it('skips a nearer skills folder whose parent is not a Contrail root', () => {
    const fromDir = path.join(tmp, 'server', 'dist-plugin');
    fs.mkdirSync(fromDir, { recursive: true });
    // <t>/server/skills holds a same-named skill, but <t>/server has no marker.
    writeSkill(path.join(tmp, 'server', 'skills'), 'salesforce-house-rules');
    const skills = path.join(tmp, 'skills');
    writeSkill(skills, 'salesforce-house-rules');
    fs.mkdirSync(path.join(tmp, '.claude-plugin'));
    fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'contrail' }));
    const res = resolveSkillsDir(fromDir);
    expect(res.source).toBe('bundled');
    expect(res.dir).toBe(fs.realpathSync(skills));
  });
});

describe('CONTRAIL_SKILLS_DIR', () => {
  it('names a pack: override', () => {
    const root = path.join(tmp, 'my-skills');
    writeSkill(root, 'alpha-skill');
    process.env.CONTRAIL_SKILLS_DIR = root;
    const res = resolveSkillsDir();
    expect(res).toEqual({ dir: fs.realpathSync(root), source: 'override', looked: [root] });
    const pack = loadSkillPack(res);
    expect(pack.source).toBe('override');
    expect(pack.root).toBe(fs.realpathSync(root));
    expect(pack.skills.map((s) => s.name)).toEqual(['alpha-skill']);
  });

  it('names a missing path: override_missing with looked, never absent', () => {
    const missing = path.join(tmp, 'not-here');
    process.env.CONTRAIL_SKILLS_DIR = missing;
    const res = resolveSkillsDir();
    expect(res).toEqual({ dir: null, source: 'override_missing', looked: [missing] });
    const pack = loadSkillPack(res);
    expect(pack).toMatchObject({ root: null, source: 'override_missing', looked: [missing], skills: [] });
  });

  it('names a file, not a folder: override_missing', () => {
    const file = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(file, 'not a folder');
    process.env.CONTRAIL_SKILLS_DIR = file;
    expect(resolveSkillsDir()).toEqual({ dir: null, source: 'override_missing', looked: [file] });
  });

  it('names an empty folder: override_missing through loadSkillPack, with looked', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    process.env.CONTRAIL_SKILLS_DIR = empty;
    const pack = loadSkillPack(resolveSkillsDir());
    expect(pack).toMatchObject({ root: null, source: 'override_missing', looked: [empty], skills: [] });
  });

  it('names a folder with no valid skill: override_missing, and the folders are reported as skipped', () => {
    const root = path.join(tmp, 'broken');
    writeSkill(root, 'wrong-folder', {}, skillMd('another-name'));
    process.env.CONTRAIL_SKILLS_DIR = root;
    const pack = loadSkillPack(resolveSkillsDir());
    expect(pack.source).toBe('override_missing');
    expect(pack.skills).toEqual([]);
    expect(pack.skipped.map((s) => [path.basename(s.dir), s.reason])).toEqual([['wrong-folder', 'name_mismatch']]);
  });

  it('wins over the bundled pack', () => {
    const root = path.join(tmp, 'my-skills');
    writeSkill(root, 'alpha-skill');
    process.env.CONTRAIL_SKILLS_DIR = root;
    expect(skillsDir()).toBe(fs.realpathSync(root));
  });
});

describe('rendersDir', () => {
  it('is <data dir>/renders, created on demand', () => {
    process.env.CONTRAIL_DATA_DIR = path.join(tmp, 'data');
    const dir = rendersDir();
    expect(dir).toBe(path.join(tmp, 'data', 'renders'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe('loadSkillPack', () => {
  it('skips a folder whose frontmatter is missing or names another skill', () => {
    writeSkill(tmp, 'good-skill');
    writeSkill(tmp, 'renamed-folder', {}, skillMd('original-name'));
    writeSkill(tmp, 'no-frontmatter', {}, '# Just a heading\n\nNo fences here.\n');
    fs.mkdirSync(path.join(tmp, 'no-skill-md'));
    const pack = packAt(tmp);
    expect(pack.skills.map((s) => s.name)).toEqual(['good-skill']);
    expect(pack.skipped.map((s) => [path.basename(s.dir), s.reason])).toEqual([
      ['no-frontmatter', 'no_frontmatter'],
      ['no-skill-md', 'no_frontmatter'],
      ['renamed-folder', 'name_mismatch'],
    ]);
  });

  it('ignores folders whose name could not be a skill name, and loose files', () => {
    writeSkill(tmp, 'good-skill');
    writeSkill(tmp, 'Upper-Case');
    writeSkill(tmp, '_shared');
    writeSkill(tmp, '.hidden');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'not a skill');
    const pack = packAt(tmp);
    expect(pack.skills.map((s) => s.name)).toEqual(['good-skill']);
    expect(pack.skipped).toEqual([]);
  });

  it('sorts skills by code point', () => {
    for (const name of ['b-skill', 'a-skill', 'a-skill-2', '0-skill']) writeSkill(tmp, name);
    expect(packAt(tmp).skills.map((s) => s.name)).toEqual(['0-skill', 'a-skill', 'a-skill-2', 'b-skill']);
  });

  it('does not list a junction or symlink to a skill folder', (ctx) => {
    const root = path.join(tmp, 'pack');
    writeSkill(root, 'real-skill');
    const elsewhere = path.join(tmp, 'elsewhere');
    writeSkill(elsewhere, 'linked-skill');
    if (!tryLink(path.join(elsewhere, 'linked-skill'), path.join(root, 'linked-skill'), 'junction')) {
      ctx.skip();
      return;
    }
    // The link works as a folder; the loader still does not list it.
    expect(fs.existsSync(path.join(root, 'linked-skill', 'SKILL.md'))).toBe(true);
    const pack = packAt(root);
    expect(pack.skills.map((s) => s.name)).toEqual(['real-skill']);
    expect(pack.skipped).toEqual([]);
  });

  it('lists a skill\'s files sorted, with forward slashes, without SKILL.md, overlay patches or dotfiles', () => {
    writeSkill(tmp, 'file-skill', {
      'SKILL.overlay.patch': 'diff',
      'assets/skill.overlay.patch': 'diff',
      '.hidden': 'x',
      'assets/.DS_Store': 'x',
      '.git/config': 'x',
      'references/guide.md': 'guide',
      'assets/template.html': '<p>template</p>',
      'assets/nested/deep.txt': 'deep',
      'a.md': 'a',
      'assets/has space.md': 'cannot be asked for',
    });
    const [skill] = packAt(tmp).skills;
    expect(skill!.files).toEqual([
      'a.md',
      'assets/nested/deep.txt',
      'assets/template.html',
      'references/guide.md',
    ]);
    expect(skill!.filesTruncated).toBeUndefined();
  });

  it('cuts a listing at 200 files and says so', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`refs/f${String(i).padStart(3, '0')}.md`] = `file ${i}`;
    writeSkill(tmp, 'huge-skill', files);
    const [skill] = packAt(tmp).skills;
    expect(skill!.files).toHaveLength(200);
    expect(skill!.filesTruncated).toBe(true);
    expect(skill!.files[0]).toBe('refs/f000.md');
    expect(skill!.files).not.toContain('refs/f200.md');
  });

  it('never throws: an unreadable root is an empty pack, absent or override_missing by resolution', () => {
    const missing = path.join(tmp, 'gone');
    expect(loadSkillPack({ dir: missing, source: 'bundled', looked: [missing] })).toEqual({
      root: null,
      source: 'absent',
      looked: [missing],
      skills: [],
      skipped: [],
    });
    expect(loadSkillPack({ dir: missing, source: 'override', looked: [missing] }).source).toBe('override_missing');
    expect(loadSkillPack({ dir: null, source: 'absent', looked: [] }).source).toBe('absent');
  });
});

describe('findSkill and readSkillFile: names', () => {
  let pack: SkillPack;
  let houseRulesDir: string;

  beforeEach(() => {
    houseRulesDir = writeSkill(tmp, 'salesforce-house-rules');
    writeSkill(tmp, 'flow-skill', { 'assets/template.html': '<p>t</p>', 'notes.md': 'notes' });
    pack = packAt(tmp);
  });

  it('serves SKILL.md by default, under a header that names the file, its size, the engine and the folder', () => {
    const read = served(readSkillFile(pack, 'salesforce-house-rules'));
    const md = skillMd('salesforce-house-rules');
    expect(read.file).toBe('SKILL.md');
    expect(read.skill).toBe('salesforce-house-rules');
    expect(read.content).toBe(md);
    expect(read.path).toBe(path.join(houseRulesDir, 'SKILL.md'));
    expect(read.truncated).toBe(false);
    expect(read.nextOffset).toBeNull();
    // No other files: no file trailer, no truncation trailer.
    expect(read.text).toBe(
      `[Contrail skill "salesforce-house-rules" - SKILL.md - ${Buffer.byteLength(md)} bytes - ` +
        `engine ${ENGINE_VERSION} - folder ${houseRulesDir}]\n\n${md}`,
    );
  });

  it('adds the file trailer to SKILL.md when the skill carries other files, and only to SKILL.md', () => {
    const md = served(readSkillFile(pack, 'flow-skill'));
    expect(md.text.endsWith(
      '\n\n[Other files in this skill - read one with read_skill ' +
        '{"name":"flow-skill","file":"<path>"}: assets/template.html, notes.md]',
    )).toBe(true);
    const asset = served(readSkillFile(pack, 'flow-skill', 'assets/template.html'));
    expect(asset.content).toBe('<p>t</p>');
    expect(asset.text).not.toContain('Other files in this skill');
    expect(asset.text.startsWith('[Contrail skill "flow-skill" - assets/template.html - 8 bytes - ')).toBe(true);
  });

  it.each([
    'SALESFORCE-HOUSE-RULES',
    '  salesforce-house-rules  ',
    'contrail:salesforce-house-rules',
    'anthropic-skills:salesforce-house-rules',
    'Contrail:Salesforce-House-Rules',
  ])('resolves %j to the bundled copy', (given) => {
    expect(findSkill(pack, given)?.name).toBe('salesforce-house-rules');
    expect(served(readSkillFile(pack, given)).skill).toBe('salesforce-house-rules');
  });

  it('strips one namespace prefix only: a:b:salesforce-house-rules is unknown', () => {
    expect(findSkill(pack, 'a:b:salesforce-house-rules')).toBeNull();
    const { refusal, message } = refusalOf(readSkillFile(pack, 'a:b:salesforce-house-rules'));
    expect(refusal).toBe('unknown_skill');
    expect(message).toBe(
      'No bundled skill named "a:b:salesforce-house-rules". Bundled skills: flow-skill, salesforce-house-rules.',
    );
  });

  it('an unknown name lists the bundled names and echoes the name as given', () => {
    const { refusal, message } = refusalOf(readSkillFile(pack, '  Flow-Skil '));
    expect(refusal).toBe('unknown_skill');
    expect(message).toBe('No bundled skill named "  Flow-Skil ". Bundled skills: flow-skill, salesforce-house-rules.');
  });

  it('a pack with nothing to serve refuses with the text for its source', () => {
    const absent = loadSkillPack({ dir: null, source: 'absent', looked: [] });
    expect(refusalOf(readSkillFile(absent, 'salesforce-house-rules'))).toEqual({
      refusal: 'no_pack',
      message: SKILLS_ABSENT_NOTE,
    });
    const overrideMissing = loadSkillPack({ dir: null, source: 'override_missing', looked: [] });
    expect(refusalOf(readSkillFile(overrideMissing, 'salesforce-house-rules'))).toEqual({
      refusal: 'no_pack',
      message: SKILLS_OVERRIDE_MISSING_NOTE,
    });
    expect(SKILLS_ABSENT_NOTE).toBe(
      "This Contrail install has no bundled skills folder. Contrail's other tools work normally. " +
        'Reinstalling Contrail from its release restores the skills; CONTRAIL_SKILLS_DIR can point at a skills folder explicitly.',
    );
    expect(SKILLS_OVERRIDE_MISSING_NOTE).toBe(
      'CONTRAIL_SKILLS_DIR is set, but the folder it names is missing or holds no valid skill, so there are no ' +
        "skills to serve. Contrail's other tools work normally. Correct or unset CONTRAIL_SKILLS_DIR.",
    );
    expect(SKILLS_OVERRIDE_MISSING_NOTE.toLowerCase()).not.toContain('reinstall');
  });
});

describe('readSkillFile: containment', () => {
  let root: string;
  let skillDir: string;
  let pack: SkillPack;

  beforeEach(() => {
    root = path.join(tmp, 'pack');
    skillDir = writeSkill(root, 'guarded-skill', {
      'assets/a.md': 'listed file',
      'SKILL.overlay.patch': 'diff --git',
      'assets/blob.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
      'assets/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      // Valid UTF-8 with a NUL in it: the decode passes, only the NUL rule refuses.
      'assets/nul.txt': Buffer.from('abc\0def'),
    });
    // Something to reach for outside the skill's folder.
    fs.writeFileSync(path.join(tmp, 'outside.md'), 'outside the pack');
    pack = packAt(root);
  });

  it.each([
    ['../x'],
    ['a/../../x'],
    ['../../outside.md'],
    ['/etc/passwd'],
    ['C:\\x'],
    ['C:/x'],
    ['assets\\a.md'],
    ['assets/a.md\0.html'],
    ['assets//a.md'],
    ['assets/a.md/'],
    [''],
    ['./assets/a.md'],
    ['assets/.hidden'],
    ['assets/has space.md'],
  ])('refuses %j as a bad path without touching the disk', (file) => {
    const calls = watchDisk();
    const read = readSkillFile(pack, 'guarded-skill', file);
    expect(calls()).toBe(0);
    expect(read).toEqual({
      ok: false,
      refusal: 'bad_path',
      message: `file must be a relative path inside the skill's folder, with forward slashes and no ".." (got "${file}").`,
      skill: 'guarded-skill',
      file,
    });
  });

  it.each(['SKILL.overlay.patch', 'skill.overlay.patch', 'SKILL.OVERLAY.PATCH', 'assets/Skill.Overlay.Patch'])(
    'refuses %s on every platform, without reading it',
    (file) => {
      const calls = watchDisk();
      const { refusal, message } = refusalOf(readSkillFile(pack, 'guarded-skill', file));
      expect(calls()).toBe(0);
      expect(refusal).toBe('overlay_patch');
      expect(message).toBe(
        'SKILL.overlay.patch is repository bookkeeping, not part of the skill; read_skill does not serve it.',
      );
    },
  );

  it('serves only what the listing names: a file added after the pack was loaded is refused', () => {
    fs.writeFileSync(path.join(skillDir, 'assets', 'late.md'), 'added later');
    const calls = watchDisk();
    const { refusal, message } = refusalOf(readSkillFile(pack, 'guarded-skill', 'assets/late.md'));
    expect(calls()).toBe(0);
    expect(refusal).toBe('no_such_file');
    expect(message).toBe(
      'Skill "guarded-skill" has no file "assets/late.md". Its files: SKILL.md, assets/a.md, assets/blob.bin, assets/latin1.txt, assets/nul.txt.',
    );
  });

  it.each(['skill.md', 'Skill.md', 'assets/A.md', 'assets'])(
    'refuses %s: the match against the listing is exact and case-sensitive',
    (file) => {
      const calls = watchDisk();
      expect(refusalOf(readSkillFile(pack, 'guarded-skill', file)).refusal).toBe('no_such_file');
      expect(calls()).toBe(0);
    },
  );

  it('a file under a linked subfolder is not listed, and asking for it reads nothing', (ctx) => {
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'inner.md'), 'reached through a link');
    if (!tryLink(elsewhere, path.join(skillDir, 'linked'), 'junction')) {
      ctx.skip();
      return;
    }
    expect(fs.readFileSync(path.join(skillDir, 'linked', 'inner.md'), 'utf8')).toBe('reached through a link');
    const reloaded = packAt(root);
    expect(reloaded.skills[0]!.files).toEqual([
      'assets/a.md',
      'assets/blob.bin',
      'assets/latin1.txt',
      'assets/nul.txt',
    ]);
    const calls = watchDisk();
    expect(refusalOf(readSkillFile(reloaded, 'guarded-skill', 'linked/inner.md')).refusal).toBe('no_such_file');
    expect(calls()).toBe(0);
  });

  it('a symlinked file is not listed, and asking for it reads nothing', (ctx) => {
    if (!tryLink(path.join(tmp, 'outside.md'), path.join(skillDir, 'assets', 'link.md'), 'file')) {
      ctx.skip();
      return;
    }
    const reloaded = packAt(root);
    expect(reloaded.skills[0]!.files).not.toContain('assets/link.md');
    const calls = watchDisk();
    expect(refusalOf(readSkillFile(reloaded, 'guarded-skill', 'assets/link.md')).refusal).toBe('no_such_file');
    expect(calls()).toBe(0);
  });

  it('a listed file replaced by a link after the pack was loaded is refused as a link', (ctx) => {
    const listed = path.join(skillDir, 'assets', 'a.md');
    fs.rmSync(listed);
    if (!tryLink(path.join(tmp, 'outside.md'), listed, 'file')) {
      ctx.skip();
      return;
    }
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    expect(refusalOf(read.result)).toEqual({
      refusal: 'link_or_escape',
      message:
        '"assets/a.md" in skill "guarded-skill" is a link or resolves outside the skill\'s folder; read_skill does not follow links.',
    });
  });

  it('a listed file whose own name becomes a junction is refused as a link', (ctx) => {
    // The same check as the case above, with the one kind of link Windows
    // lets an unprivileged account make.
    const listed = path.join(skillDir, 'assets', 'a.md');
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(listed);
    if (!tryLink(elsewhere, listed, 'junction')) {
      ctx.skip();
      return;
    }
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    expect(refusalOf(read.result).refusal).toBe('link_or_escape');
  });

  it('a listed file whose parent folder is replaced by a junction is refused as a link', (ctx) => {
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'a.md'), 'not the listed file');
    fs.rmSync(path.join(skillDir, 'assets'), { recursive: true });
    if (!tryLink(elsewhere, path.join(skillDir, 'assets'), 'junction')) {
      ctx.skip();
      return;
    }
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    expect(refusalOf(read.result).refusal).toBe('link_or_escape');
  });

  it('a parent folder replaced by a junction to another folder of the same skill is refused as a link', (ctx) => {
    // This link never leaves the skill's folder, so the real-path check
    // passes it: the walk is the only thing that refuses it.
    const sibling = path.join(skillDir, 'references');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'a.md'), 'another folder of the same skill');
    fs.rmSync(path.join(skillDir, 'assets'), { recursive: true });
    if (!tryLink(sibling, path.join(skillDir, 'assets'), 'junction')) {
      ctx.skip();
      return;
    }
    const linked = path.join(skillDir, 'assets', 'a.md');
    expect(fs.readFileSync(linked, 'utf8')).toBe('another folder of the same skill');
    expect(path.relative(fs.realpathSync(skillDir), fs.realpathSync(linked))).toBe(path.join('references', 'a.md'));
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    expect(refusalOf(read.result)).toEqual({
      refusal: 'link_or_escape',
      message:
        '"assets/a.md" in skill "guarded-skill" is a link or resolves outside the skill\'s folder; read_skill does not follow links.',
    });
  });

  it('a skill folder replaced by a junction resolves outside the pack and is refused', (ctx) => {
    const elsewhere = path.join(tmp, 'elsewhere');
    writeSkill(elsewhere, 'guarded-skill', { 'assets/a.md': 'another folder entirely' });
    fs.rmSync(skillDir, { recursive: true });
    if (!tryLink(path.join(elsewhere, 'guarded-skill'), skillDir, 'junction')) {
      ctx.skip();
      return;
    }
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    expect(refusalOf(read.result).refusal).toBe('link_or_escape');
    expect(refusalOf(readSkillFile(pack, 'guarded-skill')).refusal).toBe('link_or_escape');
  });

  it('a listed file that has since been deleted is reported as missing', () => {
    fs.rmSync(path.join(skillDir, 'assets', 'a.md'));
    expect(refusalOf(readSkillFile(pack, 'guarded-skill', 'assets/a.md')).refusal).toBe('no_such_file');
  });

  it('refuses a binary file, naming its size and where it is', () => {
    const { refusal, message } = refusalOf(readSkillFile(pack, 'guarded-skill', 'assets/blob.bin'));
    expect(refusal).toBe('not_text');
    expect(message).toBe(
      `"assets/blob.bin" in skill "guarded-skill" is not a text file read_skill can serve (8 bytes). ` +
        `It is on disk at ${path.join(skillDir, 'assets', 'blob.bin')}, as this server sees that path.`,
    );
  });

  it('refuses a file that is not valid UTF-8', () => {
    expect(refusalOf(readSkillFile(pack, 'guarded-skill', 'assets/latin1.txt')).refusal).toBe('not_text');
  });

  it('refuses valid UTF-8 that holds a NUL', () => {
    // A NUL is valid UTF-8, so the strict decode would let this file through.
    expect(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from('abc\0def'))).toBe('abc\0def');
    const { refusal, message } = refusalOf(readSkillFile(pack, 'guarded-skill', 'assets/nul.txt'));
    expect(refusal).toBe('not_text');
    expect(message).toBe(
      `"assets/nul.txt" in skill "guarded-skill" is not a text file read_skill can serve (7 bytes). ` +
        `It is on disk at ${path.join(skillDir, 'assets', 'nul.txt')}, as this server sees that path.`,
    );
  });

  it('looks for a NUL in the first 8,192 bytes only', () => {
    const withNulAt = (index: number): Buffer => {
      const buf = Buffer.alloc(8200, 0x61);
      buf[index] = 0;
      return buf;
    };
    fs.writeFileSync(path.join(skillDir, 'assets', 'nul-inside.txt'), withNulAt(8191));
    fs.writeFileSync(path.join(skillDir, 'assets', 'nul-past.txt'), withNulAt(8192));
    const reloaded = packAt(root);
    expect(refusalOf(readSkillFile(reloaded, 'guarded-skill', 'assets/nul-inside.txt')).refusal).toBe('not_text');
    expect(served(readSkillFile(reloaded, 'guarded-skill', 'assets/nul-past.txt')).total).toBe(8200);
  });

  it('refuses a file over the size limit without reading it', () => {
    const big = path.join(skillDir, 'assets', 'a.md');
    fs.writeFileSync(big, Buffer.alloc(READ_SKILL_MAX_FILE_BYTES + 1, 0x61));
    const read = spyOnRead(() => readSkillFile(pack, 'guarded-skill', 'assets/a.md'));
    expect(read.fileReads).toBe(0);
    const { refusal, message } = refusalOf(read.result);
    expect(refusal).toBe('not_text');
    expect(message).toContain(`(${READ_SKILL_MAX_FILE_BYTES + 1} bytes)`);
  });

  it('a listing cut at 200 files says so when a file is refused', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`refs/f${String(i).padStart(3, '0')}.md`] = `file ${i}`;
    writeSkill(root, 'huge-skill', files);
    const reloaded = packAt(root);
    // The 201st file exists on disk, but is not listed, so it is not served.
    expect(fs.existsSync(path.join(root, 'huge-skill', 'refs', 'f200.md'))).toBe(true);
    const { refusal, message } = refusalOf(readSkillFile(reloaded, 'huge-skill', 'refs/f200.md'));
    expect(refusal).toBe('no_such_file');
    expect(message.startsWith('Skill "huge-skill" has no file "refs/f200.md". Its files: SKILL.md, refs/f000.md, ')).toBe(true);
    expect(message.endsWith('refs/f199.md. Only the first 200 files of this skill are listed and served.')).toBe(true);
    expect(served(readSkillFile(reloaded, 'huge-skill', 'refs/f199.md')).content).toBe('file 199');
  });
});

/** Run a read and count the file-content reads it made (the walk's lstat calls are expected). */
function spyOnRead(run: () => SkillRead): { result: SkillRead; fileReads: number } {
  const readFile = vi.spyOn(fs, 'readFileSync');
  const open = vi.spyOn(fs, 'openSync');
  const result = run();
  const fileReads = readFile.mock.calls.length + open.mock.calls.length;
  readFile.mockRestore();
  open.mockRestore();
  return { result, fileReads };
}

describe('readSkillFile: paging', () => {
  /** 100,000 characters of numbered lines, so a misplaced part shows. */
  function longText(): string {
    let text = '';
    for (let i = 0; text.length < 100_000; i++) text += `line ${i} of a long reference file\n`;
    return text.slice(0, 100_000);
  }

  it('returns 40,000 characters of a 100,000-character file, with the trailer', () => {
    const whole = longText();
    const dir = writeSkill(tmp, 'long-skill', { 'assets/big.md': whole });
    const pack = packAt(tmp);
    const read = served(readSkillFile(pack, 'long-skill', 'assets/big.md'));
    expect(read.content).toBe(whole.slice(0, 40_000));
    expect(read).toMatchObject({ total: 100_000, from: 0, to: 40_000, truncated: true, nextOffset: 40_000 });
    const abs = path.join(dir, 'assets', 'big.md');
    expect(read.text).toBe(
      `[Contrail skill "long-skill" - assets/big.md - 100000 bytes - engine ${ENGINE_VERSION} - folder ${dir}]\n\n` +
        `${whole.slice(0, 40_000)}\n\n` +
        '[truncated: characters 0-40000 of 100000 shown. Continue with read_skill ' +
        '{"name":"long-skill","file":"assets/big.md","offset":40000}. ' +
        `The whole file is on disk at ${abs}, as this server sees that path.]`,
    );
  });

  it('following the offset three times reassembles the file exactly', () => {
    const whole = longText();
    writeSkill(tmp, 'long-skill', { 'assets/big.md': whole });
    const pack = packAt(tmp);
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const read: Extract<SkillRead, { ok: true }> = served(readSkillFile(pack, 'long-skill', 'assets/big.md', offset));
      expect(read.from).toBe(offset);
      // The offset the trailer names is the one the result carries.
      if (read.truncated) expect(read.text).toContain(`"offset":${read.nextOffset}}`);
      else expect(read.text).not.toContain('[truncated:');
      parts.push(read.content);
      offset = read.nextOffset;
    }
    expect(parts.map((p) => p.length)).toEqual([40_000, 40_000, 20_000]);
    expect(parts.join('')).toBe(whole);
  });

  it('a long SKILL.md continues the same way, naming SKILL.md as the file', () => {
    const md = `${skillMd('long-skill')}${'x'.repeat(50_000)}`;
    writeSkill(tmp, 'long-skill', {}, md);
    const pack = packAt(tmp);
    const first = served(readSkillFile(pack, 'long-skill'));
    expect(first.text).toContain('Continue with read_skill {"name":"long-skill","file":"SKILL.md","offset":40000}.');
    const rest = served(readSkillFile(pack, 'long-skill', 'SKILL.md', first.nextOffset!));
    expect(first.content + rest.content).toBe(md);
  });

  it('shortens a cut that would split a surrogate pair', () => {
    // The pair sits at characters 39,999 and 40,000: a cut at 40,000 would split it.
    const whole = `${'a'.repeat(39_999)}\u{1F600}${'b'.repeat(500)}`;
    writeSkill(tmp, 'emoji-skill', { 'assets/e.md': whole });
    const pack = packAt(tmp);
    const first = served(readSkillFile(pack, 'emoji-skill', 'assets/e.md'));
    expect(first.to).toBe(39_999);
    expect(first.content).toBe('a'.repeat(39_999));
    expect(first.nextOffset).toBe(39_999);
    const second = served(readSkillFile(pack, 'emoji-skill', 'assets/e.md', first.nextOffset!));
    expect(second.content).toBe(`\u{1F600}${'b'.repeat(500)}`);
    expect(first.content + second.content).toBe(whole);
  });

  it('an offset past the end is refused; the end itself is an empty part', () => {
    const whole = longText();
    writeSkill(tmp, 'long-skill', { 'assets/big.md': whole });
    const pack = packAt(tmp);
    expect(refusalOf(readSkillFile(pack, 'long-skill', 'assets/big.md', 100_001))).toEqual({
      refusal: 'offset_past_end',
      message: 'offset 100001 is past the end of "assets/big.md" (100000 characters).',
    });
    const atEnd = served(readSkillFile(pack, 'long-skill', 'assets/big.md', 100_000));
    expect(atEnd.content).toBe('');
    expect(atEnd.truncated).toBe(false);
  });
});

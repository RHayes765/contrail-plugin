import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { TOOL_GRANT_MAP } from '../core/grants.js';
import { resolveSkillsDir } from '../core/paths.js';
import { RC_HOOKED_TOOLS, RemoteControlProbe } from '../core/remoteControl.js';
import type { AuditEvent } from '../core/types.js';
import { ENGINE_VERSION } from '../core/version.js';
import { createDeps, createServer } from '../server.js';
import { SnapshotStore } from '../snapshot/store.js';
import { buildServerInstructions } from '../skillpack/instructions.js';
import { loadSkillPack, parseSkillFrontmatter, type SkillPack } from '../skillpack/pack.js';
import type { ToolDeps } from '../tools/register.js';
import { skillsListing } from '../tools/skills.js';

/**
 * list_skills and read_skill, through a real server over the in-memory
 * transport: what the two tools say about themselves, what they return for
 * each state of the pack, which refusals are tool errors, and which of those
 * leave an audit row. The path rules themselves (readSkillFile) are pinned in
 * skillpack.test.ts; this file is about the tools around them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// The suite reads the repo's own pack unless a case points elsewhere.
delete process.env.CONTRAIL_SKILLS_DIR;

const LIST_SKILLS_DESCRIPTION =
  "List the skills bundled with this Contrail install: each skill's name, its full trigger description, " +
  'and the extra files it carries (templates, references, examples), plus the folder they live in. ' +
  "Zero-cost local read - no org, no grant. Skills are Contrail's own instructions for doing Salesforce " +
  'work well through these tools: the house rules, metadata authoring, Apex, permission sets, flows, ' +
  'reports, Agentforce, data loads. Load one with read_skill before working in its domain.';

const READ_SKILL_DESCRIPTION =
  "Load one of Contrail's bundled skills by name and follow it. Returns the skill's SKILL.md (its " +
  'instructions), or - with file - one of its other text files (a template, reference or example it tells ' +
  "you to use). The copy served is read from this Contrail install's own skills folder (or, when " +
  'CONTRAIL_SKILLS_DIR is set, the folder it names), so prefer it over ' +
  'a same-named skill installed any other way (for example uploaded to a Claude account), which may be ' +
  'older than this engine. Load "salesforce-house-rules" before your first Contrail tool call in a ' +
  'session. Zero-cost local read - no org, no grant. A long file comes back in parts: the result says ' +
  'exactly which characters it holds and the offset to continue from.';

const LIST_NOTE = 'Load a skill with read_skill {name}. Read one of its files with read_skill {name, file}.';

const ABSENT_NOTE =
  "This Contrail install has no bundled skills folder. Contrail's other tools work normally. Reinstalling " +
  'Contrail from its release restores the skills; CONTRAIL_SKILLS_DIR can point at a skills folder explicitly.';

const OVERRIDE_MISSING_NOTE =
  'CONTRAIL_SKILLS_DIR is set, but the folder it names is missing or holds no valid skill, so there are no ' +
  "skills to serve. Contrail's other tools work normally. Correct or unset CONTRAIL_SKILLS_DIR.";

let tmp: string;
let db: ContrailDb;
let clients: Client[];

beforeEach(() => {
  // realpath: the loader hands back real paths, and a temp dir can sit behind
  // a link (macOS /var).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-skilltools-')));
  process.env.CONTRAIL_DATA_DIR = path.join(tmp, 'data');
  db = new ContrailDb(path.join(tmp, 'test.db'));
  clients = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients) await client.close();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  delete process.env.CONTRAIL_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(): ToolDeps {
  return createDeps({
    db,
    tokens: new MemoryTokenStore(),
    config: { ...DEFAULT_CONFIG },
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    // Marker dir and Claude settings file inside the sandbox: list_connections
    // reads both, and the suite stays out of the real home folder.
    remoteControl: new RemoteControlProbe({
      root: path.join(tmp, 'data'),
      claudeSettingsFile: path.join(tmp, 'claude-settings.json'),
    }),
    // Stubbed externals — no real browser or Salesforce in tests.
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised in skill tool tests');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised in skill tool tests');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => {},
    },
  });
}

/**
 * A real server over the in-memory transport. CONTRAIL_SKILLS_DIR is read when
 * the deps are built; `adjust` runs before the server is created, for the one
 * state no environment variable produces (an install with no skills folder).
 */
async function connect(adjust?: (deps: ToolDeps) => void): Promise<{ client: Client; deps: ToolDeps }> {
  const deps = makeDeps();
  adjust?.(deps);
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, deps };
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallResult): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function blocksOf(result: CallResult): Array<{ type: string; text?: string }> {
  return result.content as Array<{ type: string; text?: string }>;
}

async function listSkills(client: Client): Promise<{ result: CallResult; listing: Record<string, unknown> }> {
  const result = await client.callTool({ name: 'list_skills', arguments: {} });
  return { result, listing: JSON.parse(textOf(result)) as Record<string, unknown> };
}

async function readSkill(client: Client, args: Record<string, unknown>): Promise<CallResult> {
  return client.callTool({ name: 'read_skill', arguments: args });
}

function auditRows(): AuditEvent[] {
  return db.queryAuditEvents({});
}

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

/** The pack of an install with no skills folder: skills beside the code, but nothing that says Contrail. */
function absentPack(): SkillPack {
  const fromDir = path.join(tmp, 'install', 'server');
  fs.mkdirSync(fromDir, { recursive: true });
  writeSkill(path.join(tmp, 'install', 'skills'), 'salesforce-house-rules');
  const pack = loadSkillPack(resolveSkillsDir(fromDir));
  expect(pack.source).toBe('absent');
  return pack;
}

function useAbsentPack(deps: ToolDeps): void {
  const pack = absentPack();
  deps.skills = { pack, instructions: buildServerInstructions(pack, ENGINE_VERSION) };
}

/** The pack most read_skill cases use, named by CONTRAIL_SKILLS_DIR. */
function writeGuardedPack(): { root: string; skillDir: string } {
  const root = path.join(tmp, 'pack');
  writeSkill(root, 'salesforce-house-rules');
  const skillDir = writeSkill(root, 'guarded-skill', {
    'assets/a.md': 'listed file',
    'assets/blob.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
    'SKILL.overlay.patch': 'diff --git',
  });
  // Something to reach for outside the skill's folder.
  fs.writeFileSync(path.join(tmp, 'outside.md'), 'outside the pack');
  process.env.CONTRAIL_SKILLS_DIR = root;
  return { root, skillDir };
}

describe('list_skills and read_skill: the tool surface', () => {
  it('are listed with their titles and descriptions, verbatim', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === 'list_skills');
    const read = tools.find((t) => t.name === 'read_skill');
    expect(list?.title).toBe('List the skills bundled with Contrail');
    expect(list?.description).toBe(LIST_SKILLS_DESCRIPTION);
    expect(read?.title).toBe('Read a bundled Contrail skill');
    expect(read?.description).toBe(READ_SKILL_DESCRIPTION);
    // Registered together, after every tool that existed before them, so the
    // earlier tools/list order is unchanged.
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe('connect_org');
    expect(names.indexOf('list_skills')).toBeGreaterThan(names.indexOf('open_settings'));
    expect(names.indexOf('read_skill')).toBe(names.indexOf('list_skills') + 1);
  });

  it('list_skills takes nothing; read_skill takes a name, an optional file and an optional offset', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === 'list_skills')!;
    const read = tools.find((t) => t.name === 'read_skill')!;
    expect(list.inputSchema.type).toBe('object');
    expect(Object.keys(list.inputSchema.properties ?? {})).toEqual([]);
    expect(Object.keys(read.inputSchema.properties ?? {})).toEqual(['name', 'file', 'offset']);
    expect(read.inputSchema.required).toEqual(['name']);
    expect(read.inputSchema.properties).toMatchObject({
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Skill name as listed in the server instructions or by list_skills (case-insensitive; a leading ' +
          'namespace prefix such as "contrail:" is ignored).',
      },
      file: {
        type: 'string',
        maxLength: 300,
        description:
          "A file inside the skill's folder, as a relative path with forward slashes (for example " +
          '"assets/flow-diff-template.html"). Omit for SKILL.md. Text files only.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Character offset to continue a truncated read from.',
      },
    });
  });

  it('need no connection and no grant, and a served read leaves no audit row', async () => {
    expect(TOOL_GRANT_MAP).toHaveProperty('list_skills', null);
    expect(TOOL_GRANT_MAP).toHaveProperty('read_skill', null);
    const { client } = await connect();
    expect(db.listConnections()).toEqual([]);
    const { result } = await listSkills(client);
    expect(result.isError).toBeFalsy();
    const read = await readSkill(client, { name: 'salesforce-house-rules' });
    expect(read.isError).toBeFalsy();
    expect(auditRows()).toEqual([]);
  });

  it('are not sampled for Remote Control: neither tool mints a code', async () => {
    expect(RC_HOOKED_TOOLS).not.toContain('list_skills');
    expect(RC_HOOKED_TOOLS).not.toContain('read_skill');
    const { client, deps } = await connect();
    const run = vi.spyOn(deps.remoteControl, 'run');
    await listSkills(client);
    await readSkill(client, { name: 'salesforce-house-rules' });
    expect(run).not.toHaveBeenCalled();
    // The spy does see a wrapped tool.
    await client.callTool({ name: 'list_connections', arguments: {} });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('list_skills', () => {
  it('lists the pack this repository ships', async () => {
    const { client, deps } = await connect();
    const { result, listing } = await listSkills(client);
    expect(result.isError).toBeFalsy();
    expect(Object.keys(listing)).toEqual([
      'engine_version',
      'source',
      'skills_dir',
      'count',
      'skills',
      'skipped',
      'note',
    ]);
    const skillsDir = fs.realpathSync(path.join(repoRoot, 'skills'));
    expect(listing).toMatchObject({
      engine_version: ENGINE_VERSION,
      source: 'bundled',
      skills_dir: skillsDir,
      skipped: [],
      note: LIST_NOTE,
    });
    const skills = listing.skills as Array<{ name: string; description: string; files: string[] }>;
    expect(listing.count).toBe(skills.length);
    expect(skills.length).toBeGreaterThanOrEqual(22);
    expect(skills).toEqual(
      deps.skills.pack.skills.map((s) => ({ name: s.name, description: s.description, files: s.files })),
    );
    const names = skills.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('salesforce-house-rules');
    for (const skill of skills) {
      // Exactly three keys: nothing in the shipped pack reaches the file cap.
      expect(Object.keys(skill), skill.name).toEqual(['name', 'description', 'files']);
      // The FULL trigger description, as the skill's own frontmatter gives it.
      const md = fs.readFileSync(path.join(skillsDir, skill.name, 'SKILL.md'), 'utf8');
      expect(skill.description, skill.name).toBe(parseSkillFrontmatter(md)?.description);
      for (const file of skill.files) {
        expect(file, skill.name).not.toMatch(/\\|(^|\/)skill\.overlay\.patch$|^SKILL\.md$/i);
        expect(fs.statSync(path.join(skillsDir, skill.name, ...file.split('/'))).isFile(), file).toBe(true);
      }
    }
    expect(skills.find((s) => s.name === 'salesforce-flow-visualize')?.files).toContain(
      'assets/flow-diff-template.html',
    );
  });

  it('lists a pack named by CONTRAIL_SKILLS_DIR, with the folders it skipped and why', async () => {
    const root = path.join(tmp, 'mine');
    writeSkill(root, 'salesforce-house-rules');
    writeSkill(root, 'flow-skill', {
      'notes.md': 'notes',
      'assets/template.html': '<p>t</p>',
      'SKILL.overlay.patch': 'diff --git',
      '.hidden': 'dotfile',
    });
    writeSkill(root, 'wrong-name', {}, skillMd('another-name'));
    writeSkill(root, 'no-frontmatter', {}, '# No frontmatter here\n');
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client } = await connect();
    const { listing } = await listSkills(client);
    expect(listing).toEqual({
      engine_version: ENGINE_VERSION,
      source: 'override',
      skills_dir: root,
      count: 2,
      skills: [
        {
          name: 'flow-skill',
          description: 'Does flow-skill things for the test suite.',
          files: ['assets/template.html', 'notes.md'],
        },
        {
          name: 'salesforce-house-rules',
          description: 'Does salesforce-house-rules things for the test suite.',
          files: [],
        },
      ],
      skipped: [
        { dir: path.join(root, 'no-frontmatter'), reason: 'no_frontmatter' },
        { dir: path.join(root, 'wrong-name'), reason: 'name_mismatch' },
      ],
      note: LIST_NOTE,
    });
  });

  it('says so when a listing was cut at the 200-file cap', async () => {
    const root = path.join(tmp, 'capped');
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`refs/f${String(i).padStart(3, '0')}.md`] = `file ${i}`;
    writeSkill(root, 'huge-skill', files);
    writeSkill(root, 'small-skill', { 'notes.md': 'notes' });
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client } = await connect();
    const { listing } = await listSkills(client);
    const skills = listing.skills as Array<{ name: string; files: string[]; files_truncated?: boolean }>;
    const huge = skills.find((s) => s.name === 'huge-skill')!;
    expect(huge.files).toHaveLength(200);
    expect(huge.files_truncated).toBe(true);
    // Only a cut listing carries the flag.
    expect(skills.find((s) => s.name === 'small-skill')).toEqual({
      name: 'small-skill',
      description: 'Does small-skill things for the test suite.',
      files: ['notes.md'],
    });
  });

  it('an install with no skills folder is an answer, not an error', async () => {
    const { client, deps } = await connect(useAbsentPack);
    const { result, listing } = await listSkills(client);
    expect(result.isError).toBeFalsy();
    expect(listing).toEqual({
      engine_version: ENGINE_VERSION,
      source: 'absent',
      skills_dir: null,
      count: 0,
      skills: [],
      skipped: [],
      looked: deps.skills.pack.looked,
      note: ABSENT_NOTE,
    });
    // The three places the resolver tried, nearest first.
    expect(listing.looked).toEqual([
      path.join(tmp, 'install', 'skills'),
      path.join(tmp, 'skills'),
      path.join(path.dirname(tmp), 'skills'),
    ]);
    // The same answer without a server: the result is a function of the pack.
    expect(skillsListing(deps.skills.pack)).toEqual(listing);
  });

  it.each([
    ['a missing folder', (dir: string) => dir],
    [
      'an empty folder',
      (dir: string) => {
        fs.mkdirSync(dir);
        return dir;
      },
    ],
    [
      'a file, not a folder',
      (dir: string) => {
        fs.writeFileSync(dir, 'not a folder');
        return dir;
      },
    ],
  ])('CONTRAIL_SKILLS_DIR naming %s is an answer too, and never says to reinstall', async (_label, make) => {
    const named = make(path.join(tmp, 'named-by-env'));
    process.env.CONTRAIL_SKILLS_DIR = named;
    const { client } = await connect();
    const { result, listing } = await listSkills(client);
    expect(result.isError).toBeFalsy();
    expect(listing).toEqual({
      engine_version: ENGINE_VERSION,
      source: 'override_missing',
      skills_dir: null,
      count: 0,
      skills: [],
      skipped: [],
      looked: [named],
      note: OVERRIDE_MISSING_NOTE,
    });
    expect(String(listing.note).toLowerCase()).not.toContain('reinstall');
  });

  it('CONTRAIL_SKILLS_DIR naming a folder with no valid skill reports what it found there', async () => {
    const root = path.join(tmp, 'nothing-valid');
    writeSkill(root, 'wrong-name', {}, skillMd('another-name'));
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client } = await connect();
    const { result, listing } = await listSkills(client);
    expect(result.isError).toBeFalsy();
    expect(listing).toEqual({
      engine_version: ENGINE_VERSION,
      source: 'override_missing',
      skills_dir: null,
      count: 0,
      skills: [],
      skipped: [{ dir: path.join(root, 'wrong-name'), reason: 'name_mismatch' }],
      looked: [root],
      note: OVERRIDE_MISSING_NOTE,
    });
  });

  it('answers from the pack loaded at startup: a skill added later is not listed or served', async () => {
    const { root } = writeGuardedPack();
    const { client } = await connect();
    writeSkill(root, 'late-skill');
    const { listing } = await listSkills(client);
    expect(listing.count).toBe(2);
    expect((listing.skills as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'guarded-skill',
      'salesforce-house-rules',
    ]);
    const read = await readSkill(client, { name: 'late-skill' });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toBe(
      'No bundled skill named "late-skill". Bundled skills: guarded-skill, salesforce-house-rules.',
    );
  });
});

describe('read_skill', () => {
  it('returns SKILL.md as one text block: the header, a blank line, the file verbatim', async () => {
    const { skillDir } = writeGuardedPack();
    const { client } = await connect();
    const result = await readSkill(client, { name: 'guarded-skill' });
    expect(result.isError).toBeFalsy();
    expect(blocksOf(result)).toHaveLength(1);
    const md = skillMd('guarded-skill');
    expect(textOf(result)).toBe(
      `[Contrail skill "guarded-skill" - SKILL.md - ${Buffer.byteLength(md)} bytes - engine ${ENGINE_VERSION} - ` +
        `folder ${skillDir}]\n\n${md}\n\n` +
        '[Other files in this skill - read one with read_skill {"name":"guarded-skill","file":"<path>"}: ' +
        'assets/a.md, assets/blob.bin]',
    );
  });

  it('with file, returns that file and no file trailer', async () => {
    const { skillDir } = writeGuardedPack();
    const { client } = await connect();
    const result = await readSkill(client, { name: 'guarded-skill', file: 'assets/a.md' });
    expect(result.isError).toBeFalsy();
    expect(blocksOf(result)).toHaveLength(1);
    expect(textOf(result)).toBe(
      `[Contrail skill "guarded-skill" - assets/a.md - 11 bytes - engine ${ENGINE_VERSION} - folder ${skillDir}]` +
        '\n\nlisted file',
    );
  });

  it('serves the house rules this repository ships, byte for byte', async () => {
    const { client } = await connect();
    const dir = path.join(fs.realpathSync(path.join(repoRoot, 'skills')), 'salesforce-house-rules');
    const onDisk = fs.readFileSync(path.join(dir, 'SKILL.md'));
    const result = await readSkill(client, { name: 'salesforce-house-rules' });
    expect(result.isError).toBeFalsy();
    // No trailer of either kind: the file fits one read and the skill carries nothing else.
    expect(textOf(result)).toBe(
      `[Contrail skill "salesforce-house-rules" - SKILL.md - ${onDisk.length} bytes - engine ${ENGINE_VERSION} - ` +
        `folder ${dir}]\n\n${onDisk.toString('utf8')}`,
    );
  });

  it('serves a bundled asset by the path list_skills names', async () => {
    const { client } = await connect();
    const dir = path.join(fs.realpathSync(path.join(repoRoot, 'skills')), 'salesforce-flow-visualize');
    const onDisk = fs.readFileSync(path.join(dir, 'assets', 'flow-diff-template.html'));
    const result = await readSkill(client, {
      name: 'salesforce-flow-visualize',
      file: 'assets/flow-diff-template.html',
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    const header =
      `[Contrail skill "salesforce-flow-visualize" - assets/flow-diff-template.html - ${onDisk.length} bytes - ` +
      `engine ${ENGINE_VERSION} - folder ${dir}]\n\n`;
    expect(text.startsWith(header)).toBe(true);
    expect(text.slice(header.length).startsWith(onDisk.toString('utf8').slice(0, 2000))).toBe(true);
    expect(text).not.toContain('Other files in this skill');
  });

  it.each([
    'SALESFORCE-HOUSE-RULES',
    '  salesforce-house-rules  ',
    'contrail:salesforce-house-rules',
    'anthropic-skills:salesforce-house-rules',
    'Contrail:Salesforce-House-Rules',
  ])('resolves %j to the same bundled copy', async (given) => {
    const { client } = await connect();
    const plain = await readSkill(client, { name: 'salesforce-house-rules' });
    const result = await readSkill(client, { name: given });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(textOf(plain));
    expect(textOf(result).startsWith('[Contrail skill "salesforce-house-rules" - SKILL.md - ')).toBe(true);
  });

  it('a long file comes back in parts, and each trailer is the next call as written', async () => {
    let whole = '';
    for (let i = 0; whole.length < 100_000; i++) whole += `line ${i} of a long reference file\n`;
    whole = whole.slice(0, 100_000);
    const root = path.join(tmp, 'long');
    const dir = writeSkill(root, 'long-skill', { 'assets/big.md': whole });
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client } = await connect();

    const parts: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    let args: Record<string, unknown> | null = { name: 'long-skill', file: 'assets/big.md' };
    while (args !== null && calls.length < 10) {
      calls.push(args);
      const result = await readSkill(client, args);
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      const header = `[Contrail skill "long-skill" - assets/big.md - 100000 bytes - engine ${ENGINE_VERSION} - folder ${dir}]\n\n`;
      expect(text.startsWith(header)).toBe(true);
      const body = text.slice(header.length);
      const cut = body.lastIndexOf('\n\n[truncated: ');
      if (cut < 0) {
        parts.push(body);
        args = null;
        continue;
      }
      parts.push(body.slice(0, cut));
      const trailer = body.slice(cut + 2);
      const next = /^\[truncated: characters (\d+)-(\d+) of 100000 shown\. Continue with read_skill (\{[^}]*\})\. The whole file is on disk at (.*), as this server sees that path\.\]$/.exec(
        trailer,
      );
      expect(next, trailer).not.toBeNull();
      expect(next![4]).toBe(path.join(dir, 'assets', 'big.md'));
      // The trailer's own JSON is the next call's arguments.
      args = JSON.parse(next![3]!) as Record<string, unknown>;
      expect(args.offset).toBe(Number(next![2]));
    }
    expect(calls).toEqual([
      { name: 'long-skill', file: 'assets/big.md' },
      { name: 'long-skill', file: 'assets/big.md', offset: 40_000 },
      { name: 'long-skill', file: 'assets/big.md', offset: 80_000 },
    ]);
    expect(parts.map((p) => p.length)).toEqual([40_000, 40_000, 20_000]);
    expect(parts.join('')).toBe(whole);
  });

  it('refuses, as a tool error with the refusal text and nothing else', async () => {
    const { skillDir } = writeGuardedPack();
    const { client } = await connect();
    const cases: Array<[Record<string, unknown>, string]> = [
      // U1: the name as given, and the names that do exist.
      [
        { name: '  Guarded-Skil ' },
        'No bundled skill named "  Guarded-Skil ". Bundled skills: guarded-skill, salesforce-house-rules.',
      ],
      [
        { name: 'a:b:guarded-skill' },
        'No bundled skill named "a:b:guarded-skill". Bundled skills: guarded-skill, salesforce-house-rules.',
      ],
      // U2
      [
        { name: 'guarded-skill', file: '../../outside.md' },
        'file must be a relative path inside the skill\'s folder, with forward slashes and no ".." (got "../../outside.md").',
      ],
      [
        { name: 'guarded-skill', file: '' },
        'file must be a relative path inside the skill\'s folder, with forward slashes and no ".." (got "").',
      ],
      // U3
      [
        { name: 'guarded-skill', file: 'assets/missing.md' },
        'Skill "guarded-skill" has no file "assets/missing.md". Its files: SKILL.md, assets/a.md, assets/blob.bin.',
      ],
      [
        { name: 'guarded-skill', file: 'skill.md' },
        'Skill "guarded-skill" has no file "skill.md". Its files: SKILL.md, assets/a.md, assets/blob.bin.',
      ],
      // U5, in any spelling
      [
        { name: 'guarded-skill', file: 'SKILL.overlay.patch' },
        'SKILL.overlay.patch is repository bookkeeping, not part of the skill; read_skill does not serve it.',
      ],
      [
        { name: 'guarded-skill', file: 'skill.overlay.patch' },
        'SKILL.overlay.patch is repository bookkeeping, not part of the skill; read_skill does not serve it.',
      ],
      // U6
      [
        { name: 'guarded-skill', file: 'assets/blob.bin' },
        `"assets/blob.bin" in skill "guarded-skill" is not a text file read_skill can serve (8 bytes). ` +
          `It is on disk at ${path.join(skillDir, 'assets', 'blob.bin')}, as this server sees that path.`,
      ],
      // U7
      [
        { name: 'guarded-skill', file: 'assets/a.md', offset: 12 },
        'offset 12 is past the end of "assets/a.md" (11 characters).',
      ],
    ];
    for (const [args, message] of cases) {
      const result = await readSkill(client, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(blocksOf(result), JSON.stringify(args)).toHaveLength(1);
      expect(textOf(result), JSON.stringify(args)).toBe(message);
    }
  });

  it('the end of a file is an empty part, not a refusal', async () => {
    writeGuardedPack();
    const { client } = await connect();
    const result = await readSkill(client, { name: 'guarded-skill', file: 'assets/a.md', offset: 11 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result).endsWith(']\n\n')).toBe(true);
  });

  it('with no skills folder, refuses with the note list_skills gives for that state', async () => {
    const { client } = await connect(useAbsentPack);
    const result = await readSkill(client, { name: 'salesforce-house-rules' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(ABSENT_NOTE);
    expect((await listSkills(client)).listing.note).toBe(ABSENT_NOTE);
  });

  it('with a CONTRAIL_SKILLS_DIR that holds no skill, refuses with that note instead', async () => {
    process.env.CONTRAIL_SKILLS_DIR = path.join(tmp, 'never-created');
    const { client } = await connect();
    const result = await readSkill(client, { name: 'salesforce-house-rules' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(OVERRIDE_MISSING_NOTE);
    expect((await listSkills(client)).listing.note).toBe(OVERRIDE_MISSING_NOTE);
    // Nothing to serve is not an attempt to leave a folder: not audited.
    expect(auditRows()).toEqual([]);
  });

  it('holds the schema bounds: a name of 200 characters and a file of 300 reach the handler, one more does not', async () => {
    writeGuardedPack();
    const { client } = await connect();
    const refusedByHandler = async (args: Record<string, unknown>): Promise<string> => {
      const result = await readSkill(client, args);
      expect(result.isError).toBe(true);
      return textOf(result);
    };
    /** A schema refusal, whichever way this SDK version reports it (an error result, or a thrown error). */
    const refusedBySchema = async (args: Record<string, unknown>): Promise<string> => {
      try {
        const result = await readSkill(client, args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        return textOf(result);
      } catch (err) {
        return String(err);
      }
    };
    const name200 = 'n'.repeat(200);
    expect(await refusedByHandler({ name: name200 })).toBe(
      `No bundled skill named "${name200}". Bundled skills: guarded-skill, salesforce-house-rules.`,
    );
    const file300 = `assets/${'f'.repeat(293)}`;
    expect(file300).toHaveLength(300);
    expect(await refusedByHandler({ name: 'guarded-skill', file: file300 })).toBe(
      `Skill "guarded-skill" has no file "${file300}". Its files: SKILL.md, assets/a.md, assets/blob.bin.`,
    );
    const handlerTexts = /No bundled skill named|has no file|file must be a relative path|is past the end|^\[Contrail skill/;
    for (const args of [
      {},
      { name: '' },
      { name: `${name200}n` },
      { name: 'guarded-skill', file: `${file300}f` },
      { name: 'guarded-skill', file: 'assets/a.md', offset: -1 },
      { name: 'guarded-skill', file: 'assets/a.md', offset: 1.5 },
      { name: 'guarded-skill', file: 'assets/a.md', offset: '0' },
    ]) {
      expect(await refusedBySchema(args), JSON.stringify(args)).not.toMatch(handlerTexts);
    }
    expect(auditRows()).toEqual([]);
  });
});

describe('read_skill: what is audited', () => {
  it('a path that tries to leave the skill folder writes one skill.read_refused row', async () => {
    writeGuardedPack();
    const { client } = await connect();
    const result = await readSkill(client, { name: 'Contrail:Guarded-Skill', file: '../../outside.md' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('outside the pack');
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'skill.read_refused',
      connectionId: null,
      tool: 'read_skill',
      outcome: 'refused',
      // The skill by its own name, the file as it was asked for.
      detail: { skill: 'guarded-skill', file: '../../outside.md', reason: 'bad_path' },
    });
  });

  it('every bad path is its own row, and get_audit_log shows them', async () => {
    writeGuardedPack();
    const { client } = await connect();
    const files = ['../x', 'C:\\x', '/etc/passwd', 'assets\\a.md', 'assets/a.md\0.html'];
    for (const file of files) {
      expect((await readSkill(client, { name: 'guarded-skill', file })).isError).toBe(true);
    }
    const rows = auditRows().filter((r) => r.eventType === 'skill.read_refused');
    expect(rows.map((r) => r.detail?.file).sort()).toEqual([...files].sort());
    expect(rows.every((r) => r.outcome === 'refused' && r.detail?.reason === 'bad_path')).toBe(true);
    const log = JSON.parse(textOf(await client.callTool({ name: 'get_audit_log', arguments: {} }))) as {
      events: Array<{ event_type: string; tool: string | null; outcome: string }>;
    };
    const shown = log.events.filter((e) => e.event_type === 'skill.read_refused');
    expect(shown).toHaveLength(files.length);
    expect(shown.every((e) => e.tool === 'read_skill' && e.outcome === 'refused')).toBe(true);
  });

  it('a listed file that has become a link is refused and audited as link_or_escape', async (ctx) => {
    const { skillDir } = writeGuardedPack();
    const { client } = await connect();
    // After the pack was loaded: the folder that holds the listed file is
    // replaced by a link to a folder outside the pack.
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'a.md'), 'not the listed file');
    fs.rmSync(path.join(skillDir, 'assets'), { recursive: true });
    if (!tryLink(elsewhere, path.join(skillDir, 'assets'), 'junction')) {
      ctx.skip();
      return;
    }
    const result = await readSkill(client, { name: 'guarded-skill', file: 'assets/a.md' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '"assets/a.md" in skill "guarded-skill" is a link or resolves outside the skill\'s folder; read_skill does not follow links.',
    );
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'skill.read_refused',
      connectionId: null,
      tool: 'read_skill',
      outcome: 'refused',
      detail: { skill: 'guarded-skill', file: 'assets/a.md', reason: 'link_or_escape' },
    });
  });

  it('a skill folder that has become a link is audited under SKILL.md when no file was named', async (ctx) => {
    const { skillDir } = writeGuardedPack();
    const { client } = await connect();
    const elsewhere = path.join(tmp, 'elsewhere');
    writeSkill(elsewhere, 'guarded-skill', {}, 'another folder entirely');
    fs.rmSync(skillDir, { recursive: true });
    if (!tryLink(path.join(elsewhere, 'guarded-skill'), skillDir, 'junction')) {
      ctx.skip();
      return;
    }
    const result = await readSkill(client, { name: 'guarded-skill' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '"SKILL.md" in skill "guarded-skill" is a link or resolves outside the skill\'s folder; read_skill does not follow links.',
    );
    expect(auditRows().map((r) => [r.eventType, r.detail])).toEqual([
      ['skill.read_refused', { skill: 'guarded-skill', file: 'SKILL.md', reason: 'link_or_escape' }],
    ]);
  });

  it('served reads and plain typos are not audited', async () => {
    writeGuardedPack();
    const { client } = await connect();
    const calls: Array<[Record<string, unknown>, boolean]> = [
      [{ name: 'guarded-skill' }, false],
      [{ name: 'guarded-skill', file: 'assets/a.md' }, false],
      [{ name: 'guarded-skil' }, true], // U1
      [{ name: 'guarded-skill', file: 'assets/missing.md' }, true], // U3
      [{ name: 'guarded-skill', file: 'SKILL.overlay.patch' }, true], // U5
      [{ name: 'guarded-skill', file: 'assets/blob.bin' }, true], // U6
      [{ name: 'guarded-skill', file: 'assets/a.md', offset: 500 }, true], // U7
    ];
    for (const [args, isError] of calls) {
      expect(Boolean((await readSkill(client, args)).isError), JSON.stringify(args)).toBe(isError);
    }
    await listSkills(client);
    expect(auditRows()).toEqual([]);
  });
});

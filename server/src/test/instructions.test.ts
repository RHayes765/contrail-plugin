import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { resolveSkillsDir } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';
import { createDeps, createServer } from '../server.js';
import { SnapshotStore } from '../snapshot/store.js';
import { loadSkillPack, type SkillPack } from '../skillpack/pack.js';
import {
  buildServerInstructions,
  INSTRUCTIONS_MAX_BYTES,
  skillsAnnouncement,
} from '../skillpack/instructions.js';
import type { ToolDeps } from '../tools/register.js';

/**
 * Discoverability: what a client is told about Contrail's skills before any
 * tool call — the MCP server instructions — and the second announcement on
 * list_connections. A client may cap instructions at 2 KB, so the size and
 * the fallback order are pinned here too.
 */

// The suite reads the repo's own pack unless a case points elsewhere.
delete process.env.CONTRAIL_SKILLS_DIR;

const OPENING =
  'Contrail gives Claude governed access to Salesforce orgs: metadata reads, search, diffs, queries, ' +
  'and deploys and data writes that a human approves with a code.';

const OVERRIDE_MISSING_TEXT =
  `${OPENING}\n\n` +
  'CONTRAIL_SKILLS_DIR is set, but the folder it names is missing or holds no valid skill, so read_skill ' +
  'and list_skills have nothing to serve and render_flow cannot build a page. Every other Contrail tool ' +
  'works normally. Tell the human once to correct or unset CONTRAIL_SKILLS_DIR.';

const ABSENT_TEXT =
  `${OPENING}\n\n` +
  'This install has no bundled skills folder, so read_skill and list_skills have nothing to serve and ' +
  'render_flow cannot build a page. Every other Contrail tool works normally. Tell the human once that ' +
  'reinstalling Contrail from its release restores the skills.';

let tmp: string;
let db: ContrailDb;
let clients: Client[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-instructions-')));
  process.env.CONTRAIL_DATA_DIR = path.join(tmp, 'data');
  db = new ContrailDb(path.join(tmp, 'test.db'));
  clients = [];
});

afterEach(async () => {
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
    // Stubbed externals — no real browser or Salesforce in tests.
    flowOps: {
      exchangeCode: async () => {
        throw new Error('not exercised in instructions tests');
      },
      fetchOrgInfo: async () => {
        throw new Error('not exercised in instructions tests');
      },
      fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
      revokeToken: async () => ({ ok: true }),
      openBrowser: async () => {},
    },
  });
}

/** A real server over the in-memory transport; CONTRAIL_SKILLS_DIR is read when the deps are built. */
async function connect(): Promise<{ client: Client; deps: ToolDeps }> {
  const deps = makeDeps();
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, deps };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7E\n]*$/.test(text);
}

/** Write a pack of valid skills under `root`. */
function writePack(root: string, names: string[]): void {
  for (const name of names) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "Does ${name} things for the test suite."\n---\n\n# ${name}\n`,
    );
  }
}

/** A pack that never touched the disk, for the text builder alone. */
function fakePack(names: string[], source: SkillPack['source'] = 'bundled'): SkillPack {
  return {
    root: '/nowhere/skills',
    source,
    looked: [],
    skills: names.map((name) => ({
      name,
      description: `Does ${name} things.`,
      dir: `/nowhere/skills/${name}`,
      files: [],
    })),
    skipped: [],
  };
}

describe('server instructions, from the pack this repository ships', () => {
  it('names every bundled skill on its own line', async () => {
    const { client } = await connect();
    const lines = (client.getInstructions() ?? '').split('\n');
    const pack = loadSkillPack(resolveSkillsDir());
    expect(pack.skills.length).toBeGreaterThanOrEqual(22);
    for (const skill of pack.skills) {
      expect(lines, `a "- ${skill.name}" line`).toContain(`- ${skill.name}`);
    }
    expect(lines.filter((l) => l.startsWith('- '))).toEqual(pack.skills.map((s) => `- ${s.name}`));
  });

  it('points at read_skill, list_skills, render_flow, the house rules and this engine version', async () => {
    const { client } = await connect();
    const text = client.getInstructions() ?? '';
    for (const needle of ['read_skill', 'list_skills', 'render_flow', '"salesforce-house-rules"', ENGINE_VERSION]) {
      expect(text, needle).toContain(needle);
    }
    expect(text.startsWith(`${OPENING}\n\nBefore your first Contrail tool call in a session, load the house rules:`)).toBe(true);
    expect(text).toContain(`These are the copies that came with this engine (${ENGINE_VERSION}).`);
  });

  it('is ASCII only and at most 2,000 bytes', async () => {
    const { client } = await connect();
    const text = client.getInstructions() ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(isAscii(text)).toBe(true);
    expect(INSTRUCTIONS_MAX_BYTES).toBe(2000);
    expect(bytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
  });

  it('is identical across two createDeps() calls, and is what the server sends', async () => {
    const first = makeDeps();
    const second = makeDeps();
    expect(second.skills.instructions).toBe(first.skills.instructions);
    const { client, deps } = await connect();
    expect(client.getInstructions()).toBe(deps.skills.instructions);
    expect(deps.skills.instructions).toBe(first.skills.instructions);
    // Two servers on one set of deps (the --http start) say the same thing.
    const again = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await again.connect(serverTransport);
    const other = new Client({ name: 'second-client', version: '0.0.0' });
    await other.connect(clientTransport);
    clients.push(other);
    expect(other.getInstructions()).toBe(client.getInstructions());
  });
});

describe('server instructions, verbatim', () => {
  const NAMES = ['platform-apex-generate', 'salesforce-house-rules'];

  it('the bundled text', () => {
    expect(buildServerInstructions(fakePack(NAMES), '9.8.7')).toBe(
      [
        OPENING,
        'Before your first Contrail tool call in a session, load the house rules: call read_skill with name ' +
          '"salesforce-house-rules". Skip this only if you already loaded contrail:salesforce-house-rules ' +
          "through your client's own Skill tool.",
        "Contrail's skills ship inside this install. read_skill returns one by name; list_skills returns every " +
          "skill's full description. These are the copies that came with this engine (9.8.7). If your client " +
          'lists a skill as contrail:<name> (the Claude Code plugin does), loading it that way is fine. Any ' +
          'other copy of the same name - for example one uploaded to a Claude account - may be older than this ' +
          'engine: prefer read_skill.',
        'To show a flow as a diagram, or to compare two flows or two versions of a flow side by side, call ' +
          'render_flow. Do not hand-build a flow page.',
        'Load the matching skill before you author or diagnose (the house rules say which fits what):\n' +
          '- platform-apex-generate\n' +
          '- salesforce-house-rules',
      ].join('\n\n'),
    );
  });

  it('the override text differs only in where the copies come from', () => {
    const bundled = buildServerInstructions(fakePack(NAMES), '9.8.7');
    const override = buildServerInstructions(fakePack(NAMES, 'override'), '9.8.7');
    expect(override).toBe(
      bundled.replace(
        'These are the copies that came with this engine (9.8.7).',
        'They are read from the folder named by CONTRAIL_SKILLS_DIR, which may not match this engine (9.8.7).',
      ),
    );
    expect(override).not.toBe(bundled);
  });

  it('leaves out the house-rules paragraph when the pack has no house rules', () => {
    const text = buildServerInstructions(fakePack(['platform-apex-generate']), '9.8.7');
    expect(text).not.toContain('Before your first Contrail tool call');
    expect(text.startsWith(`${OPENING}\n\nContrail's skills ship inside this install.`)).toBe(true);
    expect(text.endsWith('\n- platform-apex-generate')).toBe(true);
  });

  it('an empty pack gets the absent or the override-missing text, by source', () => {
    expect(buildServerInstructions(fakePack([], 'absent'), '9.8.7')).toBe(ABSENT_TEXT);
    expect(buildServerInstructions(fakePack([], 'bundled'), '9.8.7')).toBe(ABSENT_TEXT);
    expect(buildServerInstructions(fakePack([], 'override_missing'), '9.8.7')).toBe(OVERRIDE_MISSING_TEXT);
    expect(buildServerInstructions(fakePack([], 'override'), '9.8.7')).toBe(OVERRIDE_MISSING_TEXT);
    expect(isAscii(ABSENT_TEXT)).toBe(true);
    expect(isAscii(OVERRIDE_MISSING_TEXT)).toBe(true);
  });

  it('carries no clock and no path: the same pack and version give the same text', () => {
    const a = buildServerInstructions(fakePack(NAMES), '9.8.7');
    const b = buildServerInstructions(fakePack(NAMES), '9.8.7');
    expect(b).toBe(a);
    expect(a).not.toContain('/nowhere');
  });
});

describe('server instructions, overflow order', () => {
  it('goes from one line per skill, to one line for all, to as many names as fit', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 140; n++) {
      const names = Array.from({ length: n }, (_, i) => `skill-${String(i).padStart(3, '0')}`);
      const text = buildServerInstructions(fakePack(names), '9.8.7');
      expect(bytes(text), `${n} skills`).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
      expect(isAscii(text)).toBe(true);
      const index = text.slice(text.lastIndexOf('fits what):\n') + 'fits what):\n'.length);
      const asLines = names.map((name) => `- ${name}`).join('\n');
      const asOneLine = `Skills: ${names.join(', ')}.`;
      const perLine = text.slice(0, text.length - index.length) + asLines;
      const oneLine = text.slice(0, text.length - index.length) + asOneLine;
      if (index === asLines) {
        seen.add('lines');
      } else if (index === asOneLine) {
        seen.add('one_line');
        // (b) is used only when (a) does not fit.
        expect(bytes(perLine)).toBeGreaterThan(INSTRUCTIONS_MAX_BYTES);
      } else {
        seen.add('cut');
        expect(bytes(perLine)).toBeGreaterThan(INSTRUCTIONS_MAX_BYTES);
        expect(bytes(oneLine)).toBeGreaterThan(INSTRUCTIONS_MAX_BYTES);
        const m = /^Skills: (.*) \.\.\. and (\d+) more - call list_skills for the full list\.$/.exec(index);
        expect(m, `${n} skills: ${index.slice(-80)}`).not.toBeNull();
        const kept = m![1]!.split(', ');
        const more = Number(m![2]);
        // A prefix of the sorted names, and every skill accounted for.
        expect(kept).toEqual(names.slice(0, kept.length));
        expect(kept.length + more).toBe(n);
        expect(more).toBeGreaterThan(0);
        // As many as fit: one more name would not.
        const oneMore = text.replace(
          `${kept.join(', ')} ... and ${more} more`,
          `${names.slice(0, kept.length + 1).join(', ')} ... and ${more - 1} more`,
        );
        expect(oneMore).not.toBe(text);
        expect(bytes(oneMore)).toBeGreaterThan(INSTRUCTIONS_MAX_BYTES);
      }
    }
    expect([...seen].sort()).toEqual(['cut', 'lines', 'one_line']);
  });
});

describe('server instructions, packs named by CONTRAIL_SKILLS_DIR', () => {
  it('80 skills still fit in 2,000 bytes and end by pointing at list_skills', async () => {
    const root = path.join(tmp, 'eighty');
    const names = Array.from({ length: 80 }, (_, i) => `synthetic-skill-number-${String(i).padStart(2, '0')}`);
    writePack(root, [...names, 'salesforce-house-rules']);
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client, deps } = await connect();
    expect(deps.skills.pack.skills).toHaveLength(81);
    const text = client.getInstructions() ?? '';
    expect(bytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
    expect(text.endsWith('call list_skills for the full list.')).toBe(true);
    expect(isAscii(text)).toBe(true);
    // The head of the text survives the cut.
    expect(text).toContain('call read_skill with name "salesforce-house-rules"');
    expect(text).toContain('Skills: salesforce-house-rules, synthetic-skill-number-00, ');
  });

  it('a valid override pack says its copies come from CONTRAIL_SKILLS_DIR', async () => {
    const root = path.join(tmp, 'mine');
    writePack(root, ['salesforce-house-rules', 'my-own-skill']);
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override');
    const text = client.getInstructions() ?? '';
    expect(text).toContain(
      `They are read from the folder named by CONTRAIL_SKILLS_DIR, which may not match this engine (${ENGINE_VERSION}).`,
    );
    expect(text).not.toContain('These are the copies that came with this engine');
    expect(text.endsWith('\n- my-own-skill\n- salesforce-house-rules')).toBe(true);
  });

  it('an empty override folder gets the override-missing text, which never says "reinstalling"', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    process.env.CONTRAIL_SKILLS_DIR = empty;
    const { client, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override_missing');
    expect(client.getInstructions()).toBe(OVERRIDE_MISSING_TEXT);
    expect(OVERRIDE_MISSING_TEXT.toLowerCase()).not.toContain('reinstalling');
  });

  it('a missing override folder gets the same text', async () => {
    process.env.CONTRAIL_SKILLS_DIR = path.join(tmp, 'never-created');
    const { client, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override_missing');
    expect(client.getInstructions()).toBe(OVERRIDE_MISSING_TEXT);
  });

  it('an install with no skills folder gets the absent text', () => {
    // A marker-less tree: skills beside the code, but nothing that says Contrail.
    const fromDir = path.join(tmp, 'install', 'server');
    fs.mkdirSync(fromDir, { recursive: true });
    writePack(path.join(tmp, 'install', 'skills'), ['salesforce-house-rules']);
    const pack = loadSkillPack(resolveSkillsDir(fromDir));
    expect(pack.source).toBe('absent');
    expect(buildServerInstructions(pack, ENGINE_VERSION)).toBe(ABSENT_TEXT);
  });
});

describe('list_connections repeats the pointer', () => {
  type Listing = { skills?: { bundled: number; note: string } };

  it('says how many skills are bundled and how to load the house rules', async () => {
    const { client, deps } = await connect();
    const listing = JSON.parse(textOf(await client.callTool({ name: 'list_connections', arguments: {} }))) as Listing;
    expect(listing.skills).toEqual({
      bundled: deps.skills.pack.skills.length,
      note:
        "Contrail's skills ship inside this install. If the house rules are not loaded in this session yet, " +
        'call read_skill with name "salesforce-house-rules" now; list_skills lists the rest.',
    });
    expect(listing.skills!.bundled).toBeGreaterThanOrEqual(22);
  });

  it('a valid override pack: says where the skills come from, never "inside this install"', async () => {
    const root = path.join(tmp, 'mine');
    writePack(root, ['salesforce-house-rules', 'my-own-skill']);
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override');
    const listing = JSON.parse(textOf(await client.callTool({ name: 'list_connections', arguments: {} }))) as Listing;
    expect(listing.skills).toEqual({
      bundled: 2,
      note:
        'The skills Contrail serves are read from the folder named by CONTRAIL_SKILLS_DIR, which may not match ' +
        'this engine. If the house rules are not loaded in this session yet, call read_skill with name ' +
        '"salesforce-house-rules" now; list_skills lists the rest.',
    });
  });

  it('an override pack without house rules: no read_skill call that would be refused', async () => {
    const root = path.join(tmp, 'mine');
    writePack(root, ['my-own-skill']);
    process.env.CONTRAIL_SKILLS_DIR = root;
    const { client, deps } = await connect();
    expect(deps.skills.pack.source).toBe('override');
    const listing = JSON.parse(textOf(await client.callTool({ name: 'list_connections', arguments: {} }))) as Listing;
    expect(listing.skills).toEqual({
      bundled: 1,
      note:
        'The skills Contrail serves are read from the folder named by CONTRAIL_SKILLS_DIR, which may not match ' +
        'this engine. list_skills lists them; read_skill loads one by name.',
    });
    // The server instructions leave the house-rules paragraph out for the same pack.
    expect(client.getInstructions() ?? '').not.toContain('"salesforce-house-rules"');
    // And read_skill would refuse the name the bundled note gives.
    const refused = await client.callTool({ name: 'read_skill', arguments: { name: 'salesforce-house-rules' } });
    expect(refused.isError).toBe(true);
  });

  it('a bundled pack without house rules gets the same no-call note', () => {
    expect(skillsAnnouncement(fakePack(['platform-apex-generate']))).toEqual({
      bundled: 1,
      note: "Contrail's skills ship inside this install. list_skills lists them; read_skill loads one by name.",
    });
  });

  it('says so when CONTRAIL_SKILLS_DIR names a folder with no skills', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    process.env.CONTRAIL_SKILLS_DIR = empty;
    const { client } = await connect();
    const listing = JSON.parse(textOf(await client.callTool({ name: 'list_connections', arguments: {} }))) as Listing;
    expect(listing.skills).toEqual({
      bundled: 0,
      note: 'CONTRAIL_SKILLS_DIR names a folder with no skills in it; read_skill and list_skills have nothing to serve.',
    });
  });

  it('says so when the install has no skills folder', () => {
    const pack = loadSkillPack(resolveSkillsDir(path.join(tmp, 'install', 'server')));
    expect(pack.source).toBe('absent');
    expect(skillsAnnouncement(pack)).toEqual({
      bundled: 0,
      note: 'This install has no bundled skills folder; read_skill and list_skills have nothing to serve.',
    });
  });

  it('its description closes with the skills sentence', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'list_connections')?.description ?? '';
    expect(
      description.endsWith(
        ' Also returns skills: how many skills this install bundles and the read_skill call that loads the house rules.',
      ),
    ).toBe(true);
  });
});

describe('keyword discoverability: asking to see a flow finds render_flow', () => {
  /**
   * A toy ranker, standing in for a client's tool search. It is deliberately
   * simple, and written out here so the test says what it measures and no
   * more:
   *
   *   - a query is lower-cased and split into words; the words in STOP_WORDS
   *     are dropped, and what remains are its content words;
   *   - a tool's name is split at "_" into tokens;
   *   - a tool's title and description are lower-cased and split into words at
   *     every character that is not a letter or a digit;
   *   - a tool scores 2 for each content word that is one of its name's
   *     tokens, plus 1 for each content word that is one of its title or
   *     description words.
   *
   * Whole words only: "flow" does not match "flows". Parameter descriptions
   * are not searched. No real client is claimed to rank this way; the test
   * pins that the words a person would use are in render_flow's own name,
   * title and description, and that no other tool carries more of them.
   */
  const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'as']);

  const QUERIES = [
    'flow diagram',
    'visualize flow',
    'display a flow',
    'flow diff viewer',
    'show flow artifact',
    'compare flow versions',
  ];

  interface Listed {
    name: string;
    title?: string;
    description?: string;
  }

  const contentWords = (query: string): string[] =>
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  const nameTokens = (tool: Listed): Set<string> => new Set(tool.name.toLowerCase().split('_'));

  const textWords = (tool: Listed): Set<string> =>
    new Set(`${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  function score(tool: Listed, query: string): number {
    const inName = nameTokens(tool);
    const inText = textWords(tool);
    let total = 0;
    for (const word of contentWords(query)) {
      if (inName.has(word)) total += 2;
      if (inText.has(word)) total += 1;
    }
    return total;
  }

  async function listed(): Promise<Listed[]> {
    const { client } = await connect();
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, title: t.title, description: t.description }));
  }

  it('the ranker itself: name tokens count double, whole words only, stop words dropped', () => {
    const tool: Listed = { name: 'render_flow', title: 'Render a page', description: 'Draws flows, and a flow.' };
    expect(contentWords('Display a Flow')).toEqual(['display', 'flow']);
    expect(score(tool, 'flow')).toBe(3); // 2 for the name token, 1 for the description word
    expect(score(tool, 'render')).toBe(3);
    expect(score(tool, 'page')).toBe(1);
    expect(score(tool, 'flows')).toBe(1); // in the description, not a name token
    expect(score(tool, 'draw')).toBe(0); // "draws" is another word
    expect(score(tool, 'a')).toBe(0);
    expect(score({ name: 'diff_orgs' }, 'flow diff')).toBe(2);
  });

  for (const query of QUERIES) {
    it(`"${query}": every content word is in render_flow's name, title or description`, async () => {
      const tool = (await listed()).find((t) => t.name === 'render_flow');
      expect(tool, 'render_flow is listed').toBeDefined();
      const known = new Set([...nameTokens(tool!), ...textWords(tool!)]);
      for (const word of contentWords(query)) {
        expect(known.has(word), `"${word}"`).toBe(true);
      }
    });

    it(`"${query}": render_flow ranks first among all listed tools`, async () => {
      const tools = await listed();
      const ranked = tools
        .map((t) => ({ name: t.name, score: score(t, query) }))
        .sort((x, y) => y.score - x.score);
      expect(ranked[0]!.name).toBe('render_flow');
      // First outright, not tied.
      expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    });
  }
});

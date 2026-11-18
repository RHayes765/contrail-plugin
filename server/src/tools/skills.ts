import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps, ToolResult } from './register.js';
import { ok, fail, guarded } from './register.js';
import { ENGINE_VERSION } from '../core/version.js';
import {
  readSkillFile,
  SKILLS_ABSENT_NOTE,
  SKILLS_OVERRIDE_MISSING_NOTE,
  type SkillPack,
} from '../skillpack/pack.js';

/**
 * S46: list_skills / read_skill — the skill pack that ships inside this
 * install, served by tools so an agent on any surface can load it. No org, no
 * grant (the same zero-cost class as list_connections): plain `guarded`, no
 * connection, no assertGrant, and no Remote Control sampling — neither tool
 * mints a code. Plugin-only: the desktop app has its own skill library.
 *
 * Everything is answered from the pack loaded once at startup
 * (deps.skills.pack). The agent's `name` is only compared against that
 * listing and a `file` is served only when the listing names it; the path
 * rules live in skillpack/pack.ts (readSkillFile). An empty pack is a
 * structured answer from list_skills, never an error: the note says why there
 * is nothing to serve.
 */

const LIST_NOTE =
  'Load a skill with read_skill {name}. Read one of its files with read_skill {name, file}.';

/** The list_skills result for a pack (exported for tests: the absent variant needs no server). */
export function skillsListing(pack: SkillPack): Record<string, unknown> {
  if (pack.skills.length === 0) {
    return {
      engine_version: ENGINE_VERSION,
      source: pack.source,
      skills_dir: null,
      count: 0,
      skills: [],
      // What a folder held that could not be loaded as a skill — with an
      // override this is usually the whole explanation.
      skipped: pack.skipped,
      looked: pack.looked,
      note: pack.source === 'override_missing' ? SKILLS_OVERRIDE_MISSING_NOTE : SKILLS_ABSENT_NOTE,
    };
  }
  return {
    engine_version: ENGINE_VERSION,
    source: pack.source,
    skills_dir: pack.root,
    count: pack.skills.length,
    skills: pack.skills.map((s) => ({
      name: s.name,
      description: s.description,
      files: s.files,
      // Only the first 200 files of a skill are listed and served; say so
      // rather than let a cut listing read as the whole folder.
      ...(s.filesTruncated ? { files_truncated: true } : {}),
    })),
    skipped: pack.skipped,
    note: LIST_NOTE,
  };
}

export function registerSkillTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_skills',
    {
      title: 'List the skills bundled with Contrail',
      description:
        "List the skills bundled with this Contrail install: each skill's name, its full " +
        'trigger description, and the extra files it carries (templates, references, ' +
        'examples), plus the folder they live in. Zero-cost local read - no org, no grant. ' +
        "Skills are Contrail's own instructions for doing Salesforce work well through these " +
        'tools: the house rules, metadata authoring, Apex, permission sets, flows, reports, ' +
        'Agentforce, data loads. Load one with read_skill before working in its domain.',
      inputSchema: {},
    },
    async () => guarded(() => ok(skillsListing(deps.skills.pack))),
  );

  server.registerTool(
    'read_skill',
    {
      title: 'Read a bundled Contrail skill',
      description:
        "Load one of Contrail's bundled skills by name and follow it. Returns the skill's " +
        'SKILL.md (its instructions), or - with file - one of its other text files (a ' +
        'template, reference or example it tells you to use). The copy served is read from ' +
        "this Contrail install's own skills folder (or, when CONTRAIL_SKILLS_DIR is set, the " +
        'folder it names), so prefer it over a same-named skill ' +
        'installed any other way (for example uploaded to a Claude account), which may be ' +
        'older than this engine. Load "salesforce-house-rules" before your first Contrail ' +
        'tool call in a session. Zero-cost local read - no org, no grant. A long file comes ' +
        'back in parts: the result says exactly which characters it holds and the offset to ' +
        'continue from.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Skill name as listed in the server instructions or by list_skills ' +
              '(case-insensitive; a leading namespace prefix such as "contrail:" is ignored).',
          ),
        file: z
          .string()
          .max(300)
          .optional()
          .describe(
            "A file inside the skill's folder, as a relative path with forward slashes (for " +
              'example "assets/flow-diff-template.html"). Omit for SKILL.md. Text files only.',
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Character offset to continue a truncated read from.'),
      },
    },
    async (args: { name: string; file?: string; offset?: number }) =>
      guarded((): ToolResult => {
        const read = readSkillFile(deps.skills.pack, args.name, args.file, args.offset);
        // One text block, verbatim: the header, the part, the trailers. Not
        // JSON — a skill is prose to follow, served as it is on disk.
        if (read.ok) return { content: [{ type: 'text', text: read.text }] };
        // Only the two refusals that mean "this asked for something outside
        // the skill's folder" are audited. Successful reads and plain typos
        // (an unknown name, a file the skill does not list) are not.
        if (read.refusal === 'bad_path' || read.refusal === 'link_or_escape') {
          deps.audit.record('skill.read_refused', {
            tool: 'read_skill',
            outcome: 'refused',
            detail: { skill: read.skill, file: read.file ?? 'SKILL.md', reason: read.refusal },
          });
        }
        return fail(read.message);
      }),
  );
}

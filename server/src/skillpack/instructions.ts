import type { SkillPack } from './pack.js';

/**
 * The MCP server instructions: what Contrail is, where its skills are, and the
 * name of every skill this install can serve. One text for every surface — a
 * flag would describe how the server was launched, not what this session can
 * see.
 *
 * Budget: a client may cap server instructions at 2 KB, so the text stays at
 * or under INSTRUCTIONS_MAX_BYTES, ASCII only, most important content first,
 * with a deterministic fallback when the skill list is too long. The index is
 * names only; full trigger descriptions come from list_skills.
 *
 * No clock, no path, nothing per-session: the string is built once in
 * createDeps and reused for every server instance.
 */
export const INSTRUCTIONS_MAX_BYTES = 2000;

const HOUSE_RULES = 'salesforce-house-rules';

const OPENING =
  'Contrail gives Claude governed access to Salesforce orgs: metadata reads, search, ' +
  'diffs, queries, and deploys and data writes that a human approves with a code.';

const LOAD_HOUSE_RULES =
  'Before your first Contrail tool call in a session, load the house rules: call ' +
  'read_skill with name "salesforce-house-rules". Skip this only if you already loaded ' +
  "contrail:salesforce-house-rules through your client's own Skill tool.";

function skillsParagraph(provenance: string): string {
  return (
    "Contrail's skills ship inside this install. read_skill returns one by name; " +
    `list_skills returns every skill's full description. ${provenance} If your client ` +
    'lists a skill as contrail:<name> (the Claude Code plugin does), loading it that way ' +
    'is fine. Any other copy of the same name - for example one uploaded to a Claude ' +
    'account - may be older than this engine: prefer read_skill.'
  );
}

const RENDER_FLOW =
  'To show a flow as a diagram, or to compare two flows or two versions of a flow side ' +
  'by side, call render_flow. Do not hand-build a flow page.';

const INDEX_LEAD =
  'Load the matching skill before you author or diagnose (the house rules say which ' +
  'fits what):';

const ABSENT =
  'This install has no bundled skills folder, so read_skill and list_skills have nothing ' +
  'to serve and render_flow cannot build a page. Every other Contrail tool works ' +
  'normally. Tell the human once that reinstalling Contrail from its release restores ' +
  'the skills.';

const OVERRIDE_MISSING =
  'CONTRAIL_SKILLS_DIR is set, but the folder it names is missing or holds no valid ' +
  'skill, so read_skill and list_skills have nothing to serve and render_flow cannot ' +
  'build a page. Every other Contrail tool works normally. Tell the human once to ' +
  'correct or unset CONTRAIL_SKILLS_DIR.';

function fromOverride(pack: SkillPack): boolean {
  return pack.source === 'override' || pack.source === 'override_missing';
}

export function buildServerInstructions(pack: SkillPack, engineVersion: string): string {
  if (pack.skills.length === 0) {
    // A bad CONTRAIL_SKILLS_DIR is not "absent": reinstalling would not help.
    return [OPENING, fromOverride(pack) ? OVERRIDE_MISSING : ABSENT].join('\n\n');
  }

  const names = pack.skills.map((s) => s.name);
  const provenance = fromOverride(pack)
    ? `They are read from the folder named by CONTRAIL_SKILLS_DIR, which may not match this engine (${engineVersion}).`
    : `These are the copies that came with this engine (${engineVersion}).`;
  const head = [
    OPENING,
    ...(names.includes(HOUSE_RULES) ? [LOAD_HOUSE_RULES] : []),
    skillsParagraph(provenance),
    RENDER_FLOW,
  ];
  const withIndex = (index: string): string => [...head, `${INDEX_LEAD}\n${index}`].join('\n\n');
  const fits = (text: string): boolean =>
    Buffer.byteLength(text, 'utf8') <= INSTRUCTIONS_MAX_BYTES;

  // (a) One line per skill.
  const lines = withIndex(names.map((n) => `- ${n}`).join('\n'));
  if (fits(lines)) return lines;

  // (b) One line for all of them.
  const oneLine = withIndex(`Skills: ${names.join(', ')}.`);
  if (fits(oneLine)) return oneLine;

  // (c) As many names as fit, and a pointer at the full list. The text around
  // the index is about half the budget, so some names always fit; the loop
  // still ends at none rather than assume it.
  const cutAt = (kept: number): string =>
    withIndex(
      `Skills:${kept > 0 ? ` ${names.slice(0, kept).join(', ')}` : ''} ... and ` +
        `${names.length - kept} more - call list_skills for the full list.`,
    );
  for (let kept = names.length - 1; kept > 0; kept--) {
    const cut = cutAt(kept);
    if (fits(cut)) return cut;
  }
  return cutAt(0);
}

/**
 * The pointer list_connections repeats on the session-start surface: it is
 * not verified that every client shows MCP instructions to the model. It
 * follows the instructions on the two points they vary on: where the served
 * copies come from (a CONTRAIL_SKILLS_DIR folder is not "inside this
 * install"), and whether there are house rules to load (a pack without them
 * gets no read_skill call that would only be refused).
 */
export function skillsAnnouncement(pack: SkillPack): { bundled: number; note: string } {
  if (pack.skills.length > 0) {
    const where = fromOverride(pack)
      ? 'The skills Contrail serves are read from the folder named by CONTRAIL_SKILLS_DIR, ' +
        'which may not match this engine.'
      : "Contrail's skills ship inside this install.";
    const next = pack.skills.some((s) => s.name === HOUSE_RULES)
      ? ' If the house rules are not loaded in this session yet, call read_skill with name ' +
        '"salesforce-house-rules" now; list_skills lists the rest.'
      : ' list_skills lists them; read_skill loads one by name.';
    return { bundled: pack.skills.length, note: where + next };
  }
  return {
    bundled: 0,
    note: fromOverride(pack)
      ? 'CONTRAIL_SKILLS_DIR names a folder with no skills in it; read_skill and list_skills have nothing to serve.'
      : 'This install has no bundled skills folder; read_skill and list_skills have nothing to serve.',
  };
}

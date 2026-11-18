/**
 * S46: policies for client work — the rules a human writes into the
 * `policies` section of config.json (justification, ticket, deny rules, a
 * minimum test level, freeze windows), their parser, their evaluation, and
 * every refusal, banner and notice text built from them.
 *
 * A byte-identical mirror unit whose one import is node:vm (the time bound on
 * a ticket pattern's test): both engines evaluate with this one function and
 * print these words, so they cannot drift. It is pure apart from the clock
 * and the time-zone database: `now` and the host zone arrive in the context,
 * and wall-clock times come from Intl.DateTimeFormat — a freeze window is
 * never converted to UTC.
 *
 * No text here says what an agent cannot do to config.json or to the
 * approval page; the texts say what no Contrail tool does and what the agent
 * must not do.
 */

import vm from 'node:vm';

export const POLICY_LIMITS = {
  ticketMax: 120,
  justificationMax: 1000,
  freezeReasonMin: 15,
  freezeReasonMax: 1000,
  nameMax: 80,
  maxRules: 50,
  maxWindows: 50,
  patternMax: 200,
} as const;

export const TEST_LEVEL_ORDER = [
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
  'RunAllTestsInOrg',
] as const;
export type PolicyTestLevel = (typeof TEST_LEVEL_ORDER)[number];
export type PolicyOrgType = 'production' | 'sandbox' | 'developer' | 'trial' | 'unknown';
export type PolicyKind = 'deploy' | 'dml' | 'apex' | 'bulk' | 'activation';

export interface FreezeWindow {
  name: string;
  /** "<day> HH:MM" wall-clock in timeZone; wraps the week when `to` is earlier than `from`. */
  weekly?: { from: string; to: string };
  /** "YYYY-MM-DDTHH:MM" wall-clock in timeZone; half-open. */
  range?: { from: string; to: string };
  /** IANA zone; omitted = the host's zone. */
  timeZone?: string;
}

export interface PolicyRule {
  name: string;
  match?: { orgTypes?: PolicyOrgType[]; connections?: string[]; orgIds?: string[] };
  requireJustification?: boolean;
  requireTicket?: boolean;
  ticketPattern?: string;
  denyDestructiveMetadata?: boolean;
  denyDataDeletes?: boolean;
  denyAnonymousApex?: boolean;
  minTestLevel?: PolicyTestLevel;
  freezeWindows?: FreezeWindow[];
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

/**
 * The built-in rule. It is DEFAULT_CONFIG.policies, so it is written into
 * fresh config files; an install whose config.json predates S46 has no
 * section and runs this rule with source 'default'.
 */
export const DEFAULT_POLICIES: PolicyConfig = {
  rules: [
    {
      name: 'default: production needs a justification',
      match: { orgTypes: ['production', 'unknown'] },
      requireJustification: true,
    },
  ],
};

export interface PolicyContext {
  orgType: PolicyOrgType;
  /** This connection's label, for the texts. */
  alias: string;
  /** The labels a `connections` matcher is tested against: this connection's, then those of every stored connection to the same org. */
  orgAliases: string[];
  orgId: string | null;
  kind: PolicyKind;
  /** deploy: the package deletes components; dml / bulk: the change deletes records. */
  destructive: boolean;
  testLevel: PolicyTestLevel | null;
  ticket: string | null;
  justification: string | null;
  now: number;
  hostTimeZone: string;
}

export interface PolicyFreeze {
  rule: string;
  window: string;
  until: string;
  timeZone: string;
}

export interface PolicyInEffect {
  rules: string[];
  requirements: {
    justification: boolean;
    ticket: boolean;
    ticketPatterns: string[];
    denyDestructiveMetadata: boolean;
    denyDataDeletes: boolean;
    denyAnonymousApex: boolean;
    minTestLevel: PolicyTestLevel | null;
  };
  lines: string[];
  windows: Array<{ rule: string; name: string; when: string; timeZone: string }>;
  freeze: PolicyFreeze | null;
}

export type PolicyViolationCode =
  | 'justification_required'
  | 'ticket_required'
  | 'ticket_pattern'
  | 'destructive_metadata_denied'
  | 'data_deletes_denied'
  | 'anonymous_apex_denied'
  | 'min_test_level';

export interface PolicyViolation {
  code: PolicyViolationCode;
  rule: string;
  text: string;
}

export type PolicyVerdict = PolicyInEffect & { violations: PolicyViolation[] };

/** The host's IANA zone, or 'UTC' when the runtime reports none. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ── parsing ──────────────────────────────────────────────────────────────

const ORG_TYPES: readonly PolicyOrgType[] = ['production', 'sandbox', 'developer', 'trial', 'unknown'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const ROOT_KEYS = ['rules'];
const RULE_KEYS = [
  'name',
  'match',
  'requireJustification',
  'requireTicket',
  'ticketPattern',
  'denyDestructiveMetadata',
  'denyDataDeletes',
  'denyAnonymousApex',
  'minTestLevel',
  'freezeWindows',
];
const MATCH_KEYS = ['orgTypes', 'connections', 'orgIds'];
const WINDOW_KEYS = ['name', 'weekly', 'range', 'timeZone'];
const SPAN_KEYS = ['from', 'to'];
const RULE_FLAGS = [
  'requireJustification',
  'requireTicket',
  'denyDestructiveMetadata',
  'denyDataDeletes',
  'denyAnonymousApex',
] as const;
const WEEKLY_RE = /^(mon|tue|wed|thu|fri|sat|sun) ([01]\d|2[0-3]):([0-5]\d)$/;
const RANGE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ORG_ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
/** C0 and C1 control characters, and DEL. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** The same, less LF — the one control character a justification or reason may hold. */
const CONTROL_EXCEPT_LF_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

class PolicyParseError extends Error {}

function fail(path: string, text: string): never {
  throw new PolicyParseError(path === '' ? text : `${path}: ${text}`);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, known: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) fail(path, `unknown key "${key}" (known: ${known.join(', ')})`);
  }
}

function parseName(raw: unknown, path: string, what: string): string {
  if (raw === undefined) fail(path, `missing — every ${what} needs a name`);
  if (typeof raw !== 'string') fail(path, `expected a name (text), got ${kindOf(raw)}`);
  const name = raw.trim();
  if (name === '') fail(path, `empty — every ${what} needs a name`);
  if (CONTROL_RE.test(name)) fail(path, 'must be one line with no control characters');
  if (name.length > POLICY_LIMITS.nameMax) {
    fail(path, `longer than ${POLICY_LIMITS.nameMax} characters`);
  }
  return name;
}

function parseStringList(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) fail(path, `expected a list, got ${kindOf(raw)}`);
  if (raw.length === 0) fail(path, 'empty list — remove the key to match every connection');
  return raw.map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      fail(`${path}[${i}]`, `expected non-empty text, got ${kindOf(entry)}`);
    }
    return entry.trim();
  });
}

function compilePattern(pattern: string): RegExp {
  // The raw pattern must compile on its own as well as wrapped, so a
  // pattern such as `a)(b` is not accepted just because the wrapper
  // balances it.
  new RegExp(pattern);
  return new RegExp(`^(?:${pattern})$`);
}

/** How long one ticket-pattern test may run before it counts as not matching. */
const TICKET_TEST_MS = 100;
let ticketTest: { script: vm.Script; context: vm.Context } | null = null;

/**
 * Whether the whole ticket matches a configured pattern. The test runs under
 * a time bound: a pattern with a repeated group inside a repetition can
 * backtrack for hours on a ticket the agent chose, and on the main thread
 * that would stall every tool and approval page of this process. A test
 * that runs out of time throws, and the caller counts it as not matching
 * (fails closed).
 */
function ticketMatches(pattern: string, ticket: string): boolean {
  ticketTest ??= { script: new vm.Script('re.test(t)'), context: vm.createContext({}) };
  const { script, context } = ticketTest;
  context.re = compilePattern(pattern);
  context.t = ticket;
  try {
    return script.runInContext(context, { timeout: TICKET_TEST_MS }) === true;
  } finally {
    context.re = null;
    context.t = null;
  }
}

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function realWallClock(text: string): boolean {
  const m = RANGE_RE.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0);
}

function parseSpan(raw: unknown, path: string, form: 'weekly' | 'range'): { from: string; to: string } {
  if (!isPlainObject(raw)) fail(path, `expected {"from": …, "to": …}, got ${kindOf(raw)}`);
  checkKeys(raw, SPAN_KEYS, path);
  const out: { from: string; to: string } = { from: '', to: '' };
  for (const end of ['from', 'to'] as const) {
    const value = raw[end];
    const at = `${path}.${end}`;
    if (form === 'weekly') {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!WEEKLY_RE.test(text)) {
        fail(
          at,
          `expected "<day> HH:MM" (day mon|tue|wed|thu|fri|sat|sun, 24-hour time), got ${
            typeof value === 'string' ? `"${value}"` : kindOf(value)
          }`,
        );
      }
      out[end] = text;
    } else {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!RANGE_RE.test(text)) {
        fail(
          at,
          `expected "YYYY-MM-DDTHH:MM" (local wall-clock time), got ${
            typeof value === 'string' ? `"${value}"` : kindOf(value)
          }`,
        );
      }
      if (!realWallClock(text)) fail(at, `"${text}" is not a real date and time`);
      out[end] = text;
    }
  }
  if (form === 'weekly' && out.from === out.to) {
    fail(path, 'from and to are the same time — a window must have a length');
  }
  if (form === 'range' && out.from >= out.to) fail(path, 'from must be before to');
  return out;
}

function parseWindow(raw: unknown, path: string): FreezeWindow {
  if (!isPlainObject(raw)) fail(path, `expected an object, got ${kindOf(raw)}`);
  checkKeys(raw, WINDOW_KEYS, path);
  const window: FreezeWindow = { name: parseName(raw.name, `${path}.name`, 'freeze window') };
  const hasWeekly = raw.weekly !== undefined;
  const hasRange = raw.range !== undefined;
  if (hasWeekly === hasRange) {
    fail(path, 'give exactly one of weekly or range');
  }
  if (hasWeekly) window.weekly = parseSpan(raw.weekly, `${path}.weekly`, 'weekly');
  else window.range = parseSpan(raw.range, `${path}.range`, 'range');
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone !== 'string' || raw.timeZone.trim() === '') {
      fail(`${path}.timeZone`, `expected an IANA time zone name, got ${kindOf(raw.timeZone)}`);
    }
    const zone = raw.timeZone.trim();
    if (!knownTimeZone(zone)) {
      fail(`${path}.timeZone`, `"${zone}" is not a time zone this machine knows`);
    }
    window.timeZone = zone;
  }
  return window;
}

function parseRule(raw: unknown, path: string): PolicyRule {
  if (!isPlainObject(raw)) fail(path, `expected an object, got ${kindOf(raw)}`);
  checkKeys(raw, RULE_KEYS, path);
  const rule: PolicyRule = { name: parseName(raw.name, `${path}.name`, 'rule') };
  if (raw.match !== undefined) {
    const m = raw.match;
    if (!isPlainObject(m)) fail(`${path}.match`, `expected an object, got ${kindOf(m)}`);
    checkKeys(m, MATCH_KEYS, `${path}.match`);
    const match: NonNullable<PolicyRule['match']> = {};
    if (m.orgTypes !== undefined) {
      const at = `${path}.match.orgTypes`;
      match.orgTypes = parseStringList(m.orgTypes, at).map((t, i) => {
        if (!(ORG_TYPES as readonly string[]).includes(t)) {
          fail(`${at}[${i}]`, `"${t}" is not an org type (${ORG_TYPES.join(', ')})`);
        }
        return t as PolicyOrgType;
      });
    }
    if (m.connections !== undefined) {
      match.connections = parseStringList(m.connections, `${path}.match.connections`);
    }
    if (m.orgIds !== undefined) {
      const at = `${path}.match.orgIds`;
      match.orgIds = parseStringList(m.orgIds, at).map((id, i) => {
        if (!ORG_ID_RE.test(id)) {
          fail(`${at}[${i}]`, `expected a 15- or 18-character org id, got "${id}"`);
        }
        return id;
      });
    }
    rule.match = match;
  }
  for (const flag of RULE_FLAGS) {
    const value = raw[flag];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') fail(`${path}.${flag}`, `expected true or false, got ${kindOf(value)}`);
    rule[flag] = value;
  }
  if (raw.ticketPattern !== undefined) {
    const at = `${path}.ticketPattern`;
    const p = raw.ticketPattern;
    if (typeof p !== 'string' || p === '') fail(at, `expected a regular expression (text), got ${kindOf(p)}`);
    if (p.length > POLICY_LIMITS.patternMax) {
      fail(at, `longer than ${POLICY_LIMITS.patternMax} characters`);
    }
    try {
      compilePattern(p);
    } catch (err) {
      fail(at, `does not compile as a regular expression (${err instanceof Error ? err.message : String(err)})`);
    }
    rule.ticketPattern = p;
  }
  if (raw.minTestLevel !== undefined) {
    const level = raw.minTestLevel;
    if (typeof level !== 'string' || !(TEST_LEVEL_ORDER as readonly string[]).includes(level)) {
      fail(
        `${path}.minTestLevel`,
        `${kindOf(level)} is not a test level (${TEST_LEVEL_ORDER.join(', ')})`,
      );
    }
    rule.minTestLevel = level as PolicyTestLevel;
  }
  if (raw.freezeWindows !== undefined) {
    const at = `${path}.freezeWindows`;
    const list = raw.freezeWindows;
    if (!Array.isArray(list)) fail(at, `expected a list, got ${kindOf(list)}`);
    if (list.length > POLICY_LIMITS.maxWindows) {
      fail(at, `at most ${POLICY_LIMITS.maxWindows} windows, got ${list.length}`);
    }
    const seen = new Map<string, number>();
    rule.freezeWindows = list.map((w, i) => {
      const parsed = parseWindow(w, `${at}[${i}]`);
      const key = parsed.name.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        fail(
          `${at}[${i}].name`,
          `"${parsed.name}" is already used by ${at}[${first}] — window names must be unique within a rule`,
        );
      }
      seen.set(key, i);
      return parsed;
    });
  }
  return rule;
}

/**
 * Validate a policies section. The first problem found is reported, its
 * message starting with the JSON path inside the section (`rules[1].…`).
 * An unknown key is a problem, never ignored: a typo such as
 * `requireTickets` must not read as "no requirement".
 */
export function parsePolicies(
  raw: unknown,
): { ok: true; policies: PolicyConfig } | { ok: false; problem: string } {
  try {
    if (!isPlainObject(raw)) fail('', `expected {"rules": [ … ]}, got ${kindOf(raw)}`);
    checkKeys(raw, ROOT_KEYS, '');
    if (raw.rules === undefined) fail('rules', 'missing — expected a list of rules');
    if (!Array.isArray(raw.rules)) fail('rules', `expected a list, got ${kindOf(raw.rules)}`);
    if (raw.rules.length > POLICY_LIMITS.maxRules) {
      fail('rules', `at most ${POLICY_LIMITS.maxRules} rules, got ${raw.rules.length}`);
    }
    const seen = new Map<string, number>();
    const rules = raw.rules.map((r, i) => {
      const rule = parseRule(r, `rules[${i}]`);
      const key = rule.name.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        fail(
          `rules[${i}].name`,
          `"${rule.name}" is already used by rules[${first}] — rule names must be unique`,
        );
      }
      seen.set(key, i);
      return rule;
    });
    return { ok: true, policies: { rules } };
  } catch (err) {
    if (err instanceof PolicyParseError) return { ok: false, problem: err.message };
    throw err;
  }
}

// ── evaluation ───────────────────────────────────────────────────────────

function orgKey(orgId: string | null | undefined): string | null {
  return orgId ? orgId.slice(0, 15) : null;
}

function labelMatches(pattern: string, alias: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
  return re.test(alias);
}

/** The label and org-id matchers only; `orgTypes` is tested by the caller. */
function identityMatches(
  match: NonNullable<PolicyRule['match']>,
  aliases: string[],
  orgId: string | null,
): boolean {
  if (match.connections && !match.connections.some((p) => aliases.some((a) => labelMatches(p, a)))) {
    return false;
  }
  if (match.orgIds) {
    const key = orgKey(orgId);
    if (key === null || !match.orgIds.some((id) => orgKey(id) === key)) return false;
  }
  return true;
}

function ruleApplies(
  rule: PolicyRule,
  c: Pick<PolicyContext, 'orgType' | 'alias' | 'orgAliases' | 'orgId'>,
): boolean {
  const match = rule.match;
  if (!match) return true;
  if (
    match.orgTypes &&
    !match.orgTypes.some((t) => t === c.orgType || (t === 'production' && c.orgType === 'unknown'))
  ) {
    return false;
  }
  return identityMatches(match, [c.alias, ...c.orgAliases], c.orgId);
}

function testLevelRank(level: PolicyTestLevel): number {
  return TEST_LEVEL_ORDER.indexOf(level);
}

interface WallClock {
  /** Minute of the week, Monday 00:00 = 0. */
  minuteOfWeek: number;
  /** Zero-padded local "YYYY-MM-DDTHH:MM". */
  stamp: string;
}

function wallClock(now: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3) as (typeof DAYS)[number]);
  const hour = get('hour');
  const minute = get('minute');
  return {
    minuteOfWeek: day * 1440 + Number(hour) * 60 + Number(minute),
    stamp: `${get('year')}-${get('month')}-${get('day')}T${hour}:${minute}`,
  };
}

const WEEK_MINUTES = 7 * 1440;

function minuteOfWeek(token: string): number {
  const m = WEEKLY_RE.exec(token);
  if (!m) return -1;
  return DAYS.indexOf(m[1] as (typeof DAYS)[number]) * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

/** A "YYYY-MM-DDTHH:MM" wall-clock stamp as minutes, read as if it were UTC — for differences only. */
function stampMinutes(stamp: string): number {
  const m = RANGE_RE.exec(stamp);
  if (!m) return Number.NaN;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

/** From inclusive, to exclusive. */
function windowActive(w: FreezeWindow, clock: WallClock): boolean {
  if (w.weekly) {
    const from = minuteOfWeek(w.weekly.from);
    const to = minuteOfWeek(w.weekly.to);
    const t = clock.minuteOfWeek;
    return from < to ? t >= from && t < to : t >= from || t < to;
  }
  if (w.range) return clock.stamp >= w.range.from && clock.stamp < w.range.to;
  return false;
}

/**
 * How many minutes an active window has left, read on its own wall clock: a
 * weekly window up to its `to` minute of the week, a dated one up to its
 * range end. null when the window is not active now. A window whose zone
 * cannot be read counts as active with no known end (fails closed).
 */
function windowMinutesLeft(w: FreezeWindow, now: number, zone: string): number | null {
  let clock: WallClock;
  try {
    clock = wallClock(now, zone);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (!windowActive(w, clock)) return null;
  if (w.weekly) {
    const left =
      (((minuteOfWeek(w.weekly.to) - clock.minuteOfWeek) % WEEK_MINUTES) + WEEK_MINUTES) %
      WEEK_MINUTES;
    return left === 0 ? WEEK_MINUTES : left;
  }
  if (w.range) {
    const left = stampMinutes(w.range.to) - stampMinutes(clock.stamp);
    return Number.isNaN(left) ? Number.POSITIVE_INFINITY : left;
  }
  return null;
}

function windowWhen(w: FreezeWindow): string {
  if (w.weekly) return `every ${w.weekly.from} to ${w.weekly.to}`;
  if (w.range) return `${w.range.from.replace('T', ' ')} to ${w.range.to.replace('T', ' ')}`;
  return '';
}

function windowUntil(w: FreezeWindow, zone: string): string {
  const end = w.weekly ? w.weekly.to : (w.range?.to ?? '').replace('T', ' ');
  return `${end} ${zone}`;
}

function ruleLines(rule: PolicyRule, hostZone: string): string[] {
  const r = rule.name;
  const lines: string[] = [];
  if (rule.requireJustification) lines.push(`A justification is required (rule "${r}").`);
  if (rule.requireTicket) lines.push(`A ticket is required (rule "${r}").`);
  if (rule.ticketPattern) {
    lines.push(`A ticket, when given, must match ${rule.ticketPattern} (rule "${r}").`);
  }
  if (rule.denyDestructiveMetadata) {
    lines.push(`Destructive metadata changes are denied (rule "${r}").`);
  }
  if (rule.denyDataDeletes) {
    lines.push(
      `Data deletes through dml_propose and bulk_load_propose are denied (rule "${r}"); anonymous Apex is not inspected.`,
    );
  }
  if (rule.denyAnonymousApex) lines.push(`Anonymous Apex is denied (rule "${r}").`);
  if (rule.minTestLevel) {
    lines.push(`Deploys need test_level ${rule.minTestLevel} or stricter, passed explicitly (rule "${r}").`);
  }
  for (const w of rule.freezeWindows ?? []) {
    lines.push(`Freeze window "${w.name}": ${windowWhen(w)} ${w.timeZone ?? hostZone} (rule "${r}").`);
  }
  return lines;
}

/**
 * What applies to one connection right now: the matched rules (config
 * order), their union — booleans OR, every ticket pattern, the highest
 * minimum test level — the lines a human surface lists, the freeze windows,
 * and the freeze in effect. Every window of every matched rule is evaluated;
 * of those active now, the one with the most time left is named (ties keep
 * config order), so the `until` every surface shows is the latest end among
 * the windows active now — the earliest moment the freeze can end (a window
 * that begins before then can extend it). Design B named the first active
 * window in config order; with overlapping windows that understated the
 * freeze.
 */
export function policyInEffect(
  p: PolicyConfig,
  c: Pick<PolicyContext, 'orgType' | 'alias' | 'orgAliases' | 'orgId' | 'now' | 'hostTimeZone'>,
): PolicyInEffect {
  const matched = p.rules.filter((rule) => ruleApplies(rule, c));
  const out: PolicyInEffect = {
    rules: matched.map((r) => r.name),
    requirements: {
      justification: false,
      ticket: false,
      ticketPatterns: [],
      denyDestructiveMetadata: false,
      denyDataDeletes: false,
      denyAnonymousApex: false,
      minTestLevel: null,
    },
    lines: [],
    windows: [],
    freeze: null,
  };
  const req = out.requirements;
  let namedLeft = Number.NEGATIVE_INFINITY;
  for (const rule of matched) {
    req.justification ||= rule.requireJustification === true;
    req.ticket ||= rule.requireTicket === true;
    if (rule.ticketPattern) req.ticketPatterns.push(rule.ticketPattern);
    req.denyDestructiveMetadata ||= rule.denyDestructiveMetadata === true;
    req.denyDataDeletes ||= rule.denyDataDeletes === true;
    req.denyAnonymousApex ||= rule.denyAnonymousApex === true;
    if (
      rule.minTestLevel &&
      (req.minTestLevel === null || testLevelRank(rule.minTestLevel) > testLevelRank(req.minTestLevel))
    ) {
      req.minTestLevel = rule.minTestLevel;
    }
    out.lines.push(...ruleLines(rule, c.hostTimeZone));
    for (const w of rule.freezeWindows ?? []) {
      const zone = w.timeZone ?? c.hostTimeZone;
      out.windows.push({ rule: rule.name, name: w.name, when: windowWhen(w), timeZone: zone });
      const left = windowMinutesLeft(w, c.now, zone);
      if (left !== null && left > namedLeft) {
        namedLeft = left;
        out.freeze = { rule: rule.name, window: w.name, until: windowUntil(w, zone), timeZone: zone };
      }
    }
  }
  return out;
}

/** policyInEffect plus every rule this proposal breaks, each with its verbatim text. */
export function evaluatePolicies(p: PolicyConfig, c: PolicyContext): PolicyVerdict {
  const inEffect = policyInEffect(p, c);
  const matched = p.rules.filter((rule) => ruleApplies(rule, c));
  const first = (test: (rule: PolicyRule) => boolean): string | null =>
    matched.find(test)?.name ?? null;
  const alias = c.alias;
  const ticket = c.ticket !== null && c.ticket.trim() !== '' ? c.ticket.trim() : null;
  const justified = c.justification !== null && c.justification.trim() !== '';
  const violations: PolicyViolation[] = [];

  const jRule = first((r) => r.requireJustification === true);
  if (jRule !== null && !justified) {
    violations.push({
      code: 'justification_required',
      rule: jRule,
      text: `policy rule "${jRule}" requires a justification for every change to "${alias}" — pass justification: one or two sentences, drafted from what the human asked for, on why this change is being made now`,
    });
  }
  const tRule = first((r) => r.requireTicket === true);
  if (tRule !== null && ticket === null) {
    violations.push({
      code: 'ticket_required',
      rule: tRule,
      text: `policy rule "${tRule}" requires a ticket for every change to "${alias}" — pass ticket with the reference the human gave you; if they gave none, ask them (never invent one)`,
    });
  }
  if (ticket !== null) {
    for (const rule of matched) {
      if (!rule.ticketPattern) continue;
      let ok = false;
      try {
        ok = ticketMatches(rule.ticketPattern, ticket);
      } catch {
        ok = false;
      }
      if (!ok) {
        violations.push({
          code: 'ticket_pattern',
          rule: rule.name,
          text: `policy rule "${rule.name}" requires the ticket to match ${rule.ticketPattern} — "${ticket}" does not; ask the human for the correct reference (never adjust one to fit)`,
        });
      }
    }
  }
  if (c.kind === 'deploy' && c.destructive) {
    const rule = first((r) => r.denyDestructiveMetadata === true);
    if (rule !== null) {
      violations.push({
        code: 'destructive_metadata_denied',
        rule,
        text: `policy rule "${rule}" denies destructive metadata changes on "${alias}" — this package contains deletions`,
      });
    }
  }
  if ((c.kind === 'dml' || c.kind === 'bulk') && c.destructive) {
    const rule = first((r) => r.denyDataDeletes === true);
    if (rule !== null) {
      violations.push({
        code: 'data_deletes_denied',
        rule,
        text: `policy rule "${rule}" denies data deletes on "${alias}" — this ${c.kind === 'bulk' ? 'bulk plan' : 'data change'} deletes records`,
      });
    }
  }
  if (c.kind === 'apex') {
    const rule = first((r) => r.denyAnonymousApex === true);
    if (rule !== null) {
      violations.push({
        code: 'anonymous_apex_denied',
        rule,
        text: `policy rule "${rule}" denies anonymous Apex on "${alias}"`,
      });
    }
  }
  const min = inEffect.requirements.minTestLevel;
  if (c.kind === 'deploy' && min !== null) {
    const rule = first((r) => r.minTestLevel === min) ?? '';
    if (c.testLevel === null) {
      violations.push({
        code: 'min_test_level',
        rule,
        text: `policy rule "${rule}" requires test_level ${min} or stricter on "${alias}" — test_level was omitted, which leaves the choice to the org's own default, so Contrail cannot show the minimum is met; pass test_level explicitly`,
      });
    } else if (testLevelRank(c.testLevel) < testLevelRank(min)) {
      violations.push({
        code: 'min_test_level',
        rule,
        text: `policy rule "${rule}" requires test_level ${min} or stricter on "${alias}" — ${c.testLevel} is weaker (weakest to strictest: NoTestRun, RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg)`,
      });
    }
  }
  return { ...inEffect, violations };
}

/**
 * Names of the rules that carry a `connections` or `orgIds` matcher no
 * stored connection satisfies — a label rule left behind when an org was
 * re-connected under a new label. A label is tested against every
 * connection to the same org, as at evaluation; `orgTypes` is not
 * consulted, so a rule matched by org type alone is never listed.
 */
export function unmatchedRules(
  p: PolicyConfig,
  connections: Array<{ alias: string; orgId: string | null }>,
): string[] {
  const aliasesOf = (orgId: string | null, alias: string): string[] => {
    const key = orgKey(orgId);
    const same =
      key === null ? [] : connections.filter((o) => orgKey(o.orgId) === key).map((o) => o.alias);
    return [alias, ...same];
  };
  return p.rules
    .filter((rule) => rule.match && (rule.match.connections || rule.match.orgIds))
    .filter(
      (rule) =>
        !connections.some((conn) =>
          identityMatches(rule.match!, aliasesOf(conn.orgId, conn.alias), conn.orgId),
        ),
    )
    .map((rule) => rule.name);
}

// ── inputs ───────────────────────────────────────────────────────────────

function foldLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** One line, at most 120 characters; blank or absent → null. */
export function normalizeTicket(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; problem: string } {
  const problem = `ticket must be one line of at most ${POLICY_LIMITS.ticketMax} characters with no control characters`;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, problem };
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  if (CONTROL_RE.test(value) || value.length > POLICY_LIMITS.ticketMax) return { ok: false, problem };
  return { ok: true, value };
}

/**
 * CR LF and a lone CR become LF first (a browser submits textarea breaks as
 * CR LF and counts each as one character), then the text is trimmed, then
 * the control-character rule and the limit apply to the normalised text.
 * Blank or absent → null.
 */
export function normalizeJustification(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; problem: string } {
  const problem = `justification must be at most ${POLICY_LIMITS.justificationMax} characters with no control characters other than line breaks`;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, problem };
  const value = foldLineBreaks(raw).trim();
  if (value === '') return { ok: true, value: null };
  if (CONTROL_EXCEPT_LF_RE.test(value) || value.length > POLICY_LIMITS.justificationMax) {
    return { ok: false, problem };
  }
  return { ok: true, value };
}

/** The emergency reason typed on a human surface; normalised as a justification is, then 15–1,000 characters. */
export function normalizeFreezeReason(
  raw: unknown,
):
  | { ok: true; value: string }
  | { ok: false; code: 'override_too_short' | 'override_too_long' | 'invalid_text' } {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_text' };
  const value = foldLineBreaks(raw).trim();
  if (CONTROL_EXCEPT_LF_RE.test(value)) return { ok: false, code: 'invalid_text' };
  if (value.length < POLICY_LIMITS.freezeReasonMin) return { ok: false, code: 'override_too_short' };
  if (value.length > POLICY_LIMITS.freezeReasonMax) return { ok: false, code: 'override_too_long' };
  return { ok: true, value };
}

// ── texts ────────────────────────────────────────────────────────────────

/**
 * Which refusal text a check prints. 'attach' is a deploy's first check on a
 * full-arguments call that would have attached to a validation still
 * running with the same arguments: that validation goes on.
 */
export type PolicyPhase = 'propose' | 'attach' | 'after_validation' | 'execute';
export type PolicySource = 'default' | 'config';
export type ApprovalSurfaceMode = 'page' | 'native';

function sourceSentence(source: PolicySource): string {
  return source === 'config'
    ? "These rules are in the policies section of Contrail's config.json."
    : "This is Contrail's built-in default rule: config.json has no policies section (rules written there replace it).";
}

const HUMAN_ONLY =
  "No Contrail tool can change the policies, and changing them is the human's decision alone: do not edit config.json yourself and do not ask the human to loosen it for this change.";

export function policyRefusalText(
  alias: string,
  orgType: string,
  violations: Array<Pick<PolicyViolation, 'text'>>,
  phase: PolicyPhase,
  source: PolicySource,
): string {
  const list = violations.map((v) => `- ${v.text}`);
  const S = sourceSentence(source);
  if (phase === 'execute') {
    return [
      `POLICY REFUSAL — not executed. The code was not used up and the request is still pending, but it cannot run on "${alias}" (${orgType}) while this holds:`,
      ...list,
      `Contrail re-checks the policies when a change executes, and this request does not satisfy them as they stand now. ${S} No Contrail tool can change that file, and you must not edit it yourself. Relay this to the human — if the change is still wanted, propose it again so the approval reflects the current rules.`,
    ].join('\n');
  }
  const head =
    phase === 'propose'
      ? `POLICY REFUSAL — nothing was validated, proposed or sent to "${alias}" (${orgType}), and any pending approval on it is untouched.`
      : phase === 'attach'
        ? `POLICY REFUSAL — this call was not attached to the validation already running on "${alias}" (${orgType}) with these arguments; this call sent nothing and left any pending approval untouched. That validation goes on and is checked against the policies again when it finishes — no approval is created unless they then allow it; poll it by job_id to see its outcome. The policies now do not allow this request:`
        : `POLICY REFUSAL — the check-only validation ran on "${alias}" (${orgType}), but no approval was created and any pending approval on it is untouched. Contrail re-read the policies when the validation finished, and they do not allow this request:`;
  return [
    head,
    ...list,
    `${S} ${HUMAN_ONLY} Relay this refusal to them as it stands — do not try another tool, connection or route to make the same change.`,
  ].join('\n');
}

export function policyUnreadableText(problem: string, phase: PolicyPhase): string {
  if (phase === 'after_validation') {
    return `POLICY CHECK FAILED CLOSED — the check-only validation ran, but no approval was created and any pending approval is untouched. Contrail could not read the policies in config.json when the validation finished: ${problem}. No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly; once the file is fixed, validate again.`;
  }
  if (phase === 'execute') {
    return `POLICY CHECK FAILED CLOSED — not executed. Contrail could not read the policies in config.json: ${problem}. The code was not used up; once the human has fixed the file, the same code works again until it expires. No Contrail tool edits config.json, and you must not edit it yourself.`;
  }
  if (phase === 'attach') {
    return `POLICY CHECK FAILED CLOSED — this call was not attached to the validation already running with these arguments, and it sent nothing. Contrail could not read the policies in config.json: ${problem}. That validation goes on and is checked again when it finishes — no approval is created while the file cannot be read; poll it by job_id to see its outcome. Until that file is fixed, no write can be proposed and no agent test run started on any connection (reads still work). No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly — do not try another route.`;
  }
  return `POLICY CHECK FAILED CLOSED — nothing was validated, proposed or sent. Contrail could not read the policies in config.json: ${problem}. Until that file is fixed, no write can be proposed and no agent test run started on any connection (reads still work). No Contrail tool edits config.json, and repairing it is the human's job — do not edit it yourself. Relay this message to them exactly — do not try another route.`;
}

type FreezeRef = Pick<PolicyFreeze, 'rule' | 'window' | 'until'>;

export function freezeBannerText(alias: string, f: FreezeRef): string {
  return `FREEZE — policy rule "${f.rule}" freezes changes to "${alias}" during "${f.window}" (until ${f.until}).`;
}

export function freezeProposeNote(alias: string, f: FreezeRef, surface: ApprovalSurfaceMode): string {
  const lead = `CHANGE FREEZE in effect — policy rule "${f.rule}" freezes changes to "${alias}" during "${f.window}" (until ${f.until}).`;
  if (surface === 'native') {
    return `${lead} The request is waiting in the app's Deploy Review screen, where, while the freeze lasts, Approve stays disabled until the human types an emergency reason. No Contrail tool can do that, and you must not do it for them or change the freeze yourself. Present the summary, tell the human a freeze is in effect and what it asks of them, then call the execute tool WITHOUT a confirmation code and wait for their decision. If the change can wait, say so.`;
  }
  return `${lead} The approval page shows NO confirmation code, and none was pushed to a phone. Releasing this request is the human's decision alone, at their desk, by typing an emergency reason on that page — the code appears there afterwards. No Contrail tool can do that, and you must not do it for them or change the freeze yourself. Present the summary, tell the human a freeze is in effect and what it asks of them, and wait. If the change can wait, say so: once the freeze has ended, reloading the page shows the code with no override, provided the code has not expired by then (otherwise propose again). If Contrail is restarted before then (a new session or a reconnect), the page closes and this request can no longer be released; propose it again only if the human asks.`;
}

/** The approval_page.note of a frozen request whose page could not be opened. */
export function freezePageNotOpenedText(): string {
  return 'The approval page could not be opened automatically. Its URL was written to the Contrail server log (stderr) for the human to open — it is deliberately NOT provided to you. Ask the human to open the Contrail log and visit the page; while the freeze lasts it shows no code until they type an emergency reason there.';
}

export function freezeExecuteRefusalText(
  alias: string,
  f: FreezeRef,
  surface: ApprovalSurfaceMode,
): string {
  const lead = `CHANGE FREEZE — not executed. Policy rule "${f.rule}" freezes changes to "${alias}" during "${f.window}" (until ${f.until}).`;
  if (surface === 'native') {
    return `${lead} Releasing this request is the human's decision alone, in the Contrail desktop app: Deploy Review asks for an emergency reason before Approve. No Contrail tool can record that reason, and you must not enter one or change the freeze yourself. Tell the human exactly this and wait — do not propose again or try another route.`;
  }
  return `${lead} The code was not used up. Releasing this request is the human's decision alone, at their desk: they reload the approval page, type an emergency reason there, and then the same code works. No Contrail tool can record that reason, and you must not enter one or change the freeze yourself. Tell the human exactly this and wait — do not try another route. If the approval page no longer loads (Contrail was restarted since this request was proposed), this request cannot be released while the freeze lasts; propose it again only if the human asks.`;
}

export function freezeStartRefusalText(alias: string, f: FreezeRef): string {
  return `CHANGE FREEZE — the test run was not started. Policy rule "${f.rule}" freezes changes to "${alias}" during "${f.window}" (until ${f.until}). A test run executes the agent's real actions and has no approval page on which the human could record an emergency reason, so Contrail starts none while the freeze lasts. Tell the human; the run can be started once the freeze has ended, or the test can be run in a sandbox instead.`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** HH:MM on this machine's wall clock. */
function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM-DD on this machine's wall clock. */
function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The policies-changed cue (approval page and Deploy Review), `at` an ISO instant. */
export function policyChangedText(at: string): string {
  return `Contrail noticed at ${localTime(at)} on ${localDate(at)} that the policies section of config.json had changed. The policies listed below are what applies now — a rule or freeze window that was removed is not shown. If you did not edit that file, do not approve this request.`;
}

/** Approval page and Deploy Review only — never stored, pushed or exported. */
export function unmatchedRuleText(name: string): string {
  return `Not applied to any connection on this machine: rule "${name}" — its label or org id matches none.`;
}

/** summary_json.governance.justification as stored (design §4.3). */
export interface StoredJustification {
  text: string;
  source: 'agent' | 'page';
  edited_at?: string;
  surface?: 'approval_page' | 'deploy_review';
  agent_draft?: string;
  confirmed_at?: string;
}

/** The provenance hint shown under the justification on the human's surfaces (never in the dossier). */
export function justificationProvenance(j: StoredJustification | null | undefined): string {
  if (!j || (j.source === 'agent' && j.text === '')) return 'None given.';
  if (j.source === 'agent') {
    return j.confirmed_at
      ? `Drafted by the agent; approved unchanged in Deploy Review at ${localTime(j.confirmed_at)}.`
      : 'Drafted by the agent. Edit it if it is not what you would say.';
  }
  const at = j.edited_at ? localTime(j.edited_at) : '--:--';
  const where = j.surface === 'deploy_review' ? 'in Deploy Review' : 'on the approval page';
  return j.text === '' ? `Cleared ${where} at ${at}.` : `Typed ${where} at ${at}.`;
}

export type ApprovalNoticeCode =
  | 'justification_saved'
  | 'justification_cleared'
  | 'justification_unchanged'
  | 'justification_required'
  | 'justification_too_long'
  | 'override_recorded'
  | 'override_too_short'
  | 'override_too_long'
  | 'override_not_needed'
  | 'override_already_recorded'
  | 'override_blocked'
  | 'request_closed'
  | 'invalid_text'
  | 'policies_unreadable';

/** The one-line notices the approval page shows after a POST (`?n=<code>`). */
export const APPROVAL_NOTICES: Record<ApprovalNoticeCode, { kind: 'success' | 'error'; text: string }> = {
  justification_saved: {
    kind: 'success',
    text: 'Justification saved. It is recorded as typed on this page.',
  },
  justification_cleared: {
    kind: 'success',
    text: 'Justification cleared. It is recorded as cleared on this page.',
  },
  justification_unchanged: {
    kind: 'success',
    text: 'No change — the justification is the same as before.',
  },
  justification_required: {
    kind: 'error',
    text: "This connection's policy requires a justification — it cannot be left empty. Nothing was changed.",
  },
  justification_too_long: {
    kind: 'error',
    text: 'The justification is limited to 1,000 characters. Nothing was changed.',
  },
  override_recorded: {
    kind: 'success',
    text: 'Emergency reason recorded. The confirmation code is shown below; the freeze itself stays configured.',
  },
  override_too_short: {
    kind: 'error',
    text: 'The emergency reason must be at least 15 characters. Nothing was recorded.',
  },
  override_too_long: {
    kind: 'error',
    text: 'The emergency reason is limited to 1,000 characters. Nothing was recorded.',
  },
  override_not_needed: {
    kind: 'success',
    text: 'No freeze is in effect for this request right now, so there is nothing to override.',
  },
  override_already_recorded: {
    kind: 'success',
    text: 'An emergency reason is already recorded for this request. Nothing was changed.',
  },
  override_blocked: {
    kind: 'error',
    text: 'This request is blocked by policy, so no emergency reason was recorded.',
  },
  request_closed: {
    kind: 'error',
    text: 'This request is no longer pending, so nothing was changed.',
  },
  invalid_text: {
    kind: 'error',
    text: 'The text contains control characters. Nothing was changed.',
  },
  policies_unreadable: {
    kind: 'error',
    text: 'Contrail could not read the policies in config.json, so nothing was recorded.',
  },
};

/** A view.warnings line on Apex pages when denyDataDeletes applies and anonymous Apex is allowed. */
export function apexDeletesNote(rule: string): string {
  return `POLICY NOTE — rule "${rule}" denies data deletes on this connection through dml_propose and bulk_load_propose. Contrail does not inspect anonymous Apex, so it cannot tell whether this script deletes records — read it.`;
}

export function dryRunPolicyNote(
  status: 'ok' | 'would_refuse' | 'unreadable',
  problem?: string,
): string {
  if (status === 'unreadable') {
    return `Dry run: Contrail could not read the policies in config.json (${problem ?? 'unknown problem'}), so none were evaluated. A real validation would be refused until the human fixes that file.`;
  }
  return 'Dry run: policies were evaluated and are reported here, not enforced. A real validation with these arguments would be refused for each entry in would_refuse.';
}

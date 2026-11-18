import { isValidComponentName, type StampSource } from './package.js';

/**
 * S46 D1: the stamp probe — the last-modified stamp of a CustomField,
 * ValidationRule, CustomLabel or ListView member, read by one small query
 * that names the package's own members instead of a listMetadata call that
 * enumerates the org's whole inventory of the type. validate_deploy and the
 * execute-time "target moved" guard both call readMemberStamps, so a member's
 * stamp comes from the same source at both ends; the source is recorded on
 * the frozen pre-image (stamp_source).
 *
 * Mirror unit: byte-identical in both repos. Pure — query text, the name
 * grammar, row mapping and a timeout. Imports only ./package.js: no REST
 * client, no SOAP client, no core/*. The one function that reaches the org
 * (StampQuery) is injected by the engine.
 *
 * Measured read-only on two dev orgs without a namespace (API v68.0,
 * 2026-11-17), and true for those orgs only: the four queries below were
 * accepted as written; the CustomField parent filter
 * (EntityDefinition.QualifiedApiName) answered for a standard and for a
 * custom object; a field that does not exist returned zero rows. Tooling
 * ValidationRule refused ORDER BY on the EntityDefinition path, and
 * TableEnumOrId held an id — not the name — for a custom object (filtering
 * it by name returned zero rows), so neither appears in any query here.
 *
 * NOT measured: an org that has its own namespace, and managed members. So
 * nothing filters on namespace in WHERE; NamespacePrefix is selected, and a
 * row is a member's stamp only when its namespace equals the one the
 * member's name carries. A row that carries a target's name under any other
 * namespace is never a stamp and is never dropped either: that target is
 * reported `unmatched`, which callers must treat as neither stamped nor
 * "no row".
 */

/** live_check.stamp_scheme — marks a request validated with this unit. */
export const STAMP_SCHEME = 2;
/** Targets per query. */
export const STAMP_QUERY_MAX_PAIRS = 20;
/** SOQL text per query, before URL encoding. */
export const STAMP_QUERY_MAX_CHARS = 3500;
/** The executor's row cap. */
export const STAMP_QUERY_MAX_ROWS = 200;
/** Validate-side bound (execute is bounded by the guard's deadline). */
export const STAMP_PROBE_TIMEOUT_MS = 30_000;

export const UNCHECKED_STAMP_QUERY_FAILED = 'stamp_query_failed_at_execute';
export const UNCHECKED_STAMP_NOT_PROBEABLE = 'stamp_not_probeable';
export const UNCHECKED_STAMP_SOURCE_MISMATCH = 'stamp_source_mismatch';
export const UNCHECKED_STAMP_ROW_UNMATCHED = 'stamp_row_unmatched';

/** A query named the member but gave it no stamp: zero rows, two rows, an unparseable date, or
 *  only a same-name row under another namespace. True in each of those cases. */
export const STAMP_NO_ROW_REASON = 'the stamp query returned no usable stamp for them';
/** No query named the member (a standard field, a name the grammar cannot place). */
export const STAMP_NOT_QUERIED_REASON = 'Contrail has no stamp query for them';

export function stampQueryFailedReason(reason: string): string {
  return `the stamp query failed: ${reason.slice(0, 160)}`;
}

export type StampQueryApi = 'tooling' | 'data';

/**
 * Runs ONE query and returns its records. Injected by the engine (RestClient);
 * a stub in tests.
 */
export type StampQuery = (
  api: StampQueryApi,
  soql: string,
  signal?: AbortSignal,
) => Promise<Array<Record<string, unknown>>>;

export interface StampMember {
  type: string;
  api_name: string;
}

export interface ProbeTarget extends StampMember {
  parent: string | null;
  name: string;
  namespace: string | null;
}

export type StampUnprobedReason = 'standard_field' | 'name_not_probeable';

export interface StampQueryPlan {
  type: string;
  source: StampSource;
  api: StampQueryApi;
  soql: string;
  targets: ProbeTarget[];
}

export interface MemberStamp {
  last_modified_date: string | null;
  last_modified_by: string | null;
}

export interface StampProbeResult {
  /** stampKey → the member's row. Only members whose row came back, from a type whose every
   *  query succeeded. */
  rows: Map<string, MemberStamp>;
  /** type → reason. Every member of the type is unread. */
  failed: Map<string, string>;
  /** stampKey → why no query named this member. */
  unprobed: Map<string, StampUnprobedReason>;
  /** stampKeys of queried members with no row of their own for which a query returned a row
   *  carrying their name under a namespace no target of that name in that query has. Such a row
   *  is never a stamp, and such a member is never "no row". */
  unmatched: Set<string>;
}

interface StampProbeSpec {
  source: Exclude<StampSource, 'listMetadata'>;
  api: StampQueryApi;
  sobject: string;
  nameColumn: string;
  /** null: the type has no parent (CustomLabel). */
  parentColumn: string | null;
  /** WHERE order inside one clause: the parent first (ListView), else the name first. */
  parentFirst: boolean;
}

/**
 * One row per probed member type. A Map, not an object literal: a type name
 * arrives from the package as any run of letters, and "constructor" must not
 * find a table row.
 */
const STAMP_PROBES = new Map<string, StampProbeSpec>([
  [
    'CustomField',
    {
      source: 'tooling:CustomField',
      api: 'tooling',
      sobject: 'CustomField',
      nameColumn: 'DeveloperName',
      parentColumn: 'EntityDefinition.QualifiedApiName',
      parentFirst: false,
    },
  ],
  [
    'ValidationRule',
    {
      source: 'tooling:ValidationRule',
      api: 'tooling',
      sobject: 'ValidationRule',
      nameColumn: 'ValidationName',
      parentColumn: 'EntityDefinition.QualifiedApiName',
      parentFirst: false,
    },
  ],
  [
    'CustomLabel',
    {
      source: 'tooling:ExternalString',
      api: 'tooling',
      sobject: 'ExternalString',
      nameColumn: 'Name',
      parentColumn: null,
      parentFirst: false,
    },
  ],
  [
    'ListView',
    {
      source: 'data:ListView',
      api: 'data',
      sobject: 'ListView',
      nameColumn: 'DeveloperName',
      parentColumn: 'SobjectType',
      parentFirst: true,
    },
  ],
]);

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The key rows, unprobed and unmatched are addressed by — the preImageKey format. */
export function stampKey(type: string, apiName: string): string {
  return `${type}:${apiName}`;
}

/** The probe table's source for a type; every other type is stamped by listMetadata. */
export function stampSourceFor(type: string): StampSource {
  return STAMP_PROBES.get(type)?.source ?? 'listMetadata';
}

export function stampSourceLabel(source: StampSource | undefined): string {
  switch (source) {
    case 'tooling:CustomField':
      return 'a Tooling query on CustomField';
    case 'tooling:ValidationRule':
      return 'a Tooling query on ValidationRule';
    case 'tooling:ExternalString':
      return 'a Tooling query on ExternalString';
    case 'data:ListView':
      return 'a query on ListView';
    default:
      return 'listMetadata';
  }
}

/** What Contrail read when it calls a member absent — named, never "the org has none". */
export function stampAbsenceEvidence(source: StampSource | undefined): string {
  if (source === undefined || source === 'listMetadata') {
    return 'listMetadata reports no such member';
  }
  return `the retrieve returned nothing for it and ${stampSourceLabel(source)} found no row`;
}

/**
 * Place one member in the name grammar: its parent, its developer name and
 * its namespace — or the reason no query can name it. Everything a query
 * embeds has matched IDENT, so no quote or backslash reaches SOQL (the
 * component grammar itself admits an apostrophe).
 */
export function planProbe(
  member: StampMember,
): { target: ProbeTarget } | { reason: StampUnprobedReason } {
  const spec = STAMP_PROBES.get(member.type);
  if (!spec || !isValidComponentName(member.type, member.api_name)) {
    return { reason: 'name_not_probeable' };
  }
  let parent: string | null = null;
  let child = member.api_name;
  if (spec.parentColumn !== null) {
    const dot = member.api_name.indexOf('.');
    if (dot < 0) return { reason: 'name_not_probeable' };
    parent = member.api_name.slice(0, dot);
    child = member.api_name.slice(dot + 1);
    if (parent === '' || child === '' || child.includes('.') || !IDENT.test(parent)) {
      return { reason: 'name_not_probeable' };
    }
  }
  let base = child;
  if (member.type === 'CustomField') {
    // A field whose name does not end in __c is a standard field: no stamp query names it.
    if (!/__c$/i.test(child)) return { reason: 'standard_field' };
    base = child.slice(0, -3);
  }
  if (!IDENT.test(base)) return { reason: 'name_not_probeable' };
  // A developer name cannot contain two consecutive underscores, so `__` can
  // only be the namespace separator.
  const i = base.indexOf('__');
  const namespace = i > 0 ? base.slice(0, i) : null;
  const name = i > 0 ? base.slice(i + 2) : base;
  if (!IDENT.test(name) || name.includes('__')) return { reason: 'name_not_probeable' };
  return { target: { type: member.type, api_name: member.api_name, parent, name, namespace } };
}

export function isProbeable(member: StampMember): boolean {
  return 'target' in planProbe(member);
}

/** Embeds a value in a SOQL string literal; the grammar above already excludes both characters. */
function lit(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function clauseFor(spec: StampProbeSpec, target: ProbeTarget): string {
  const name = `${spec.nameColumn} = '${lit(target.name)}'`;
  if (spec.parentColumn === null || target.parent === null) return name;
  const parent = `${spec.parentColumn} = '${lit(target.parent)}'`;
  return spec.parentFirst ? `(${parent} AND ${name})` : `(${name} AND ${parent})`;
}

function soqlFor(spec: StampProbeSpec, clauses: string[]): string {
  return (
    `SELECT Id, ${spec.nameColumn}, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name ` +
    `FROM ${spec.sobject} WHERE ${clauses.join(' OR ')}`
  );
}

/**
 * The queries for a member set. Members are deduplicated by stampKey; a
 * member whose type has no table row is ignored (callers pre-filter); a
 * member no query can name goes to `unprobed`. Targets fill, in input order,
 * the first query of their type that has room (STAMP_QUERY_MAX_PAIRS targets,
 * STAMP_QUERY_MAX_CHARS of SOQL) and holds no target of the same name on a
 * different parent — whatever the namespaces. The parent is filtered in WHERE
 * and is not selected, so that rule is what lets a returned row be read as
 * "this name, on this query's one parent for it". Targets of one parent that
 * differ only by namespace share one clause and are told apart by
 * NamespacePrefix.
 */
export function buildStampQueries(members: StampMember[]): {
  queries: StampQueryPlan[];
  unprobed: Array<StampMember & { reason: StampUnprobedReason }>;
} {
  const { planned, unprobed } = planQueries(members);
  return { queries: planned.map((q) => q.plan), unprobed };
}

interface PlannedQuery {
  spec: StampProbeSpec;
  plan: StampQueryPlan;
  clauses: string[];
}

function planQueries(members: StampMember[]): {
  planned: PlannedQuery[];
  unprobed: Array<StampMember & { reason: StampUnprobedReason }>;
} {
  const open: PlannedQuery[] = [];
  const unprobed: Array<StampMember & { reason: StampUnprobedReason }> = [];
  const seen = new Set<string>();
  for (const member of members) {
    const spec = STAMP_PROBES.get(member.type);
    if (!spec) continue;
    const key = stampKey(member.type, member.api_name);
    if (seen.has(key)) continue;
    seen.add(key);
    const planned = planProbe(member);
    if ('reason' in planned) {
      unprobed.push({ type: member.type, api_name: member.api_name, reason: planned.reason });
      continue;
    }
    const target = planned.target;
    const clause = clauseFor(spec, target);
    const lowered = target.name.toLowerCase();
    let placed = false;
    for (const q of open) {
      if (q.plan.type !== member.type) continue;
      if (q.plan.targets.length >= STAMP_QUERY_MAX_PAIRS) continue;
      const nameOnAnotherParent = q.plan.targets.some(
        (t) => t.name.toLowerCase() === lowered && t.parent !== target.parent,
      );
      if (nameOnAnotherParent) continue;
      const clauses = q.clauses.includes(clause) ? q.clauses : [...q.clauses, clause];
      const soql = soqlFor(spec, clauses);
      if (soql.length > STAMP_QUERY_MAX_CHARS) continue;
      q.clauses = clauses;
      q.plan.soql = soql;
      q.plan.targets.push(target);
      placed = true;
      break;
    }
    if (placed) continue;
    open.push({
      spec,
      clauses: [clause],
      plan: {
        type: member.type,
        source: spec.source,
        api: spec.api,
        soql: soqlFor(spec, [clause]),
        targets: [target],
      },
    });
  }
  return { planned: open, unprobed };
}

/**
 * A probe stamp in the `…000Z` form the listing uses, or null. Tooling and
 * the Data API write the zone as `+0000`; both ends compare as epoch ms.
 */
export function normalizeStamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(raw);
  if (!m) return null;
  const fraction = `${m[2] ?? ''}000`.slice(0, 3);
  const zone = m[3] ?? 'Z';
  const offset = zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${m[1]}.${fraction}${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function stampOf(row: Record<string, unknown>): MemberStamp {
  const by = row.LastModifiedBy;
  const name = by !== null && typeof by === 'object' ? (by as Record<string, unknown>).Name : null;
  return {
    last_modified_date: normalizeStamp(row.LastModifiedDate),
    last_modified_by: typeof name === 'string' && name !== '' ? name : null,
  };
}

/**
 * One query's rows → its targets. A row is a target's stamp only when the
 * name column AND the namespace match (both case-insensitive). A row that
 * carries a target's name under a namespace no target of that name has is
 * kept as evidence, not as a stamp: by the one-parent-per-name rule it sits
 * on that target's parent (or, for a label, carries that label's name), so it
 * may be the member itself under a namespace the package did not name, or
 * another component sharing the developer name — the row cannot say which.
 * A second row for one target nulls its stamp; the row still counts as there.
 */
function matchRows(
  plan: StampQueryPlan,
  nameColumn: string,
  records: Array<Record<string, unknown>>,
): { stamps: Map<string, MemberStamp>; unmatched: string[] } {
  const stamps = new Map<string, MemberStamp>();
  const seen = new Map<string, number>();
  const strangers = new Set<string>();
  for (const row of records) {
    if (row === null || typeof row !== 'object') continue;
    const rawName = row[nameColumn];
    if (typeof rawName !== 'string') continue;
    const rowName = rawName.toLowerCase();
    const named = plan.targets.filter((t) => t.name.toLowerCase() === rowName);
    // A name no target carries cannot come back from these WHERE clauses.
    if (named.length === 0) continue;
    const rowNs = typeof row.NamespacePrefix === 'string' ? row.NamespacePrefix.toLowerCase() : '';
    const own = named.filter((t) => (t.namespace ?? '').toLowerCase() === rowNs);
    if (own.length === 0) {
      strangers.add(rowName);
      continue;
    }
    for (const t of own) {
      const key = stampKey(t.type, t.api_name);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      stamps.set(
        key,
        count === 1 ? stampOf(row) : { last_modified_date: null, last_modified_by: null },
      );
    }
  }
  const unmatched: string[] = [];
  for (const t of plan.targets) {
    const key = stampKey(t.type, t.api_name);
    if (strangers.has(t.name.toLowerCase()) && !stamps.has(key)) unmatched.push(key);
  }
  return { stamps, unmatched };
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message || err.name : String(err);
  return text.slice(0, 300);
}

function timeoutReason(timeoutMs: number): string {
  const span = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
  return `no answer within ${span}`;
}

/**
 * Read the stamps of a member set: plan the queries, run them all at once
 * through the injected executor, map the rows. Never throws. A failure is
 * per TYPE and never a fallback — one failed query fails its whole type
 * (every member of it unread, the rows and unmatched entries its other
 * queries produced discarded) and leaves the other types' rows alone.
 *
 * `opts.signal` already aborted: every planned type fails with `cancelled`
 * and nothing is issued. Otherwise each query is raced against the abort, so
 * an executor that ignores its signal cannot hold this function open; the
 * executor is handed a signal that aborts on the caller's abort AND on
 * `opts.timeoutMs`.
 */
export async function readMemberStamps(
  query: StampQuery,
  members: StampMember[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<StampProbeResult> {
  const result: StampProbeResult = {
    rows: new Map(),
    failed: new Map(),
    unprobed: new Map(),
    unmatched: new Set(),
  };
  const { planned, unprobed } = planQueries(members);
  for (const u of unprobed) result.unprobed.set(stampKey(u.type, u.api_name), u.reason);
  if (planned.length === 0) return result;
  if (opts?.signal?.aborted) {
    for (const q of planned) result.failed.set(q.plan.type, 'cancelled');
    return result;
  }

  const ctl = new AbortController();
  let abortReason = 'cancelled';
  let settleAborted: (reason: string) => void = () => {};
  const aborted = new Promise<string>((resolve) => {
    settleAborted = resolve;
  });
  const abort = (reason: string): void => {
    if (ctl.signal.aborted) return;
    abortReason = reason;
    ctl.abort();
    settleAborted(reason);
  };
  const onCallerAbort = (): void => abort('cancelled');
  opts?.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutMs = opts?.timeoutMs;
  const timer =
    timeoutMs !== undefined && Number.isFinite(timeoutMs)
      ? setTimeout(() => abort(timeoutReason(timeoutMs)), Math.max(0, timeoutMs))
      : undefined;

  type Outcome = { records: Array<Record<string, unknown>> } | { reason: string };
  const run = async (plan: StampQueryPlan): Promise<Outcome> => {
    try {
      const records = await query(plan.api, plan.soql, ctl.signal);
      if (!Array.isArray(records)) return { reason: 'the query returned no record list' };
      return { records };
    } catch (err) {
      return { reason: ctl.signal.aborted ? abortReason : errorText(err) };
    }
  };
  let answers: Array<{ q: PlannedQuery; outcome: Outcome }>;
  try {
    answers = await Promise.all(
      planned.map(async (q) => ({
        q,
        outcome: await Promise.race([
          run(q.plan),
          aborted.then((reason): Outcome => ({ reason })),
        ]),
      })),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onCallerAbort);
  }

  const matched: Array<{ type: string } & ReturnType<typeof matchRows>> = [];
  for (const { q, outcome } of answers) {
    const type = q.plan.type;
    if (result.failed.has(type)) continue;
    if ('reason' in outcome) {
      result.failed.set(type, outcome.reason);
      continue;
    }
    try {
      matched.push({ type, ...matchRows(q.plan, q.spec.nameColumn, outcome.records) });
    } catch (err) {
      result.failed.set(type, errorText(err));
    }
  }
  for (const m of matched) {
    if (result.failed.has(m.type)) continue;
    for (const [key, stamp] of m.stamps) result.rows.set(key, stamp);
    for (const key of m.unmatched) result.unmatched.add(key);
  }
  return result;
}

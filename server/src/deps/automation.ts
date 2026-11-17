import type { ContrailDb } from '../core/db.js';
import type { SnapshotStore } from '../snapshot/store.js';
import { extractChildBlocks } from '../snapshot/indexer.js';
import { queryDependencies } from './graph.js';

/**
 * S45 F3: what fires when records of one object are written — read from the
 * LOCAL SNAPSHOT, never the live org. The automation card on DML, bulk and
 * anonymous-Apex approval pages and S46's get_object_automation both come from
 * collectObjectAutomation; formatAutomationLines is the ONE text source for
 * the page, the desktop card and the tool result.
 *
 * Mirror unit: byte-identical in both repos. Imports only other mirror units —
 * core/db.ts and snapshot/store.ts as TYPES only (the graph.ts precedent) —
 * never core/paths.ts or core/config.ts.
 *
 * Parsing is the regex-block / tagValue idiom of the desktop's flowgraph.ts
 * (not parseXml), so this card and the desktop's flow diagram read the same
 * facts from the same bytes.
 *
 * Honesty rules the shapes carry:
 *  - Flows are classified on the start element's triggerType, never on
 *    processType (scheduled and record-triggered flows both carry
 *    AutoLaunchedFlow). Only RecordBeforeSave / RecordAfterSave /
 *    RecordBeforeDelete flows on the object are "record-triggered", and only
 *    they (with triggers and validation rules) decide the empty-state line.
 *  - Every Flow row is read — once per snapshot, memoized per connection — and
 *    bucketed by object here. Never edgesTo/searchArtifacts: those sets carry
 *    every flow that merely looks a record up (and prefix matches), so a cap
 *    over them could drop the one record-triggered flow that matters. Past the
 *    file cap the card says how many files it read and drops the empty line:
 *    it never asserts an absence it did not check.
 *  - The Metadata API serves a flow's LATEST version, so every flow status here
 *    is the latest version's — never "the active version".
 *  - collectObjectAutomation never throws: every section is caught into notes.
 */

/** Hard cap on flow files read per snapshot pass (one approval page). */
export const AUTOMATION_FLOW_FILE_CAP = 2000;

/** Active record-triggered flows that get the one-hop subflow/Apex fan-out. */
const FANOUT_FLOWS = 10;
/** Callees named per flow. */
const FANOUT_CALLS = 5;

/** Always on the card, under "Not visible in the snapshot:". */
export const NOT_COVERED: readonly string[] = [
  'Workflow rules and email alerts (Workflow is not snapshotted)',
  'Assignment, escalation, auto-response, duplicate and matching rules',
  'Managed-package automation (hidden or namespaced code)',
  'Dynamic Apex, and anything invoked indirectly — Apex called from the flows and triggers above is named, not expanded',
  'Anything added or changed in the org since the snapshot date above',
  "Older flow versions — the snapshot holds each flow's latest version; a flow shown as Draft or Obsolete may still have an older active version",
];

/** The start element's facts (plus the flow's own label/status/processType). */
export interface FlowStart {
  label: string | null;
  /** The flow file's top-level <status> — the LATEST version's status. */
  status: string | null;
  process_type: string | null;
  object: string | null;
  trigger_type: string | null;
  record_trigger_type: string | null;
  /** Entry conditions (<filters> blocks or a <filterFormula>) are present. */
  entry_criteria: boolean;
  scheduled_paths: number;
  /** Scheduled flows: the start element's <schedule>. */
  schedule: { frequency: string | null; start_date: string | null } | null;
  /**
   * Process Builder: the <stringValue> of the top-level processMetadataValues
   * block named ObjectType. UNVERIFIED (no fixture from a real org) — rows
   * built from it are labelled best-effort.
   */
  process_object: string | null;
}

export interface TriggerHeader {
  name: string;
  object: string;
  /** Normalised, e.g. ['before insert', 'after update']. */
  events: string[];
}

export interface AutomationFlow {
  name: string;
  label: string | null;
  status: string | null;
  trigger_type: string | null;
  record_trigger_type: string | null;
  entry_criteria: boolean;
  scheduled_paths: number;
  /** One hop of the local dependency graph: subflows and Apex classes it uses. */
  calls: Array<{ type: string; name: string }>;
}

export interface ObjectAutomation {
  object: string;
  /** ISO retrievedAt of the snapshot rows behind this answer; null when none. */
  snapshot_at: string | null;
  /**
   * The OLDEST retrievedAt of the snapshot's Flow rows and ApexTrigger rows
   * the card read (null when there are none). A refresh limited to some
   * types leaves them older than snapshot_at; the card then says so.
   */
  source_dates: { flows: string | null; triggers: string | null };
  /** Active record-triggered flows on the object (latest version Active). */
  flows: AutomationFlow[];
  /** Scheduled flows on the object, any status — they run on a schedule, not on save. */
  scheduled_flows: Array<{
    name: string;
    status: string | null;
    frequency: string | null;
    start_date: string | null;
  }>;
  /** Platform-event-triggered flows — only when the object IS the event. */
  event_flows: Array<{ name: string; status: string | null; event: string }>;
  triggers: Array<{
    name: string;
    status: 'Active' | 'Inactive' | 'unknown';
    events: string[];
    /** Whether triggers/<name>.trigger-meta.xml was in the snapshot. */
    meta_xml: boolean;
  }>;
  validation_rules: Array<{ name: string; active: boolean; error_condition?: string }>;
  processes: Array<{ name: string; status: string | null; object_source: 'processMetadataValues' }>;
  /** Record-triggered flows on the object whose latest version is not Active. */
  inactive_flow_count: number;
  flow_files_read: number;
  flow_files_total: number;
  /**
   * Sources this answer depends on that could not be read (no object file, a
   * trigger whose header did not parse, a failed section). Non-empty → the
   * empty-state line is withheld; `notes` say why.
   */
  unread_sources: string[];
  not_covered: string[];
  notes: string[];
  summary_lines: string[];
}

// ── parsing (flowgraph.ts idiom) ─────────────────────────────────────────

function tagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

/** tagValue, empty → null, the five XML entities decoded (display text only). */
function textValue(block: string, tag: string): string | null {
  const raw = tagValue(block, tag);
  if (!raw) return null;
  return raw
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Element blocks stripped before reading the flow's OWN label/status/
 * processType/processMetadataValues — every canvas element carries a <label>,
 * and Process Builder elements carry processMetadataValues of their own.
 */
const NON_TOP_LEVEL_BLOCKS = [
  'actionCalls',
  'apexPluginCalls',
  'assignments',
  'choices',
  'collectionProcessors',
  'constants',
  'customErrors',
  'decisions',
  'dynamicChoiceSets',
  'formulas',
  'loops',
  'orchestratedStages',
  'recordCreates',
  'recordDeletes',
  'recordLookups',
  'recordRollbacks',
  'recordUpdates',
  'screens',
  'stages',
  'start',
  'steps',
  'subflows',
  'textTemplates',
  'transforms',
  'variables',
  'waits',
];

function stripBlocks(xml: string, tags: string[]): string {
  let out = xml;
  for (const tag of tags) out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  return out;
}

export function parseFlowStart(xml: string): FlowStart {
  const outer = stripBlocks(xml, NON_TOP_LEVEL_BLOCKS);
  let processObject: string | null = null;
  for (const block of extractChildBlocks(outer, 'processMetadataValues')) {
    if (tagValue(block, 'name') === 'ObjectType') {
      processObject = textValue(block, 'stringValue');
      break;
    }
  }
  const start = extractChildBlocks(xml, 'start')[0] ?? null;
  // The start element's own tags, read with its nested blocks removed.
  const own = start
    ? stripBlocks(start, ['scheduledPaths', 'filters', 'schedule', 'connector'])
    : '';
  const schedule = start ? (extractChildBlocks(start, 'schedule')[0] ?? null) : null;
  return {
    label: textValue(outer, 'label'),
    status: textValue(outer, 'status'),
    process_type: textValue(outer, 'processType'),
    object: start ? textValue(own, 'object') : null,
    trigger_type: start ? textValue(own, 'triggerType') : null,
    record_trigger_type: start ? textValue(own, 'recordTriggerType') : null,
    entry_criteria: start
      ? extractChildBlocks(start, 'filters').length > 0 || textValue(own, 'filterFormula') !== null
      : false,
    scheduled_paths: start ? extractChildBlocks(start, 'scheduledPaths').length : 0,
    schedule: schedule
      ? {
          frequency: textValue(schedule, 'frequency'),
          start_date: textValue(schedule, 'startDate'),
        }
      : null,
    process_object: processObject,
  };
}

/**
 * Comments stripped before the header regex — a local copy of the two comment
 * passes of extract.ts's stripApexNoise (unexported there). Block comments go
 * through a LINEAR scan, behaviour-identical to the lazy `/\/\*[\s\S]*?\*\//g`
 * it replaces: that regex re-scanned to the end of the body for every `/*`
 * with no closing `*\/` after it — quadratic on a valid 1,000,000-character
 * trigger. An unclosed `/*` leaves the rest of the body untouched, exactly as
 * the regex did.
 */
function stripApexNoise(body: string): string {
  let out = '';
  let last = 0;
  let i = body.indexOf('/*');
  while (i !== -1) {
    const end = body.indexOf('*/', i + 2);
    if (end === -1) break;
    out += body.slice(last, i) + ' ';
    last = end + 2;
    i = body.indexOf('/*', last);
  }
  return (out + body.slice(last)).replace(/\/\/[^\n]*/g, ' ');
}

export function parseTriggerHeader(body: string): TriggerHeader | null {
  const m = stripApexNoise(body).match(/\btrigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/i);
  if (!m) return null;
  return {
    name: m[1]!,
    object: m[2]!,
    events: m[3]!
      .split(',')
      .map((e) => e.trim().replace(/\s+/g, ' ').toLowerCase())
      .filter(Boolean),
  };
}

/** Types that are never an sObject: primitives, collections, system classes (lowercase). */
const APEX_NON_SOBJECT_TYPES = new Set(
  (
    'string integer long decimal double boolean date datetime time id blob object sobject ' +
    'list set map void database system schema test json jsonparser jsongenerator math limits ' +
    'userinfo messaging http httprequest httpresponse savepoint type pattern matcher crypto ' +
    'encodingutil url pagereference apexpages search'
  ).split(' '),
);

/** Words the declaration regex can mistake for a type (`return a;`, `insert a;`). */
const APEX_KEYWORDS = new Set(
  (
    'return new else throw insert update upsert delete undelete merge final static public ' +
    'private global protected transient virtual abstract override with without inherited ' +
    'sharing class interface enum extends implements this super null true false if for while ' +
    'do try catch finally break continue instanceof select from where and or not in like ' +
    'limit order by group having as on when switch trigger get'
  ).split(' '),
);

/**
 * Objects an anonymous Apex script MAY touch, parsed from its text: `new X(`,
 * static SOQL `FROM X` (subqueries' relationship names skipped),
 * `Database.<dml>(v)` and bare `insert v` / `update v` / … with `v` resolved
 * through the script's own declarations. Primitives, collections,
 * `*Exception`, system classes, classes the script declares and the
 * snapshot's Apex classes (`knownApexClasses`) are excluded. Comments and
 * string literals are blanked first, so dynamic SOQL is invisible here — the
 * page says so. Every distinct object, first-appearance order,
 * case-insensitive dedupe (a 200-name safety bound); the approval card covers
 * the first 10 and names the rest.
 */
export function parseApexObjectTargets(
  script: string,
  knownApexClasses: Iterable<string>,
): string[] {
  // Comments and string literals blanked in ONE left-to-right pass, so a `//`
  // inside a string (an endpoint URL) or a `/*` in a literal cannot swallow
  // the code after it.
  const text = script.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\]|\\.)*'/g, (m) =>
    m.startsWith("'") ? "''" : ' ',
  );
  const known = new Set<string>();
  for (const c of knownApexClasses) known.add(c.toLowerCase());
  for (const m of text.matchAll(/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/gi)) {
    known.add(m[1]!.toLowerCase());
  }
  const candidate = (name: string | undefined): string | null => {
    if (!name || !/^[A-Za-z]\w*$/.test(name)) return null;
    const lower = name.toLowerCase();
    if (APEX_NON_SOBJECT_TYPES.has(lower) || APEX_KEYWORDS.has(lower)) return null;
    if (lower.endsWith('exception') || known.has(lower)) return null;
    return name;
  };

  // Variable declarations: `Account a`, `Account[] arr`, `List<Account> xs`, `Set<Account> s`.
  const declared = new Map<string, string>();
  for (const m of text.matchAll(
    /\b(?:(?:List|Set)\s*<\s*([A-Za-z_]\w*)\s*>|([A-Za-z_]\w*)(?:\s*\[\s*\])?)\s+([A-Za-z_]\w*)\s*(?=[=;,):])/g,
  )) {
    const type = m[1] ?? m[2];
    const name = m[3]!.toLowerCase();
    if (!type || APEX_KEYWORDS.has(type.toLowerCase()) || declared.has(name)) continue;
    declared.set(name, type);
  }

  const found: Array<{ at: number; name: string }> = [];
  for (const m of text.matchAll(/\bnew\s+([A-Za-z_]\w*)\s*\(/g)) {
    found.push({ at: m.index ?? 0, name: m[1]! });
  }
  for (const m of text.matchAll(/\[\s*SELECT\b[\s\S]*?\]/gi)) {
    let soql = m[0];
    // Every parenthesised group, innermost first — subqueries (they name
    // relationships, not objects), semi-joins, function calls, IN lists — so
    // the FROM left standing is the outer query's.
    for (let prev = ''; prev !== soql; ) {
      prev = soql;
      soql = soql.replace(/\([^()]*\)/g, ' ');
    }
    const from = soql.match(/\bFROM\s+([A-Za-z_]\w*)/i);
    if (from) found.push({ at: m.index ?? 0, name: from[1]! });
  }
  for (const m of text.matchAll(
    /\bDatabase\s*\.\s*(?:insert|update|upsert|delete|undelete|merge)\s*\(\s*([A-Za-z_]\w*)/gi,
  )) {
    const v = declared.get(m[1]!.toLowerCase());
    if (v) found.push({ at: m.index ?? 0, name: v });
  }
  for (const m of text.matchAll(
    /\b(?:insert|update|upsert|delete|undelete|merge)\s+([A-Za-z_]\w*)(?=[\s;,])/gi,
  )) {
    const v = declared.get(m[1]!.toLowerCase());
    if (v) found.push({ at: m.index ?? 0, name: v });
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const name = candidate(f.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    // A page-size safety bound only — the card covers the first 10 and
    // names the rest.
    if (out.length === APEX_TARGETS_MAX) break;
  }
  return out;
}

/** parseApexObjectTargets' safety bound (the approval card itself covers 10). */
const APEX_TARGETS_MAX = 200;

// ── one snapshot pass, memoized ──────────────────────────────────────────

interface FlowFacts {
  name: string;
  retrieved_at: string;
  start: FlowStart;
}

interface TriggerFacts {
  name: string;
  retrieved_at: string;
  /** null: the body was missing or its header did not parse. */
  header: TriggerHeader | null;
  status: 'Active' | 'Inactive' | 'unknown';
  meta_xml: boolean;
  /** The sidecar's <status> when it was neither Active nor Inactive. */
  raw_status: string | null;
  /** Why the body or sidecar could not be read (the store threw). */
  read_error: string | null;
}

interface AutomationIndex {
  flows: FlowFacts[];
  flow_files_total: number;
  flow_files_read: number;
  /** The oldest retrievedAt among the Flow rows / ApexTrigger rows; null when none. */
  oldest_flow_at: string | null;
  oldest_trigger_at: string | null;
  /** Flow files within the cap that could not be read or parsed. */
  unread_flows: string[];
  triggers: TriggerFacts[];
  /** Sections of the pass that failed outright. */
  errors: string[];
}

/**
 * Memo: one pass per connection per snapshot — keyed by the store instance and
 * the connection, invalidated when the Flow/ApexTrigger rows' count or newest
 * retrievedAt changes (every refresh re-stamps what it retrieved). The up-to-10
 * objects one approval page asks about share a single read of every flow file.
 */
const MEMO = new WeakMap<
  SnapshotStore,
  Map<string, { signature: string; index: AutomationIndex }>
>();

/** One snapshot index row (core/types.ts ArtifactRecord, reached through ContrailDb). */
type ArtifactRow = ReturnType<ContrailDb['listArtifacts']>[number];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newest(rows: ArtifactRow[]): string {
  let max = '';
  for (const r of rows) if (r.retrievedAt > max) max = r.retrievedAt;
  return max;
}

function oldest(rows: ArtifactRow[]): string | null {
  let min: string | null = null;
  for (const r of rows) if (min === null || r.retrievedAt < min) min = r.retrievedAt;
  return min;
}

function automationIndex(
  db: ContrailDb,
  store: SnapshotStore,
  connectionId: string,
  cap: number,
): AutomationIndex {
  const errors: string[] = [];
  let flowRows: ArtifactRow[] = [];
  let triggerRows: ArtifactRow[] = [];
  try {
    flowRows = db.listArtifacts(connectionId, 'Flow');
  } catch (err) {
    errors.push(`the snapshot's Flow rows could not be listed (${message(err)})`);
  }
  try {
    triggerRows = db.listArtifacts(connectionId, 'ApexTrigger');
  } catch (err) {
    errors.push(`the snapshot's ApexTrigger rows could not be listed (${message(err)})`);
  }
  const signature = JSON.stringify([
    cap,
    flowRows.length,
    newest(flowRows),
    oldest(flowRows),
    triggerRows.length,
    newest(triggerRows),
    oldest(triggerRows),
    errors.length,
  ]);
  let perStore = MEMO.get(store);
  if (!perStore) {
    perStore = new Map();
    MEMO.set(store, perStore);
  }
  const memo = perStore.get(connectionId);
  if (memo && memo.signature === signature) return memo.index;

  const index: AutomationIndex = {
    flows: [],
    flow_files_total: flowRows.length,
    flow_files_read: 0,
    oldest_flow_at: oldest(flowRows),
    oldest_trigger_at: oldest(triggerRows),
    unread_flows: [],
    triggers: [],
    errors,
  };
  let threw = false;
  for (const row of flowRows.slice(0, cap)) {
    try {
      const xml = store.readCurrentFile(connectionId, row.filePath ?? `flows/${row.apiName}.flow`);
      if (xml === null) {
        index.unread_flows.push(row.apiName);
        continue;
      }
      index.flows.push({
        name: row.apiName,
        retrieved_at: row.retrievedAt,
        start: parseFlowStart(xml),
      });
      index.flow_files_read += 1;
    } catch {
      index.unread_flows.push(row.apiName);
      threw = true;
    }
  }
  for (const row of triggerRows) {
    const facts: TriggerFacts = {
      name: row.apiName,
      retrieved_at: row.retrievedAt,
      header: null,
      status: 'unknown',
      meta_xml: false,
      raw_status: null,
      read_error: null,
    };
    try {
      const body = store.readCurrentFile(
        connectionId,
        row.filePath ?? `triggers/${row.apiName}.trigger`,
      );
      facts.header = body === null ? null : parseTriggerHeader(body);
      // Exactly the engine's metaXmlFromSnapshot path: the indexer skips the
      // sidecar, but the snapshot store keeps every retrieved file.
      const meta = store.readCurrentFile(connectionId, `triggers/${row.apiName}.trigger-meta.xml`);
      if (meta !== null) {
        facts.meta_xml = true;
        const status = textValue(meta, 'status');
        if (status === 'Active' || status === 'Inactive') facts.status = status;
        else facts.raw_status = status;
      }
    } catch (err) {
      facts.read_error = message(err);
      threw = true;
    }
    index.triggers.push(facts);
  }
  // A pass where the store or the index THREW is not remembered (the next
  // call retries); a file simply absent from the snapshot is its state.
  if (errors.length === 0 && !threw) perStore.set(connectionId, { signature, index });
  else perStore.delete(connectionId);
  return index;
}

// ── per object ───────────────────────────────────────────────────────────

const RECORD_TRIGGER_TYPES = new Set([
  'RecordBeforeSave',
  'RecordAfterSave',
  'RecordBeforeDelete',
]);
const PROCESS_BUILDER_TYPES = new Set(['Workflow', 'InvocableProcess']);

/** A platform event (`__e`) or a standard *Event sObject — what a PlatformEvent flow starts on. */
function isEventObject(object: string): boolean {
  const lower = object.toLowerCase();
  return lower.endsWith('__e') || (lower.endsWith('event') && lower !== 'event');
}

function same(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function collectObjectAutomation(input: {
  db: ContrailDb;
  store: SnapshotStore;
  connectionId: string;
  object: string;
  /** Flow files read per pass; default AUTOMATION_FLOW_FILE_CAP. */
  maxFlowFiles?: number;
}): ObjectAutomation {
  const { db, store, connectionId, object } = input;
  const a: ObjectAutomation = {
    object,
    snapshot_at: null,
    source_dates: { flows: null, triggers: null },
    flows: [],
    scheduled_flows: [],
    event_flows: [],
    triggers: [],
    validation_rules: [],
    processes: [],
    inactive_flow_count: 0,
    flow_files_read: 0,
    flow_files_total: 0,
    unread_sources: [],
    not_covered: [...NOT_COVERED],
    notes: [],
    summary_lines: [],
  };
  const finish = (): ObjectAutomation => {
    try {
      a.summary_lines = formatAutomationLines(a);
    } catch (err) {
      a.notes.push(`The card's lines could not be composed (${message(err)}).`);
    }
    return a;
  };

  if (!/^[A-Za-z0-9_]+$/.test(object)) {
    a.unread_sources.push('everything (not an object API name)');
    a.notes.push('Not an object API name — nothing was read for it.');
    return finish();
  }
  try {
    if (Object.keys(db.countArtifactsByType(connectionId)).length === 0) {
      a.unread_sources.push('the snapshot (none exists for this connection)');
      a.notes.push(
        'This connection has no metadata snapshot — nothing was read. Run refresh_snapshot first.',
      );
      return finish();
    }
  } catch (err) {
    a.unread_sources.push('the snapshot index');
    a.notes.push(`The snapshot index could not be read (${message(err)}).`);
    return finish();
  }

  // Flows and Process Builder processes: every file of the memoized pass.
  let index: AutomationIndex | null = null;
  const onObject: FlowFacts[] = [];
  try {
    const cap = input.maxFlowFiles ?? AUTOMATION_FLOW_FILE_CAP;
    index = automationIndex(db, store, connectionId, cap);
    a.flow_files_total = index.flow_files_total;
    a.flow_files_read = index.flow_files_read;
    a.source_dates = { flows: index.oldest_flow_at, triggers: index.oldest_trigger_at };
    for (const e of index.errors) {
      a.unread_sources.push(e);
      a.notes.push(`Not read: ${e}.`);
    }
    if (index.unread_flows.length > 0) {
      const shown = index.unread_flows.slice(0, 5).join(', ');
      const more = index.unread_flows.length > 5 ? ', …' : '';
      a.notes.push(
        `${index.unread_flows.length} flow file(s) listed in the snapshot index could not be ` +
          `read: ${shown}${more}.`,
      );
    }
    for (const f of index.flows) {
      const s = f.start;
      if (s.process_type && PROCESS_BUILDER_TYPES.has(s.process_type)) {
        if (same(s.process_object, object)) {
          onObject.push(f);
          a.processes.push({
            name: f.name,
            status: s.status,
            object_source: 'processMetadataValues',
          });
        }
        continue;
      }
      if (!same(s.object, object)) continue;
      onObject.push(f);
      const type = s.trigger_type;
      if (type && RECORD_TRIGGER_TYPES.has(type)) {
        if (s.status === 'Active') {
          a.flows.push({
            name: f.name,
            label: s.label,
            status: s.status,
            trigger_type: type,
            record_trigger_type: s.record_trigger_type,
            entry_criteria: s.entry_criteria,
            scheduled_paths: s.scheduled_paths,
            calls: [],
          });
        } else {
          a.inactive_flow_count += 1;
        }
      } else if (type === 'Scheduled') {
        a.scheduled_flows.push({
          name: f.name,
          status: s.status,
          frequency: s.schedule?.frequency ?? null,
          start_date: s.schedule?.start_date ?? null,
        });
      } else if (type === 'PlatformEvent') {
        if (isEventObject(object)) {
          a.event_flows.push({ name: f.name, status: s.status, event: s.object ?? object });
        } else {
          a.notes.push(
            `Flow ${f.name} names ${object} with trigger type PlatformEvent, but ${object} ` +
              'is not named like an event (no __e suffix, not a standard *Event) — not listed.',
          );
        }
      } else {
        a.notes.push(
          `Flow ${f.name} starts on ${object} with trigger type ${type ?? '(none)'}, which this ` +
            'card does not classify — not listed.',
        );
      }
    }
  } catch (err) {
    a.unread_sources.push('flows');
    a.notes.push(`The snapshot's flows could not be read (${message(err)}).`);
  }

  // One hop of fan-out for the first active record-triggered flows.
  for (const flow of a.flows.slice(0, FANOUT_FLOWS)) {
    try {
      flow.calls = queryDependencies(db, connectionId, 'Flow', flow.name, 'uses', 1)
        .nodes.filter((n) => n.depth === 1 && (n.type === 'Flow' || n.type === 'ApexClass'))
        .slice(0, FANOUT_CALLS)
        .map((n) => ({ type: n.type, name: n.name }));
    } catch (err) {
      a.notes.push(`What flow ${flow.name} calls could not be read (${message(err)}).`);
    }
  }
  if (a.flows.length > FANOUT_FLOWS) {
    a.notes.push(`Called subflows/Apex are named for the first ${FANOUT_FLOWS} active flows only.`);
  }

  // Apex triggers on the object.
  const triggersOnObject: TriggerFacts[] = [];
  if (index) {
    for (const t of index.triggers) {
      if (t.header === null) {
        a.unread_sources.push(`trigger ${t.name}`);
        a.notes.push(
          t.read_error !== null
            ? `Trigger ${t.name} could not be read (${t.read_error}), so the object it fires on ` +
                'is unknown — not listed.'
            : `Trigger ${t.name}: its body is missing from the snapshot or its header did not ` +
                'parse, so the object it fires on is unknown — not listed.',
        );
        continue;
      }
      if (!same(t.header.object, object)) continue;
      triggersOnObject.push(t);
      a.triggers.push({
        name: t.name,
        status: t.status,
        // A copy: the header belongs to the memoized pass later pages share.
        events: [...t.header.events],
        meta_xml: t.meta_xml,
      });
      if (t.status === 'unknown' && t.meta_xml) {
        a.notes.push(
          `Trigger ${t.name}: trigger-meta.xml gives status ${t.raw_status ?? '(none)'}, not ` +
            'Active or Inactive.',
        );
      }
    }
  }

  // Validation rules: the object file, once.
  let objectRow: ArtifactRow | null = null;
  try {
    objectRow = db.getArtifact(connectionId, 'CustomObject', object);
    const rel = objectRow?.filePath ?? `objects/${objectRow?.apiName ?? object}.object`;
    const xml = store.readCurrentFile(connectionId, rel);
    if (xml === null) {
      a.unread_sources.push(rel);
      a.notes.push(
        `The snapshot holds no object file for ${object} (${rel}), so its validation rules were ` +
          'not read — this card cannot say whether any exist.',
      );
    } else {
      for (const block of extractChildBlocks(xml, 'validationRules')) {
        const name = textValue(block, 'fullName');
        if (!name) continue;
        const formula = textValue(block, 'errorConditionFormula');
        a.validation_rules.push({
          name,
          active: tagValue(block, 'active') === 'true',
          ...(formula
            ? { error_condition: formula.length > 200 ? `${formula.slice(0, 199)}…` : formula }
            : {}),
        });
      }
    }
  } catch (err) {
    a.unread_sources.push('validation rules');
    a.notes.push(`${object}'s validation rules could not be read (${message(err)}).`);
  }

  // Dated only by rows ABOUT this object — its CustomObject row, else a flow
  // on it, else a trigger on it. Never an unrelated flow's retrievedAt: a
  // partial refresh can leave the object's rows older than the newest flow
  // file, and the card must not borrow a date it did not read.
  a.snapshot_at =
    objectRow?.retrievedAt ??
    onObject[0]?.retrieved_at ??
    triggersOnObject[0]?.retrieved_at ??
    null;
  if (a.snapshot_at === null) {
    a.notes.push(
      `Nothing read from the snapshot (object row, flows, triggers) is about ${object}, so ` +
        'this card has no snapshot date.',
    );
  }
  return finish();
}

// ── the one text source ──────────────────────────────────────────────────

const WHEN: Record<string, string> = {
  RecordBeforeSave: 'before save',
  RecordAfterSave: 'after save',
  RecordBeforeDelete: 'before delete',
};
const ON: Record<string, string> = {
  Create: 'on create',
  Update: 'on update',
  CreateAndUpdate: 'on create or update',
  Delete: 'on delete',
};

function eventsText(events: string[]): string {
  return events.length > 0 ? ` · ${events.join(', ')}` : '';
}

/**
 * The card's lines for one object — the ONE text source for the approval
 * page, the desktop card and get_object_automation. The heading and the
 * "Not visible in the snapshot:" list are the surfaces' own.
 */
export function formatAutomationLines(a: ObjectAutomation): string[] {
  const lines: string[] = [];
  for (const f of a.flows) {
    const how = [
      'record-triggered',
      f.trigger_type ? (WHEN[f.trigger_type] ?? f.trigger_type) : null,
      f.record_trigger_type ? (ON[f.record_trigger_type] ?? `on ${f.record_trigger_type}`) : null,
    ]
      .filter(Boolean)
      .join(', ');
    const parts = [
      `Flow ${f.name} — ${f.status ?? 'Active'}`,
      how,
      `entry criteria: ${f.entry_criteria ? 'yes' : 'no'}`,
    ];
    if (f.scheduled_paths > 0) parts.push(`scheduled paths: ${f.scheduled_paths}`);
    if (f.calls.length > 0) {
      const callees = f.calls.map((c) => `${c.type === 'ApexClass' ? 'Apex' : c.type} ${c.name}`);
      parts.push(`calls ${callees.join(', ')}`);
    }
    lines.push(parts.join(' · '));
  }
  for (const s of a.scheduled_flows) {
    lines.push(
      `Flow ${s.name} — ${s.status ?? 'status unknown'} · scheduled ` +
        `(${s.frequency ?? 'unknown frequency'} from ` +
        `${s.start_date ?? 'an unknown start date'}) — runs on a schedule, not on save`,
    );
  }
  for (const e of a.event_flows) {
    lines.push(
      `Flow ${e.name} — ${e.status ?? 'status unknown'} · platform-event-triggered — fires when ` +
        `${e.event} is published`,
    );
  }
  for (const t of a.triggers) {
    const status =
      t.status !== 'unknown'
        ? t.status
        : t.meta_xml
          ? 'status unknown'
          : 'status unknown (no trigger-meta.xml in the snapshot)';
    lines.push(`Trigger ${t.name} — ${status}${eventsText(t.events)}`);
  }
  const activeRules = a.validation_rules.filter((r) => r.active);
  for (const r of activeRules) lines.push(`Validation rule ${r.name} — active`);
  const inactiveRules = a.validation_rules.length - activeRules.length;
  if (inactiveRules > 0) lines.push(`${inactiveRules} inactive validation rules not listed`);
  for (const p of a.processes) {
    if (p.status !== 'Active') continue;
    lines.push(
      `Process (Process Builder) ${p.name} — Active · object read from processMetadataValues ` +
        '(best-effort, unverified)',
    );
  }
  if (a.inactive_flow_count > 0) {
    lines.push(
      `${a.inactive_flow_count} other record-triggered flows on ${a.object} are not Active ` +
        'in the snapshot (latest version Draft, Obsolete, InvalidDraft or UnderReview)',
    );
  }
  const truncated = a.flow_files_read < a.flow_files_total;
  if (truncated) {
    lines.push(
      `Only ${a.flow_files_read} of ${a.flow_files_total} flow files were read; the flow list ` +
        'above may be incomplete',
    );
  }
  // The heading's date is the object's own row; a refresh limited to some
  // types can leave the flow and trigger rows older — say so, so the card
  // (and any absence it states) is not read as current to a date it is not.
  const snapMs = a.snapshot_at !== null ? Date.parse(a.snapshot_at) : NaN;
  const olderThanHeading = (d: string | null | undefined): d is string =>
    typeof d === 'string' && !Number.isNaN(snapMs) && Date.parse(d) < snapMs;
  const dates = a.source_dates ?? { flows: null, triggers: null };
  const olderFlows = olderThanHeading(dates.flows) ? dates.flows : null;
  const olderTriggers = olderThanHeading(dates.triggers) ? dates.triggers : null;
  if (olderFlows !== null || olderTriggers !== null) {
    const which =
      olderFlows !== null && olderTriggers !== null
        ? `Flows in the snapshot were last retrieved ${olderFlows} and Apex triggers ` +
          `${olderTriggers}`
        : olderFlows !== null
          ? `Flows in the snapshot were last retrieved ${olderFlows}`
          : `Apex triggers in the snapshot were last retrieved ${olderTriggers}`;
    lines.push(
      `${which} — earlier than the date above; anything added or changed in the org since ` +
        'then is not visible either.',
    );
  }
  const nothing =
    a.flows.length === 0 &&
    a.triggers.every((t) => t.status === 'Inactive') &&
    activeRules.length === 0;
  if (nothing && !truncated && a.unread_sources.length === 0) {
    lines.push(
      'No active record-triggered flows, Apex triggers, or validation rules for ' +
        `${a.object} in the snapshot.`,
    );
  }
  return lines;
}

import { asArray, parseXml } from '../salesforce/xml.js';

/**
 * Semantic diff over snapshot artifacts (spec §4 diff_orgs / diff_artifact).
 * XML metadata diffs structurally — keyed collections (fields, flow elements)
 * match by fullName/name so a reordered file is not a "change" — and Apex
 * diffs by line. Pure functions; direction is always A ("from") → B ("to"):
 * added = present only in B.
 */

export type Change =
  | { kind: 'scalar'; path: string; a: unknown; b: unknown }
  | { kind: 'added'; path: string; key: string }
  | { kind: 'removed'; path: string; key: string }
  | { kind: 'unkeyed'; path: string; note: string };

export interface XmlSemanticDiff {
  identical: boolean;
  root: string;
  changes: Change[];
  change_count: number;
  truncated: boolean;
}

export interface TextHunk {
  a_line: number;
  b_line: number;
  removed: string[];
  added: string[];
  removed_truncated?: boolean;
  added_truncated?: boolean;
}

export interface TextDiff {
  identical: boolean;
  lines_a: number;
  lines_b: number;
  lines_added: number;
  lines_removed: number;
  hunks: TextHunk[];
  hunks_truncated: boolean;
  /** True when the files were too large for hunk extraction (counts only). */
  counts_only: boolean;
}

export interface ArtifactSemanticDiff {
  format: 'xml' | 'text';
  identical: boolean;
  xml?: XmlSemanticDiff;
  text?: TextDiff;
}

/**
 * Output-size caps, overridable per caller: the defaults are sized for agent
 * tool results (token budgets), while a UI reading from local disk can afford
 * far larger listings. MAX_LCS_CELLS is a memory guard, not a display cap,
 * and is deliberately not configurable.
 */
export interface DiffLimits {
  maxChanges?: number;
  maxHunks?: number;
  maxHunkLines?: number;
  maxLineChars?: number;
  maxHunkBudgetChars?: number;
}

const MAX_CHANGES = 200;
const MAX_HUNKS = 50;
const MAX_HUNK_LINES = 40;
const MAX_LINE_CHARS = 500;
const MAX_HUNK_BUDGET_CHARS = 100_000;
const MAX_LCS_CELLS = 4_000_000;

export function semanticDiff(
  aContent: string,
  bContent: string,
  limits: DiffLimits = {},
): ArtifactSemanticDiff {
  if (aContent === bContent) {
    return { format: looksLikeXml(aContent) ? 'xml' : 'text', identical: true };
  }
  if (looksLikeXml(aContent) && looksLikeXml(bContent)) {
    const xml = diffXml(aContent, bContent, limits);
    if (xml) return { format: 'xml', identical: xml.identical, xml };
    // Unparseable on either side — fall through to text.
  }
  const text = diffText(aContent, bContent, limits);
  return { format: 'text', identical: text.identical, text };
}

function looksLikeXml(content: string): boolean {
  const t = content.trimStart();
  // S36: a bundle concatenation ("<!-- contrail:file … -->" framing) starts
  // with '<' and the lenient XML parser accepts it WITHOUT throwing — while
  // silently dropping every non-XML file (JS, CSS, JSON) and comparing only
  // the first root element's subtree. That made sibling-file drift
  // invisible to diff_artifact, so bundle content diffs as TEXT, always.
  if (t.startsWith('<!-- contrail:file ')) return false;
  return t.startsWith('<');
}

// ── XML structural diff ──────────────────────────────────────────────────

export function diffXml(
  aXml: string,
  bXml: string,
  limits: DiffLimits = {},
): XmlSemanticDiff | null {
  let aDoc: Record<string, unknown>;
  let bDoc: Record<string, unknown>;
  try {
    aDoc = parseXml(aXml);
    bDoc = parseXml(bXml);
  } catch {
    return null;
  }
  const aRoot = rootElement(aDoc);
  const bRoot = rootElement(bDoc);
  if (!aRoot || !bRoot) return null;

  const maxChanges = limits.maxChanges ?? MAX_CHANGES;
  const changes: Change[] = [];
  const state = { truncated: false, maxChanges };
  diffNode(aRoot.value, bRoot.value, '', changes, state);
  return {
    identical: changes.length === 0,
    root: aRoot.name,
    changes: changes.slice(0, maxChanges),
    change_count: changes.length,
    truncated: state.truncated || changes.length > maxChanges,
  };
}

function rootElement(doc: Record<string, unknown>): { name: string; value: unknown } | null {
  const keys = Object.keys(doc).filter((k) => k !== '?xml');
  const name = keys[0];
  if (!name) return null;
  return { name, value: doc[name] };
}

function diffNode(
  a: unknown,
  b: unknown,
  path: string,
  changes: Change[],
  state: { truncated: boolean; maxChanges: number },
): void {
  if (changes.length > state.maxChanges) {
    state.truncated = true;
    return;
  }
  if (deepEqual(a, b)) return;

  if (Array.isArray(a) || Array.isArray(b)) {
    diffCollection(asArray(a), asArray(b), path, changes, state);
    return;
  }
  // A single-item XML list parses as a plain object; route keyed items
  // through the collection diff — including when one side is missing — so a
  // renamed or added/removed child reads as removed+added, never as a
  // scalar JSON blob.
  const aKeyed = isObject(a) && itemKey(a) !== null;
  const bKeyed = isObject(b) && itemKey(b) !== null;
  if ((aKeyed || bKeyed) && (a == null || isObject(a)) && (b == null || isObject(b))) {
    diffCollection(a == null ? [] : [a], b == null ? [] : [b], path, changes, state);
    return;
  }
  if (isObject(a) && isObject(b)) {
    diffObjectFields(a, b, path, changes, state);
    return;
  }
  // One side an object, the other scalar/missing — or plain scalar change.
  changes.push({ kind: 'scalar', path, a: summarize(a), b: summarize(b) });
}

function diffObjectFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
  changes: Change[],
  state: { truncated: boolean; maxChanges: number },
): void {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    diffNode(a[key], b[key], path ? `${path}.${key}` : key, changes, state);
  }
}

function diffCollection(
  a: unknown[],
  b: unknown[],
  path: string,
  changes: Change[],
  state: { truncated: boolean; maxChanges: number },
): void {
  const aKeyed = keyItems(a);
  const bKeyed = keyItems(b);
  if (!aKeyed || !bKeyed) {
    changes.push({
      kind: 'unkeyed',
      path,
      note: `list changed (${a.length} → ${b.length} items; no stable key to match on)`,
    });
    return;
  }
  for (const [key, aItem] of aKeyed) {
    const bItem = bKeyed.get(key);
    if (bItem === undefined) {
      changes.push({ kind: 'removed', path, key });
    } else if (isObject(aItem) && isObject(bItem)) {
      // Field-level recursion directly — going back through diffNode would
      // re-detect these as keyed single items and loop.
      diffObjectFields(aItem, bItem, `${path}[${key}]`, changes, state);
    } else {
      diffNode(aItem, bItem, `${path}[${key}]`, changes, state);
    }
  }
  for (const key of bKeyed.keys()) {
    if (!aKeyed.has(key)) changes.push({ kind: 'added', path, key });
  }
}

/** Salesforce metadata list items key on fullName (containers) or name (flow elements). */
function keyItems(items: unknown[]): Map<string, unknown> | null {
  const map = new Map<string, unknown>();
  for (const item of items) {
    if (!isObject(item)) return null;
    const key = itemKey(item);
    if (key === null) return null;
    map.set(key, item);
  }
  return map;
}

/**
 * Key fields in priority order: fullName/name cover containers and flow
 * elements; the rest are the documented key elements of permission metadata
 * (fieldPermissions key on field, objectPermissions on object, …) — without
 * them, permission-set diffs collapse into useless "unkeyed list" notes.
 */
const ITEM_KEY_FIELDS = [
  'fullName',
  'name',
  'field',
  'object',
  'apexClass',
  'apexPage',
  'flow',
  'tab',
  'recordType',
  'application',
  'layout',
] as const;

function itemKey(item: Record<string, unknown>): string | null {
  for (const f of ITEM_KEY_FIELDS) {
    const v = item[f];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function summarize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`;
  if (isObject(value) || Array.isArray(value)) {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 200)}…` : JSON.parse(json);
  }
  return value;
}

// ── text (Apex) line diff ────────────────────────────────────────────────

export function diffText(aText: string, bText: string, limits: DiffLimits = {}): TextDiff {
  const maxHunks = limits.maxHunks ?? MAX_HUNKS;
  const maxHunkLines = limits.maxHunkLines ?? MAX_HUNK_LINES;
  const maxLineChars = limits.maxLineChars ?? MAX_LINE_CHARS;
  const maxHunkBudgetChars = limits.maxHunkBudgetChars ?? MAX_HUNK_BUDGET_CHARS;
  const aLines = aText.split('\n');
  const bLines = bText.split('\n');
  if (aText === bText) {
    return {
      identical: true,
      lines_a: aLines.length,
      lines_b: bLines.length,
      lines_added: 0,
      lines_removed: 0,
      hunks: [],
      hunks_truncated: false,
      counts_only: false,
    };
  }

  // Trim the common prefix/suffix — most edits are local, and this keeps the
  // LCS table small for big files.
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) {
    start++;
  }
  let aEnd = aLines.length;
  let bEnd = bLines.length;
  while (aEnd > start && bEnd > start && aLines[aEnd - 1] === bLines[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const aMid = aLines.slice(start, aEnd);
  const bMid = bLines.slice(start, bEnd);

  if (aMid.length * bMid.length > MAX_LCS_CELLS) {
    const aSet = countLines(aMid);
    const bSet = countLines(bMid);
    let removed = 0;
    for (const [line, n] of aSet) removed += Math.max(0, n - (bSet.get(line) ?? 0));
    let added = 0;
    for (const [line, n] of bSet) added += Math.max(0, n - (aSet.get(line) ?? 0));
    return {
      identical: false,
      lines_a: aLines.length,
      lines_b: bLines.length,
      lines_added: added,
      lines_removed: removed,
      hunks: [],
      hunks_truncated: false,
      counts_only: true,
    };
  }

  const ops = lcsOps(aMid, bMid);
  const hunks: TextHunk[] = [];
  let current: TextHunk | null = null;
  let ai = 0;
  let bi = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'same') {
      current = null;
      ai++;
      bi++;
      continue;
    }
    if (!current) {
      current = { a_line: start + ai + 1, b_line: start + bi + 1, removed: [], added: [] };
      hunks.push(current);
    }
    if (op === 'del') {
      removed++;
      if (current.removed.length < maxHunkLines)
        current.removed.push(clampLine(aMid[ai] ?? '', maxLineChars));
      else current.removed_truncated = true;
      ai++;
    } else {
      added++;
      if (current.added.length < maxHunkLines)
        current.added.push(clampLine(bMid[bi] ?? '', maxLineChars));
      else current.added_truncated = true;
      bi++;
    }
  }
  // Overall character budget — a minified static resource must not blow out
  // the response even inside per-line and per-hunk caps.
  let budget = maxHunkBudgetChars;
  let kept = 0;
  for (const h of hunks) {
    budget -= [...h.removed, ...h.added].reduce((n, l) => n + l.length + 1, 0);
    if (budget < 0) break;
    kept++;
  }
  const cappedHunks = hunks.slice(0, Math.min(kept, maxHunks));
  return {
    identical: false,
    lines_a: aLines.length,
    lines_b: bLines.length,
    lines_added: added,
    lines_removed: removed,
    hunks: cappedHunks,
    hunks_truncated: cappedHunks.length < hunks.length,
    counts_only: false,
  };
}

function clampLine(line: string, maxLineChars: number): string {
  return line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line;
}

function countLines(lines: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l, (map.get(l) ?? 0) + 1);
  return map;
}

/** Classic LCS DP → edit script of 'same' | 'del' | 'add' ops. */
function lcsOps(a: string[], b: string[]): Array<'same' | 'del' | 'add'> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Array<'same' | 'del' | 'add'> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('same');
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push('del');
      i++;
    } else {
      ops.push('add');
      j++;
    }
  }
  while (i < n) {
    ops.push('del');
    i++;
  }
  while (j < m) {
    ops.push('add');
    j++;
  }
  return ops;
}

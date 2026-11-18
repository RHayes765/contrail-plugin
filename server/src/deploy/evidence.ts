import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalPageOptions, ApprovalRowDiff } from '../connect/pages.js';
import type { PolicySource, StoredJustification } from '../core/policy.js';

/**
 * S46 (B): the change-evidence dossier — what Contrail validated, proposed
 * and executed, as it recorded it on this machine, written for the human to
 * hand on. A byte-identical mirror unit: it imports only node built-ins and
 * types from other mirror units, never the database, paths or config, so
 * both engines build the same record from the same rows.
 *
 * The first half is pure and is called at every mint: codeFreePageView
 * stores what the approval page showed (summary_json.page_view) without the
 * confirmation code, without diff bodies and without record field values.
 * The second half builds the dossier (buildEvidence, pure) and writes it
 * (exportChangeEvidence, through plain functions the caller hands in).
 * Nothing here ever reads a request's code: no type in this unit has a field
 * for one, and every stored value is read by its key name.
 */

/** One row of the stored page view: a page row copied by name, its diff reduced to the summary. */
export interface StoredPageRow {
  label: string;
  warnings: string[];
  /** Absent on data-change rows, and on Apex rows, which carry detail_sha256 / detail_chars. */
  detail?: string;
  /** Apex rows: the script's fingerprint, in place of the script. */
  detail_sha256?: string;
  detail_chars?: number;
  /** The diff's summary line and counts; the hunks and value changes are never stored. */
  diff?: {
    summary: string;
    baseline_label: string;
    identical: boolean;
    counts: StoredDiffCounts | null;
    truncated: boolean;
  };
}

export interface StoredDiffCounts {
  changes?: number;
  lines_added?: number;
  lines_removed?: number;
  files_changed?: string[];
  files_added?: string[];
  files_removed?: string[];
}

/** summary_json.page_view: what the approval page showed at mint, code-free. */
export interface StoredPageView {
  v: 1;
  kind: ApprovalPageOptions['kind'];
  org: { alias: string; org_name: string | null; org_type: string; instance_url: string };
  expires_at: string;
  warnings: string[];
  destructive: StoredPageRow[];
  changes: StoredPageRow[];
  automation: Array<{
    object: string;
    snapshot_at: string | null;
    summary_lines: string[];
    notes: string[];
    not_covered: string[];
  }>;
  automation_not_covered: string[];
  results: Array<{ label: string; value: string; bad?: boolean }>;
  blast: string[];
}

type PageRow = ApprovalPageOptions['changes'][number];

/**
 * A row label fit for the record. Data-change labels carry the record's
 * field values after the first colon (`UPDATE Account 001…: Name: "Old" →
 * "New"`); the record keeps the operation, object and record id before it.
 * Every other kind's label is returned unchanged.
 */
export function redactRowLabel(kind: ApprovalPageOptions['kind'], label: string): string {
  if (kind !== 'dml') return label;
  const colon = label.indexOf(':');
  return colon === -1 ? label : label.slice(0, colon).trim();
}

function copyCounts(c: ApprovalRowDiff['counts']): StoredDiffCounts | null {
  if (!c) return null;
  const out: StoredDiffCounts = {};
  if (c.changes !== undefined) out.changes = c.changes;
  if (c.lines_added !== undefined) out.lines_added = c.lines_added;
  if (c.lines_removed !== undefined) out.lines_removed = c.lines_removed;
  if (c.files_changed !== undefined) out.files_changed = c.files_changed.slice();
  if (c.files_added !== undefined) out.files_added = c.files_added.slice();
  if (c.files_removed !== undefined) out.files_removed = c.files_removed.slice();
  return out;
}

function storedRow(kind: ApprovalPageOptions['kind'], r: PageRow): StoredPageRow {
  const row: StoredPageRow = {
    label: redactRowLabel(kind, r.label),
    warnings: r.warnings.slice(),
  };
  if (r.detail !== undefined) {
    if (kind === 'apex') {
      // The script itself stays in the request's payload; the record keeps
      // its fingerprint, so it can be matched without being reproduced.
      row.detail_sha256 = crypto.createHash('sha256').update(r.detail).digest('hex');
      row.detail_chars = r.detail.length;
    } else if (kind !== 'dml') {
      row.detail = r.detail;
    }
  }
  if (r.diff) {
    row.diff = {
      summary: r.diff.summary,
      baseline_label: r.diff.baseline_label,
      identical: r.diff.identical,
      counts: copyCounts(r.diff.counts),
      truncated: r.diff.truncated,
    };
  }
  return row;
}

/**
 * The page view a request stores at mint. Every key is copied by name —
 * never a spread of the view, and `view.code` is never read — so nothing
 * added to the page options later reaches the record by accident.
 */
export function codeFreePageView(view: ApprovalPageOptions): StoredPageView {
  const kind = view.kind;
  return {
    v: 1,
    kind,
    org: {
      alias: view.org.alias,
      org_name: view.org.orgName,
      org_type: view.org.orgType,
      instance_url: view.org.instanceUrl,
    },
    expires_at: view.expiresAt,
    warnings: (view.warnings ?? []).slice(),
    destructive: view.destructive.map((r) => storedRow(kind, r)),
    changes: view.changes.map((r) => storedRow(kind, r)),
    automation: (view.automation ?? []).map((a) => ({
      object: a.object,
      snapshot_at: a.snapshot_at,
      summary_lines: a.summary_lines.slice(),
      notes: a.notes.slice(),
      not_covered: a.not_covered.slice(),
    })),
    automation_not_covered: (view.automationNotCovered ?? []).slice(),
    results: view.results.map((r) => {
      const out: StoredPageView['results'][number] = { label: r.label, value: r.value };
      if (r.bad !== undefined) out.bad = r.bad;
      return out;
    }),
    blast: view.blast.slice(),
  };
}

// ── the dossier ──────────────────────────────────────────────────────────

/** A connection's org and the Salesforce user it was logged in as. */
export interface EvidenceIdentity {
  alias: string;
  org_id: string;
  org_name: string | null;
  org_type: string;
  username: string | null;
}

/** The desktop's Deploy Review decision on a request (the plugin has none). */
export interface EvidenceDecision {
  state: string;
  at: string | null;
  comment: string | null;
  comment_source: string | null;
}

/**
 * One audit row as Contrail stored it. buildEvidence reduces `detail` to
 * EVIDENCE_DETAIL_KEYS before anything is written.
 */
export interface EvidenceEvent {
  ts: string;
  event_type: string;
  tool: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  /** Policy refusals: the label of the connection the row names, as it is now (null when removed). */
  connection?: string | null;
}

/** One request as the dossier receives it — no field for a confirmation code. */
export interface EvidenceRow {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  validation_id: string | null;
  /** summary_json.governance.target: the connection as it was when the request was minted. */
  target_at_proposal: EvidenceIdentity | null;
  /** summary_json.governance.execute_check: the connection as it was at the claim. */
  target_at_execution: { org_id: string; username: string | null } | null;
  /** Today's connection row — null when the connection has been removed. */
  connection_now: EvidenceIdentity | null;
  /** summary_json, parsed. Read by named keys only. */
  summary: unknown;
  /** result_json, parsed (null until the request reached a terminal outcome). */
  result: unknown;
  /** payload_json as evidencePayload reduced it. */
  payload: unknown;
  decision?: EvidenceDecision;
  /** Audit rows that name this request, oldest first. */
  events: EvidenceEvent[];
  events_truncated: boolean;
}

/** The filters as the dossier prints them (null = not given). */
export interface EvidenceFilterView {
  connection: string | null;
  ticket: string | null;
  request_id: string | null;
  since: string | null;
  until: string | null;
}

/** Whether the policies could be read when the dossier was written. */
export interface EvidencePolicyStatus {
  status: 'ok' | 'unreadable';
  source?: PolicySource;
  sha256?: string;
}

export interface EvidenceInput {
  generated_at: string;
  engine_version: string;
  surface: 'plugin' | 'desktop';
  filters: EvidenceFilterView;
  requests: EvidenceRow[];
  /** policy.refused rows that name no request, oldest first. */
  refusals: EvidenceEvent[];
  refusals_truncated: boolean;
  policies: EvidencePolicyStatus;
  /** More requests matched than the dossier holds (it keeps the newest EVIDENCE_MAX_REQUESTS). */
  truncated: boolean;
  /**
   * A ticket search stopped at EVIDENCE_SCAN_MAX_ROWS rows: an older request
   * recorded with the ticket would not be listed. Contrail knows only that
   * the scan stopped, not whether such a request exists.
   */
  scan_cut: boolean;
}

export interface EvidenceCounts {
  requests: number;
  by_status: Record<string, number>;
  audit_events: number;
  policy_refusals: number;
}

/** An audit row in the dossier: detail reduced to the allow-list. */
export interface EvidenceEventEntry {
  ts: string;
  event_type: string;
  tool: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  connection?: string | null;
}

/** One deploy member's validate-time pre-image, by the keys the dossier names. */
export interface EvidencePreImage {
  type: string;
  api_name: string;
  change: string | null;
  present: boolean | null;
  sha256: string | null;
  last_modified_date: string | null;
  last_modified_by: string | null;
  source: string | null;
  stamp_source: string | null;
}

/** The stored page view as the dossier prints it (StoredPageView, re-read by name). */
export type EvidencePageView = Omit<StoredPageView, 'kind'> & { kind: string };

export interface EvidenceRequestEntry {
  id: string;
  kind: string;
  status: string;
  proposed_at: string;
  expires_at: string;
  executed_at: string | null;
  validation_id: string | null;
  org_and_user: {
    at_proposal: EvidenceIdentity | null;
    at_execution: { org_id: string; username: string | null } | null;
    at_execution_differs: boolean;
    /** Only for a request with no recorded identity: the connection as it is now. */
    connection_now: EvidenceIdentity | null;
    /** The label printed when the identity was not recorded with the request. */
    label: string | null;
  };
  ticket: string | null;
  justification: { text: string | null; record: string; agent_draft: string | null };
  policy_at_proposal: {
    evaluated_at: string | null;
    source: string | null;
    sha256: string | null;
    rules: string[];
    lines: string[];
  } | null;
  policy_at_proposal_note: string | null;
  freeze_at_proposal: { rule: string; window: string; until: string; time_zone: string | null } | null;
  freeze_override: {
    reason: string;
    at: string | null;
    surface: string | null;
    rule: string | null;
    window: string | null;
  } | null;
  execute_check: {
    at: string | null;
    rules: string[];
    freeze_active: boolean | null;
    overridden: boolean | null;
    org_id: string | null;
    username: string | null;
  } | null;
  execute_check_note: string | null;
  /**
   * For a request never executed: the newest execute the policy re-check
   * refused (its policy.refused audit row, phase execute), else null.
   */
  execute_refusal: { at: string; reason: string | null } | null;
  policy_checks: string;
  decision: {
    state: string;
    at: string | null;
    comment: string | null;
    comment_source: string | null;
    comment_label: string;
  } | null;
  page_view: EvidencePageView | null;
  page_view_note: string | null;
  inputs: Record<string, unknown> | null;
  pre_images: EvidencePreImage[];
  live_check: {
    status: string | null;
    at: string | null;
    dates_unavailable_types: string[];
    stamp_scheme: number | null;
    probe_unmatched: string[];
    probe_failure_types: string[];
  } | null;
  target_check: Record<string, unknown> | null;
  org_result: Record<string, unknown> | null;
  revert: {
    package: {
      dir: string | null;
      plan: string | null;
      outcome: string | null;
      restores: number;
      deletes: number;
      not_restorable: number;
    } | null;
    note: string | null;
  } | null;
  audit_events: EvidenceEventEntry[];
  audit_events_truncated: boolean;
}

/** evidence.json. */
export interface EvidenceDossier {
  v: 1;
  generated_at: string;
  engine_version: string;
  surface: string;
  about: string;
  filters: EvidenceFilterView;
  policies_now: { status: string; source: string | null; sha256: string | null };
  counts: EvidenceCounts;
  /**
   * Any list in this dossier was cut or may be incomplete: the requests, a
   * ticket search that stopped at its row limit, a request's audit events,
   * or the refusals.
   */
  truncated: boolean;
  requests_truncated: boolean;
  requests_scan_cut: boolean;
  requests: EvidenceRequestEntry[];
  policy_refusals: EvidenceEventEntry[];
  policy_refusals_truncated: boolean;
}

/** At most this many requests in one dossier (the newest). */
export const EVIDENCE_MAX_REQUESTS = 200;
/** Requests are read this many rows at a time. */
export const EVIDENCE_PAGE_ROWS = 1000;
/** A ticket search reads at most this many requests. */
export const EVIDENCE_SCAN_MAX_ROWS = 20_000;
/** At most this many audit rows per request, and policy refusals per query (the newest). */
export const EVIDENCE_MAX_EVENTS = 1000;

/**
 * The audit-detail keys the dossier keeps. Everything else — free-text
 * details, error messages, a request's governance block, anything added
 * later — is dropped. origin … duration_ms are the snapshot re-read's
 * counts; comment and comment_source are the desktop's approval row.
 */
export const EVIDENCE_DETAIL_KEYS = [
  'requestId',
  'kind',
  'phase',
  'reason',
  'attempts_remaining',
  'rule',
  'window',
  'until',
  'surface',
  'rules',
  'violations',
  'validationId',
  'deployId',
  'status',
  'components',
  'deletions',
  'testLevel',
  'componentsDeployed',
  'rows',
  'failures',
  'operation',
  'object',
  'steps',
  'operations',
  'totalRows',
  'lines',
  'chars',
  'agent',
  'version',
  'from',
  'to',
  'method',
  'codeIncluded',
  'freeze',
  'cause',
  'count',
  'comment',
  'comment_source',
  'dryRun',
  'had_agent_draft',
  'origin',
  'refreshed',
  'removed',
  'skipped',
  'units',
  'duration_ms',
] as const;

const EVIDENCE_ABOUT =
  'What this is: a record of what Contrail validated, proposed and executed, as Contrail ' +
  "recorded it on this machine at the time. What it is not: a statement of the org's current " +
  'state, or of changes made outside Contrail. "Acting user" is the Salesforce user the ' +
  'connection was logged in as when the request was proposed, and when it executed where that ' +
  'was recorded — Contrail does not know which person was at the keyboard. Confirmation codes ' +
  'are never included. Record field values are not included: data-change rows are reduced to ' +
  'operation, object and record id, scripts and CSV files to fingerprints, and failure messages ' +
  "to their status codes; the full text stays in Contrail's local database.";

const AUDIT_LISTED =
  'Listed: audit rows that name this request. Supersession by a newer validation is recorded ' +
  'per connection with a count only, not per request, and is not listed — the status above is ' +
  'what Contrail stored.';

const NOW_LABEL =
  'Org and acting user as the connection is now — not recorded when this request was made';

const PAGE_VIEW_OLDER =
  'Approval-page summary: not recorded (this request was created by a Contrail older than 0.40.0).';
const PAGE_VIEW_MISSING = 'Approval-page summary: not recorded.';
const POLICY_OLDER =
  'Policies at proposal: not checked — this request was created by a Contrail older than ' +
  '0.40.0, which does not evaluate policies or freeze windows.';
const EXECUTE_CHECK_OLDER =
  'Policy re-check at execution: not recorded — Contrail 0.40.0 and later record it before ' +
  'executing, so this request was executed by an older Contrail on this machine, which does not ' +
  'check policies or freeze windows.';
const EXECUTE_CHECK_NOT_RUN = 'Policy re-check at execution: not applicable (not executed).';
const EXECUTE_CHECK_REFUSED = 'Policy re-check at execution: refused — not executed.';
const ORG_RESULT_EXECUTING =
  'Not recorded — the request was claimed for execution (status executing) and Contrail has ' +
  'stored no outcome: the write may still be running, or may have committed if the Contrail ' +
  'process running it stopped. Check the org.';

const KNOWN_KINDS = new Set(['deploy', 'dml', 'apex', 'bulk', 'activation']);
const EXECUTED_STATUSES = new Set(['executing', 'executed', 'execution_failed']);

// ── reading stored JSON by name ──────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asStrList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function lengthOf(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A stored instant, re-formatted by this unit (null when it is not a time). */
function isoOf(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function sha256Of(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Copies the named scalar keys of each object in a list. */
function scalarsOf(list: unknown, keys: readonly string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(list)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of list) {
    const o = asObj(item);
    if (!o) continue;
    const copy: Record<string, unknown> = {};
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' || typeof v === 'boolean' || asNum(v) !== null) copy[k] = v;
    }
    out.push(copy);
  }
  return out;
}

/** What stands in for a stored reason that is not a code. */
const REASON_LEFT_OUT = "free text, left out (it stays in Contrail's local database)";
/** What stands in for the reason the execute-time target check's org read failed. */
const TARGET_CHECK_READ_FAILED = "the org read failed (the message stays in Contrail's local database)";

/**
 * A stored reason as the dossier prints it: a code (`no_baseline`,
 * `stamp_query_failed_at_execute`, …), or the target check's own deadline
 * sentence, rebuilt here from its number. Anything else can be the org's or
 * the transport's error text (the target check's fail-open reason is the
 * error's message), so `leftOut`, a fixed text, stands in for it.
 */
function reasonText(v: string, leftOut: string): string {
  if (/^[a-z][a-z0-9_]{0,63}$/.test(v)) return v;
  const deadline = /^the org did not answer within (\d{1,6}) s$/.exec(v);
  return deadline ? `the org did not answer within ${Number(deadline[1])} s` : leftOut;
}

/**
 * An audit row's detail, reduced to EVIDENCE_DETAIL_KEYS (values copied as
 * JSON). `reason` is kept only as a code: deploy.target_check_unavailable
 * stores the failed org read's message there.
 */
export function reduceAuditDetail(
  detail: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const key of EVIDENCE_DETAIL_KEYS) {
    if (!Object.hasOwn(detail, key)) continue;
    const v = detail[key];
    if (v === undefined) continue;
    if (key === 'reason' && v !== null) {
      out[key] = typeof v === 'string' ? reasonText(v, REASON_LEFT_OUT) : REASON_LEFT_OUT;
      continue;
    }
    out[key] = JSON.parse(JSON.stringify(v)) as unknown;
  }
  return out;
}

function identityOf(raw: unknown): EvidenceIdentity | null {
  const o = asObj(raw);
  const orgId = o ? asStr(o.org_id) : null;
  if (!o || orgId === null) return null;
  return {
    alias: asStr(o.alias) ?? '',
    org_id: orgId,
    org_name: asStr(o.org_name),
    org_type: asStr(o.org_type) ?? 'unknown',
    username: asStr(o.username),
  };
}

function justificationOf(raw: unknown): StoredJustification | null {
  const o = asObj(raw);
  if (!o) return null;
  const text = asStr(o.text);
  const source = o.source === 'agent' || o.source === 'page' ? o.source : null;
  if (text === null || source === null) return null;
  const j: StoredJustification = { text, source };
  const edited = asStr(o.edited_at);
  if (edited !== null) j.edited_at = edited;
  if (o.surface === 'approval_page' || o.surface === 'deploy_review') j.surface = o.surface;
  const draft = asStr(o.agent_draft);
  if (draft) j.agent_draft = draft;
  const confirmed = asStr(o.confirmed_at);
  if (confirmed !== null) j.confirmed_at = confirmed;
  return j;
}

function recordTime(v: unknown): string {
  return isoOf(v) ?? 'a time Contrail did not record';
}

/**
 * The dossier's provenance sentence for a justification. It is written for
 * whoever reads the dossier, not for the approver, so it never repeats the
 * page's hint; times are the stored ISO instants.
 */
export function justificationRecord(j: StoredJustification | null | undefined): string {
  if (!j || (j.source === 'agent' && j.text === '')) return 'None given.';
  if (j.source === 'agent') {
    return j.confirmed_at
      ? `Drafted by the agent; shown prefilled in Deploy Review and approved unchanged at ${recordTime(j.confirmed_at)}.`
      : 'Drafted by the agent and not edited by the human. Contrail does not record whether the approver read it.';
  }
  const where = j.surface === 'deploy_review' ? 'in Deploy Review' : 'on the approval page';
  const at = recordTime(j.edited_at);
  if (j.text === '') {
    // A human who typed a text and then cleared it removed no draft of the agent's.
    return j.agent_draft
      ? `Cleared ${where} at ${at}; the agent's draft that was removed follows.`
      : `Cleared ${where} at ${at}.`;
  }
  return j.agent_draft
    ? `Typed ${where} at ${at}. It replaced the agent's draft, which follows.`
    : `Typed ${where} at ${at}.`;
}

function commentLabel(source: string | null): string {
  switch (source) {
    case 'agent_draft_unchanged':
      return "comment (the agent's draft, approved unchanged)";
    case 'human_text_unchanged':
      return 'comment (typed on the approval page earlier, approved unchanged)';
    case 'typed':
      return 'comment (typed in Deploy Review)';
    default:
      return 'comment';
  }
}

function countsOf(raw: unknown): StoredDiffCounts | null {
  const c = asObj(raw);
  if (!c) return null;
  const out: StoredDiffCounts = {};
  const changes = asNum(c.changes);
  if (changes !== null) out.changes = changes;
  const added = asNum(c.lines_added);
  if (added !== null) out.lines_added = added;
  const removed = asNum(c.lines_removed);
  if (removed !== null) out.lines_removed = removed;
  if (Array.isArray(c.files_changed)) out.files_changed = asStrList(c.files_changed);
  if (Array.isArray(c.files_added)) out.files_added = asStrList(c.files_added);
  if (Array.isArray(c.files_removed)) out.files_removed = asStrList(c.files_removed);
  return out;
}

/** A stored page row, re-read by name and re-redacted by kind. */
function pageRowOf(kind: string, raw: unknown): StoredPageRow | null {
  const r = asObj(raw);
  if (!r) return null;
  const label = asStr(r.label) ?? '';
  const row: StoredPageRow = {
    label: kind === 'dml' ? redactRowLabel('dml', label) : label,
    warnings: asStrList(r.warnings),
  };
  const detail = asStr(r.detail);
  if (kind === 'apex') {
    const sha = detail !== null ? sha256Of(detail) : asStr(r.detail_sha256);
    const chars = detail !== null ? detail.length : asNum(r.detail_chars);
    if (sha !== null) row.detail_sha256 = sha;
    if (chars !== null) row.detail_chars = chars;
  } else if (kind !== 'dml' && detail !== null) {
    row.detail = detail;
  }
  const diff = asObj(r.diff);
  if (diff) {
    row.diff = {
      summary: asStr(diff.summary) ?? '',
      baseline_label: asStr(diff.baseline_label) ?? '',
      identical: diff.identical === true,
      counts: countsOf(diff.counts),
      truncated: diff.truncated === true,
    };
  }
  return row;
}

function pageViewOf(kind: string, raw: unknown): EvidencePageView | null {
  const v = asObj(raw);
  if (!v) return null;
  const org = asObj(v.org) ?? {};
  const rows = (list: unknown): StoredPageRow[] =>
    Array.isArray(list)
      ? list.map((r) => pageRowOf(kind, r)).filter((r): r is StoredPageRow => r !== null)
      : [];
  return {
    v: 1,
    kind,
    org: {
      alias: asStr(org.alias) ?? '',
      org_name: asStr(org.org_name),
      org_type: asStr(org.org_type) ?? '',
      instance_url: asStr(org.instance_url) ?? '',
    },
    expires_at: asStr(v.expires_at) ?? '',
    warnings: asStrList(v.warnings),
    destructive: rows(v.destructive),
    changes: rows(v.changes),
    automation: (Array.isArray(v.automation) ? v.automation : [])
      .map((a) => asObj(a))
      .filter((a): a is Record<string, unknown> => a !== null)
      .map((a) => ({
        object: asStr(a.object) ?? '',
        snapshot_at: asStr(a.snapshot_at),
        summary_lines: asStrList(a.summary_lines),
        notes: asStrList(a.notes),
        not_covered: asStrList(a.not_covered),
      })),
    automation_not_covered: asStrList(v.automation_not_covered),
    results: (Array.isArray(v.results) ? v.results : [])
      .map((r) => asObj(r))
      .filter((r): r is Record<string, unknown> => r !== null)
      .map((r) => {
        const out: StoredPageView['results'][number] = {
          label: asStr(r.label) ?? '',
          value: asStr(r.value) ?? '',
        };
        if (typeof r.bad === 'boolean') out.bad = r.bad;
        return out;
      }),
    blast: asStrList(v.blast),
  };
}

function preImagesOf(summary: Record<string, unknown>): EvidencePreImage[] {
  const out: EvidencePreImage[] = [];
  for (const list of [summary.changes, summary.destructive]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const c = asObj(item);
      if (!c) continue;
      const pre = asObj(c.pre_image);
      out.push({
        type: asStr(c.type) ?? '',
        api_name: asStr(c.api_name) ?? '',
        change: asStr(c.change),
        present: pre ? asBool(pre.present) : null,
        sha256: pre ? asStr(pre.sha256) : null,
        last_modified_date: pre ? asStr(pre.last_modified_date) : null,
        last_modified_by: pre ? asStr(pre.last_modified_by) : null,
        source: pre ? asStr(pre.source) : null,
        // Where the stamp was read (S46); absent on a request validated by 0.39.
        stamp_source: pre ? asStr(pre.stamp_source) : null,
      });
    }
  }
  return out;
}

function liveCheckOf(summary: Record<string, unknown>): EvidenceRequestEntry['live_check'] {
  const lc = asObj(summary.live_check);
  if (!lc) return null;
  // The failure reasons quote the org's own error text: only the type names are kept.
  const failures = asObj(lc.probe_failures);
  return {
    status: asStr(lc.status),
    at: asStr(lc.at),
    dates_unavailable_types: asStrList(lc.dates_unavailable_types),
    stamp_scheme: asNum(lc.stamp_scheme),
    probe_unmatched: asStrList(lc.probe_unmatched),
    probe_failure_types: failures ? Object.keys(failures) : [],
  };
}

/** The reduced payload, re-read by name (evidencePayload wrote it). */
function inputsOf(kind: string, raw: unknown): Record<string, unknown> | null {
  const p = asObj(raw);
  if (!p) return null;
  switch (kind) {
    case 'deploy':
      return { test_level: asStr(p.test_level), run_tests: asStrList(p.run_tests) };
    case 'apex':
      return { sha256: asStr(p.sha256), lines: asNum(p.lines), chars: asNum(p.chars) };
    case 'activation':
      return { agent: asStr(p.agent), version: asStr(p.version), from: asStr(p.from), to: asStr(p.to) };
    case 'bulk':
      return {
        steps: scalarsOf(p.steps, ['n', 'object', 'operation', 'row_count', 'sha256']),
        stop_on_failure: asBool(p.stop_on_failure),
      };
    case 'dml':
      return { operations: scalarsOf(p.operations, ['step', 'operation', 'object', 'rows']) };
    default:
      return null;
  }
}

/** Status codes from failure rows — never their messages. */
function statusCodesOf(list: unknown): string[] {
  const codes = new Set<string>();
  if (!Array.isArray(list)) return [];
  for (const item of list) {
    const f = asObj(item);
    if (!f) continue;
    for (const k of ['statusCode', 'errorCode']) {
      const c = asStr(f[k]);
      if (c) codes.add(c);
    }
    if (Array.isArray(f.errors)) {
      for (const e of f.errors) {
        const eo = asObj(e);
        if (!eo) continue;
        const c = asStr(eo.statusCode) ?? asStr(eo.errorCode);
        if (c) codes.add(c);
      }
    }
  }
  return [...codes];
}

/** What the org reported, by kind: flags, counts and status codes — never a message. */
function orgResultOf(kind: string, raw: unknown): Record<string, unknown> | null {
  const r = asObj(raw);
  if (!r) return null;
  if (r.target_moved === true) return { executed: false, voided_by_target_check: true };
  switch (kind) {
    case 'deploy':
      return {
        deployed: asBool(r.deployed),
        deploy_id: asStr(r.deploy_id),
        status: asStr(r.status),
        quick_deploy: asBool(r.quick_deploy),
        components_deployed: asNum(r.components_deployed),
        component_errors: asNum(r.component_errors),
        tests_run: asNum(r.tests_run),
        test_failures: asNum(r.test_failures),
      };
    case 'dml':
      return r.plan === true
        ? {
            executed: asBool(r.executed),
            plan: true,
            all_or_none: asBool(r.all_or_none),
            steps: scalarsOf(r.steps, ['step', 'operation', 'object', 'status']),
            failures: lengthOf(r.failures),
            failure_status_codes: statusCodesOf(r.failures),
          }
        : {
            executed: asBool(r.executed),
            operation: asStr(r.operation),
            object: asStr(r.object),
            rows: asNum(r.rows),
            failures: lengthOf(r.failures),
            failure_status_codes: statusCodesOf(r.failures),
          };
    case 'apex':
      return { executed: asBool(r.executed), status: asStr(r.status) };
    case 'activation':
      return {
        executed: asBool(r.executed),
        agent: asStr(r.agent),
        version: asStr(r.version),
        requested_status: asStr(r.requested_status),
        confirmed_status: asStr(r.confirmed_status),
      };
    case 'bulk':
      return {
        executed: asBool(r.executed),
        stop_on_failure: asBool(r.stop_on_failure),
        total_processed: asNum(r.total_processed),
        total_failed: asNum(r.total_failed),
        halted_after_step: asNum(r.halted_after_step),
        steps: scalarsOf(r.steps, [
          'step',
          'object',
          'operation',
          'state',
          'processed',
          'succeeded',
          'failed',
        ]),
      };
    default:
      return { executed: asBool(r.executed) };
  }
}

/**
 * The target check's note, written here from its status and the request's
 * kind. The stored note is never copied: the fail-open one quotes the failed
 * org read's message, and a deploy's no-baseline one the validate-time
 * retrieve's.
 */
function targetCheckNote(kind: string, status: string | null): string | null {
  switch (status) {
    case 'unavailable': {
      const noun =
        kind === 'deploy'
          ? 'deploy'
          : kind === 'dml'
            ? 'data change'
            : kind === 'apex'
              ? 'Apex script'
              : kind === 'bulk'
                ? 'bulk data load'
                : kind === 'activation'
                  ? 'agent activation change'
                  : 'change';
      return (
        'Contrail could not re-read the org before executing to confirm nothing had moved, so ' +
        `this ${noun} went ahead without a target check; the approval page's diff may not ` +
        'describe what was overwritten.'
      );
    }
    case 'not_checked':
      return (
        'No member could be compared (each one is listed with its reason), so this write went ' +
        'ahead without a target check.'
      );
    case 'not_applicable':
      return kind === 'apex'
        ? 'An anonymous Apex script has no fixed org target to re-check.'
        : kind === 'dml'
          ? 'No record that existed before this change to re-check: it inserts records, or ' +
            'changes only records it creates itself.'
          : kind === 'bulk'
            ? 'Bulk loads are not re-checked before executing — the approval page showed no ' +
              'current values for their rows, so there is nothing to compare against.'
            : 'Nothing in the org was re-checked for this kind of request.';
    default:
      return null;
  }
}

/**
 * The execute-time target check as stored, by name; a voided request
 * reports what moved. Reasons are kept as codes and the note is the
 * builder's own (targetCheckNote): the org's error text never reaches the
 * dossier from here.
 */
function targetCheckOf(kind: string, raw: unknown): Record<string, unknown> | null {
  const r = asObj(raw);
  if (!r) return null;
  const unchecked = (v: unknown) =>
    scalarsOf(v, ['type', 'api_name', 'object', 'id', 'reason']).map((m) =>
      typeof m.reason === 'string' ? { ...m, reason: reasonText(m.reason, REASON_LEFT_OUT) } : m,
    );
  if (r.target_moved === true) {
    const out: Record<string, unknown> = {
      status: 'moved',
      checked_at: asStr(r.checked_at),
      moved: scalarsOf(r.moved, ['type', 'api_name', 'object', 'id', 'field', 'state', 'source']),
      unchecked: unchecked(r.unchecked),
    };
    for (const k of ['agent', 'version', 'approved_from_status', 'current_status']) {
      const v = asStr(r[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  }
  const tc = asObj(r.target_check);
  if (!tc) return null;
  const status = asStr(tc.status);
  const out: Record<string, unknown> = { status };
  if (tc.checked_at !== undefined) out.checked_at = asStr(tc.checked_at);
  // Deploy and activation members by type and api_name; DML records by object and id.
  if (Array.isArray(tc.checked)) {
    out.checked = scalarsOf(tc.checked, ['type', 'api_name', 'object', 'id', 'absent']);
  }
  if (Array.isArray(tc.unchecked)) out.unchecked = unchecked(tc.unchecked);
  const reason = asStr(tc.reason);
  if (reason !== null) {
    out.reason = reasonText(
      reason,
      status === 'unavailable' ? TARGET_CHECK_READ_FAILED : REASON_LEFT_OUT,
    );
  }
  const note = targetCheckNote(kind, status);
  if (note !== null) out.note = note;
  return out;
}

/** Where the revert package is — the dossier quotes nothing from its README. */
function revertOf(kind: string, raw: unknown): EvidenceRequestEntry['revert'] {
  if (kind !== 'deploy') return null;
  const r = asObj(raw);
  if (!r || (!('revert_package' in r) && !('revert_note' in r))) return null;
  const p = asObj(r.revert_package);
  return {
    package: p
      ? {
          dir: asStr(p.dir),
          plan: asStr(p.plan),
          outcome: asStr(p.outcome),
          restores: lengthOf(p.restores),
          deletes: lengthOf(p.deletes),
          not_restorable: lengthOf(p.not_restorable),
        }
      : null,
    note: asStr(r.revert_note),
  };
}

function eventEntry(e: EvidenceEvent): EvidenceEventEntry {
  const out: EvidenceEventEntry = {
    ts: e.ts,
    event_type: e.event_type,
    tool: e.tool,
    outcome: e.outcome,
    detail: reduceAuditDetail(e.detail),
  };
  if (e.connection !== undefined) out.connection = e.connection;
  return out;
}

function sameIdentity(
  a: { org_id: string; username: string | null },
  b: { org_id: string; username: string | null },
): boolean {
  return a.org_id.slice(0, 15) === b.org_id.slice(0, 15) && a.username === b.username;
}

function policyChecksCell(
  hasPolicy: boolean,
  hasExecuteCheck: boolean,
  executed: boolean,
  executeRefused: boolean,
): string {
  if (hasPolicy && hasExecuteCheck) return 'proposal + execution';
  if (hasPolicy) {
    if (executed) return 'proposal only (executed by an older Contrail)';
    return executeRefused ? 'proposal + execution (refused)' : 'proposal (not executed)';
  }
  if (hasExecuteCheck) return 'execution only (created by an older Contrail)';
  if (executeRefused) return 'execution only (refused; created by an older Contrail)';
  return 'none (older Contrail)';
}

/**
 * The newest execute the policy re-check refused, from the request's own
 * audit rows; its reason is kept only as a code, as in the audit table.
 */
function executeRefusalOf(events: EvidenceEvent[]): { at: string; reason: string | null } | null {
  let newest: EvidenceEvent | null = null;
  for (const ev of events) {
    if (ev.event_type !== 'policy.refused' || ev.detail?.phase !== 'execute') continue;
    if (newest === null || ev.ts > newest.ts) newest = ev;
  }
  if (newest === null) return null;
  const reason = asStr(newest.detail?.reason);
  return { at: newest.ts, reason: reason === null ? null : reasonText(reason, REASON_LEFT_OUT) };
}

function requestEntry(row: EvidenceRow): EvidenceRequestEntry {
  const summary = asObj(row.summary) ?? {};
  const gov = asObj(summary.governance);
  const policy = gov ? asObj(gov.policy) : null;
  const check = gov ? asObj(gov.execute_check) : null;
  const freeze = gov ? asObj(gov.freeze) : null;
  const override = gov ? asObj(gov.freeze_override) : null;
  const executed = EXECUTED_STATUSES.has(row.status);
  // An execute the re-check refused stores nothing on the request; its audit row says so.
  const refusal = check || executed ? null : executeRefusalOf(row.events);
  const j = justificationOf(gov?.justification);
  const atProposal = row.target_at_proposal;
  const atExecution = row.target_at_execution;
  const pageView = pageViewOf(row.kind, summary.page_view);
  const decision = row.decision
    ? {
        state: row.decision.state,
        at: row.decision.at,
        comment: row.decision.comment,
        comment_source: row.decision.comment_source,
        comment_label: commentLabel(row.decision.comment_source),
      }
    : null;
  const overrideReason = override ? asStr(override.reason) : null;
  const orgResult = orgResultOf(row.kind, row.result);
  if (orgResult && row.kind === 'deploy' && orgResult.deploy_id === null) {
    // The stored result has no deploy id; the execute's own audit row does.
    for (const ev of row.events) {
      const id = ev.event_type.startsWith('deploy.execut') ? asStr(ev.detail?.deployId) : null;
      if (id !== null) orgResult.deploy_id = id;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    proposed_at: row.created_at,
    expires_at: row.expires_at,
    executed_at: row.executed_at,
    validation_id: row.validation_id,
    org_and_user: {
      at_proposal: atProposal,
      at_execution: atExecution,
      at_execution_differs:
        atProposal !== null && atExecution !== null && !sameIdentity(atProposal, atExecution),
      connection_now: atProposal ? null : row.connection_now,
      label: atProposal ? null : NOW_LABEL,
    },
    ticket: gov ? asStr(gov.ticket) : null,
    justification: {
      text: j && j.text !== '' ? j.text : null,
      record: justificationRecord(j),
      agent_draft: j && j.source === 'page' ? (j.agent_draft ?? null) : null,
    },
    policy_at_proposal: policy
      ? {
          evaluated_at: asStr(policy.evaluated_at),
          source: asStr(policy.source),
          sha256: asStr(policy.sha256),
          rules: asStrList(policy.rules),
          lines: asStrList(policy.lines),
        }
      : null,
    policy_at_proposal_note: policy ? null : POLICY_OLDER,
    freeze_at_proposal:
      freeze && asStr(freeze.rule) !== null
        ? {
            rule: asStr(freeze.rule) ?? '',
            window: asStr(freeze.window) ?? '',
            until: asStr(freeze.until) ?? '',
            time_zone: asStr(freeze.time_zone),
          }
        : null,
    freeze_override:
      override && overrideReason !== null
        ? {
            reason: overrideReason,
            at: asStr(override.at),
            surface: asStr(override.surface),
            rule: asStr(override.rule),
            window: asStr(override.window),
          }
        : null,
    execute_check: check
      ? {
          at: asStr(check.at),
          rules: asStrList(check.rules),
          freeze_active: asBool(check.freeze_active),
          overridden: asBool(check.overridden),
          org_id: asStr(check.org_id),
          username: asStr(check.username),
        }
      : null,
    // claimCode records execute_check before it claims, so an executed row
    // without one was claimed by a Contrail older than 0.40.0.
    execute_check_note: check
      ? null
      : executed
        ? EXECUTE_CHECK_OLDER
        : refusal
          ? EXECUTE_CHECK_REFUSED
          : EXECUTE_CHECK_NOT_RUN,
    execute_refusal: refusal,
    policy_checks: policyChecksCell(policy !== null, check !== null, executed, refusal !== null),
    decision,
    page_view: pageView,
    page_view_note: pageView ? null : policy ? PAGE_VIEW_MISSING : PAGE_VIEW_OLDER,
    inputs: inputsOf(row.kind, row.payload),
    pre_images: row.kind === 'deploy' ? preImagesOf(summary) : [],
    live_check: row.kind === 'deploy' ? liveCheckOf(summary) : null,
    target_check: targetCheckOf(row.kind, row.result),
    org_result: orgResult,
    revert: revertOf(row.kind, row.result),
    audit_events: row.events.map(eventEntry),
    audit_events_truncated: row.events_truncated,
  };
}

// ── Markdown safety ──────────────────────────────────────────────────────

function longestBacktickRun(s: string): number {
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
}

/**
 * A single-line stored or supplied value as a code span: control characters
 * become spaces, the delimiter is one backtick longer than any run inside,
 * and inside a table cell every `|` is escaped so it cannot end the cell
 * (a backslash already before it gets one more, so the escape pairs up). An
 * empty value is the fixed word the caller names, never an empty span.
 */
export function mdCode(s: string, opts: { cell?: boolean; empty?: string } = {}): string {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  if (flat === '') return opts.empty ?? 'none';
  const delimiter = '`'.repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  const body = opts.cell
    ? flat.replace(/(\\*)\|/g, (_m, slashes: string) =>
        slashes.length % 2 === 0 ? `${slashes}\\|` : `${slashes}\\\\|`,
      )
    : flat;
  return `${delimiter}${pad}${body}${pad}${delimiter}`;
}

/**
 * A multi-line or sentence-like value as a fenced block on its own lines,
 * with no info string; the fence is longer than any backtick run inside, so
 * no line of the value can close it.
 */
export function mdBlock(s: string): string {
  const text = s.replace(/\r\n?/g, '\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A stored time: canonical ISO when it parses, otherwise the value as a code
 * span — `cell` in a table cell, so a `|` in it cannot end the cell.
 */
function mdTime(v: unknown, none: string, cell = false): string {
  if (v === null || v === undefined || v === '') return none;
  return isoOf(v) ?? mdCode(String(v), { cell });
}

function mdKnown(v: string, known: Set<string>): string {
  return known.has(v) ? v : mdCode(v);
}

function mdList(values: string[], none: string): string {
  return values.length === 0 ? none : values.map((v) => mdCode(v)).join(', ');
}

/** A stored scalar as table-cell text (or, with cell false, as a list value). */
function mdCell(v: unknown, cell = true): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return mdCode(typeof v === 'string' ? v : JSON.stringify(v), { cell, empty: '—' });
}

function mdTable(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

function yesNo(v: boolean | null): string {
  return v === null ? 'not recorded' : v ? 'yes' : 'no';
}

/** A titled group of lines: one fenced block, or the fixed word when empty. */
function mdGroup(out: string[], title: string, lines: string[]): void {
  if (lines.length === 0) {
    out.push(`${title}: none.`, '');
    return;
  }
  out.push(`${title}:`, '', mdBlock(lines.join('\n')), '');
}

function identityMd(i: EvidenceIdentity): string {
  return (
    `${mdCode(i.alias, { empty: 'no label' })} · org ${mdCode(i.org_name ?? '', { empty: 'with no name recorded' })}` +
    ` · org id ${mdCode(i.org_id)} (${mdCode(i.org_type)}) · user ${mdCode(i.username ?? '', { empty: 'not recorded' })}`
  );
}

function pageRowLines(rows: StoredPageRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(r.label);
    for (const w of r.warnings) lines.push(`  ! ${w}`);
    if (r.detail !== undefined) lines.push(`  ${r.detail}`);
    if (r.detail_sha256 !== undefined) {
      lines.push(`  script sha256 ${r.detail_sha256} (${r.detail_chars ?? '?'} characters)`);
    }
    if (r.diff) {
      lines.push(
        `  ${r.diff.summary}${r.diff.identical ? ' (identical)' : ''}${r.diff.truncated ? ' (diff cut on the page)' : ''}`,
      );
    }
  }
  return lines;
}

function pageViewMd(out: string[], e: EvidenceRequestEntry): void {
  const pv = e.page_view;
  if (!pv) {
    out.push(e.page_view_note ?? PAGE_VIEW_MISSING, '');
    return;
  }
  out.push(
    `Org on the page: ${mdCode(pv.org.alias, { empty: 'no label' })} · ` +
      `${mdCode(pv.org.org_name ?? '', { empty: 'no org name' })} (${mdCode(pv.org.org_type, { empty: 'type not recorded' })}) ` +
      `at ${mdCode(pv.org.instance_url, { empty: 'no address recorded' })}. ` +
      `Code expiry shown: ${mdTime(pv.expires_at, 'not recorded')}.`,
    '',
  );
  mdGroup(out, 'Page warnings', pv.warnings);
  mdGroup(out, 'Deletions', pageRowLines(pv.destructive));
  mdGroup(out, 'Changes', pageRowLines(pv.changes));
  const automation: string[] = [];
  for (const a of pv.automation) {
    automation.push(`${a.object} (snapshot ${a.snapshot_at ?? 'not recorded'})`);
    for (const l of a.summary_lines) automation.push(`  ${l}`);
    for (const n of a.notes) automation.push(`  note: ${n}`);
    for (const n of a.not_covered) automation.push(`  not covered: ${n}`);
  }
  mdGroup(out, 'Automation on the objects this change touches', automation);
  mdGroup(out, 'Not covered by the automation summary', pv.automation_not_covered);
  mdGroup(
    out,
    'Results',
    pv.results.map((r) => `${r.label}: ${r.value}${r.bad ? ' (flagged)' : ''}`),
  );
  mdGroup(out, 'Blast radius', pv.blast);
}

function inputsMd(kind: string, inputs: Record<string, unknown> | null): string[] {
  if (!inputs) return [];
  switch (kind) {
    case 'deploy': {
      const level = asStr(inputs.test_level);
      const tests = asStrList(inputs.run_tests);
      return [
        `- Test level: ${level === null ? "not set (the org's own default)" : mdCode(level)}` +
          `${tests.length > 0 ? ` · run tests: ${mdList(tests, 'none')}` : ''}`,
      ];
    }
    case 'apex':
      return [
        `- Script: sha256 ${mdCode(asStr(inputs.sha256) ?? '', { empty: 'not recorded' })} · ` +
          `${mdCell(asNum(inputs.lines), false)} line(s) · ${mdCell(asNum(inputs.chars), false)} character(s)`,
      ];
    case 'activation':
      return [
        `- Agent: ${mdCode(asStr(inputs.agent) ?? '', { empty: 'not recorded' })} · version ` +
          `${mdCode(asStr(inputs.version) ?? '', { empty: 'not recorded' })} · from ` +
          `${mdCode(asStr(inputs.from) ?? '', { empty: 'not recorded' })} to ` +
          `${mdCode(asStr(inputs.to) ?? '', { empty: 'not recorded' })}`,
      ];
    case 'bulk':
      return [
        `- Stop on failure: ${yesNo(asBool(inputs.stop_on_failure))}`,
        ...scalarsOf(inputs.steps, ['n', 'object', 'operation', 'row_count', 'sha256']).map(
          (s) =>
            `- Step ${mdCell(s.n, false)}: ${mdCell(s.operation, false)} ${mdCell(s.object, false)} · ` +
            `${mdCell(s.row_count, false)} row(s) · file sha256 ${mdCell(s.sha256, false)}`,
        ),
      ];
    case 'dml':
      return scalarsOf(inputs.operations, ['step', 'operation', 'object', 'rows']).map(
        (o) =>
          `- ${o.step !== undefined ? `Step ${mdCell(o.step, false)}: ` : 'Operation: '}` +
          `${mdCell(o.operation, false)} ${mdCell(o.object, false)} · ${mdCell(o.rows, false)} record(s)`,
      );
    default:
      return [];
  }
}

function targetCheckMd(out: string[], e: EvidenceRequestEntry): void {
  const tc = e.target_check;
  if (!tc) {
    out.push(
      EXECUTED_STATUSES.has(e.status) || e.org_result
        ? 'Not recorded on this request.'
        : 'Not run — the request was not executed.',
      '',
    );
    return;
  }
  out.push(
    `Status: ${mdCode(asStr(tc.status) ?? '', { empty: 'not recorded' })}` +
      `${tc.checked_at !== undefined ? ` · checked at ${mdTime(tc.checked_at, 'not recorded')}` : ''}.`,
    '',
  );
  const member = (m: Record<string, unknown>): string =>
    [m.type, m.api_name, m.object, m.id, m.field]
      .filter((v): v is string => typeof v === 'string')
      .join(':');
  if (Array.isArray(tc.moved)) {
    mdGroup(
      out,
      'Moved',
      (tc.moved as Array<Record<string, unknown>>).map(
        (m) =>
          `${member(m)} — ${asStr(m.state) ?? 'moved'}${typeof m.source === 'string' ? ` (stamp from ${m.source})` : ''}`,
      ),
    );
  }
  if (Array.isArray(tc.checked)) {
    mdGroup(
      out,
      'Compared',
      (tc.checked as Array<Record<string, unknown>>).map(
        (m) => `${member(m)}${m.absent === true ? ' — absent, as expected' : ''}`,
      ),
    );
  }
  if (Array.isArray(tc.unchecked)) {
    mdGroup(
      out,
      'Not compared',
      (tc.unchecked as Array<Record<string, unknown>>).map(
        (m) => `${member(m)} — ${asStr(m.reason) ?? 'no reason recorded'}`,
      ),
    );
  }
  const notes = [asStr(tc.reason), asStr(tc.note)].filter((v): v is string => v !== null);
  if (notes.length > 0) mdGroup(out, 'Reason and note', notes);
}

function orgResultMd(out: string[], e: EvidenceRequestEntry): void {
  const r = e.org_result;
  if (!r) {
    out.push(
      e.status === 'executing'
        ? ORG_RESULT_EXECUTING
        : EXECUTED_STATUSES.has(e.status)
          ? 'Not recorded on this request.'
          : 'None — the request was not executed.',
      '',
    );
    return;
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === 'steps') continue;
    if (Array.isArray(v)) lines.push(`- ${k}: ${mdList(asStrList(v), 'none')}`);
    else lines.push(`- ${k}: ${mdCell(v, false)}`);
  }
  out.push(...lines, '');
  const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
  if (steps.length > 0) {
    const keys = [...new Set(steps.flatMap((s) => Object.keys(s)))];
    out.push(...mdTable(keys, steps.map((s) => keys.map((k) => mdCell(s[k])))), '');
  }
}

function revertMd(out: string[], e: EvidenceRequestEntry): void {
  if (e.kind !== 'deploy') {
    out.push('Not applicable — only metadata deploys have a revert package.', '');
    return;
  }
  const rv = e.revert;
  if (!rv) {
    out.push('None recorded — the request was not executed, or no package was reported.', '');
    return;
  }
  if (rv.package) {
    const p = rv.package;
    out.push(
      `Location: ${mdCode(p.dir ?? '', { empty: 'not recorded' })} · plan ${mdCode(p.plan ?? '', { empty: 'not recorded' })}` +
        `${p.outcome !== null ? ` · outcome ${mdCode(p.outcome)}` : ''}. ` +
        `Restores ${p.restores}, deletes ${p.deletes}, cannot restore ${p.not_restorable}.`,
      '',
    );
  } else {
    out.push('No revert package.', '');
  }
  if (rv.note !== null) mdGroup(out, 'Revert note', [rv.note]);
}

function eventsTable(events: EvidenceEventEntry[], withConnection: boolean): string[] {
  const head = withConnection
    ? ['Time', 'Connection', 'Event', 'Tool', 'Outcome', 'Detail']
    : ['Time', 'Event', 'Tool', 'Outcome', 'Detail'];
  return mdTable(
    head,
    events.map((ev) => [
      mdTime(ev.ts, '—', true),
      ...(withConnection ? [ev.connection ? mdCell(ev.connection) : 'connection removed'] : []),
      mdCell(ev.event_type),
      mdCell(ev.tool),
      mdCell(ev.outcome),
      ev.detail ? mdCell(JSON.stringify(ev.detail)) : '—',
    ]),
  );
}

function aliasOf(e: EvidenceRequestEntry): string | null {
  return e.org_and_user.at_proposal?.alias ?? e.org_and_user.connection_now?.alias ?? null;
}

function requestMd(out: string[], e: EvidenceRequestEntry): void {
  const alias = aliasOf(e);
  out.push(
    `## Request ${mdCode(e.id)} — ${mdKnown(e.kind, KNOWN_KINDS)} on ` +
      `${alias !== null ? mdCode(alias, { empty: 'a connection with no label' }) : 'a connection that has been removed'}`,
    '',
  );
  out.push(
    `- Status: ${mdCode(e.status)}`,
    `- Proposed: ${mdTime(e.proposed_at, 'not recorded')} · code expiry: ${mdTime(e.expires_at, 'not recorded')} · ` +
      `executed: ${mdTime(
        e.executed_at,
        e.status === 'executing'
          ? 'not recorded — claimed for execution, no outcome stored (see Org result)'
          : EXECUTED_STATUSES.has(e.status)
            ? 'not recorded'
            : 'not executed',
      )}`,
    `- Validation id: ${mdCode(e.validation_id ?? '', { empty: 'none' })}`,
  );
  const ou = e.org_and_user;
  if (ou.at_proposal) {
    out.push(`- Org and acting user at proposal: ${identityMd(ou.at_proposal)}`);
  } else {
    out.push(
      `- ${NOW_LABEL}: ${ou.connection_now ? identityMd(ou.connection_now) : 'connection removed'}`,
    );
  }
  if (ou.at_execution) {
    out.push(
      ou.at_proposal && !ou.at_execution_differs
        ? '- Org and acting user at execution: the same org and user.'
        : `- Org and acting user at execution: org id ${mdCode(ou.at_execution.org_id)} · user ` +
            `${mdCode(ou.at_execution.username ?? '', { empty: 'not recorded' })}`,
    );
  }
  out.push(`- Ticket: ${mdCode(e.ticket ?? '', { empty: 'none given' })}`);
  out.push(...inputsMd(e.kind, e.inputs));
  // The provenance sentence: exactly once per request.
  out.push(`- Justification: ${e.justification.record}`, '');
  if (e.justification.text !== null) out.push(mdBlock(e.justification.text), '');
  if (e.justification.agent_draft !== null) {
    out.push("The agent's draft:", '', mdBlock(e.justification.agent_draft), '');
  }
  if (e.policy_at_proposal) {
    const p = e.policy_at_proposal;
    out.push(
      `- Policies at proposal: evaluated ${mdTime(p.evaluated_at, 'at a time not recorded')} · source ` +
        `${mdCode(p.source ?? '', { empty: 'not recorded' })} · fingerprint ${mdCode(p.sha256 ?? '', { empty: 'not recorded' })} · ` +
        `rules: ${mdList(p.rules, 'none applied')}`,
      '',
    );
    mdGroup(out, 'Policy lines at proposal', p.lines);
  } else {
    out.push(`- ${e.policy_at_proposal_note ?? POLICY_OLDER}`, '');
  }
  if (e.policy_at_proposal) {
    const f = e.freeze_at_proposal;
    out.push(
      f
        ? `- Freeze at proposal: rule ${mdCode(f.rule)} · window ${mdCode(f.window)} · until ${mdCode(f.until)}` +
            ` · time zone ${mdCode(f.time_zone ?? '', { empty: 'not recorded' })}`
        : '- Freeze at proposal: none.',
    );
  }
  // An override is printed wherever it was recorded — also on a request an
  // older Contrail created, which has no record of the policies at proposal.
  const o = e.freeze_override;
  if (o) {
    const where =
      o.surface === 'deploy_review'
        ? 'in Deploy Review'
        : o.surface === 'approval_page'
          ? 'on the approval page'
          : `on ${mdCode(o.surface ?? '', { empty: 'a surface not recorded' })}`;
    out.push(
      `- Freeze override: recorded ${mdTime(o.at, 'at a time not recorded')} ${where} · rule ` +
        `${mdCode(o.rule ?? '', { empty: 'not recorded' })} · window ` +
        `${mdCode(o.window ?? '', { empty: 'not recorded' })}. Emergency reason:`,
      '',
      mdBlock(o.reason),
      '',
    );
  } else if (e.policy_at_proposal) {
    out.push('- Freeze override: none.', '');
  }
  const c = e.execute_check;
  const x = e.execute_refusal;
  out.push(
    c
      ? `- Policy re-check at execution: ${mdTime(c.at, 'at a time not recorded')} · rules: ${mdList(c.rules, 'none applied')}` +
          ` · freeze in effect: ${yesNo(c.freeze_active)} · emergency override: ${yesNo(c.overridden)}`
      : x
        ? `- Policy re-check at execution: refused at ${mdTime(x.at, 'a time not recorded')} (reason ` +
          `${mdCode(x.reason ?? '', { empty: 'not recorded' })}) — not executed.`
        : `- ${e.execute_check_note ?? EXECUTE_CHECK_NOT_RUN}`,
    `- Policy checks: ${e.policy_checks}`,
    '',
  );
  if (e.decision) {
    const d = e.decision;
    out.push(
      `- Deploy Review decision: ${mdCode(d.state)} at ${mdTime(d.at, 'a time not recorded')}`,
      '',
    );
    if (d.comment !== null && d.comment !== '') out.push(`${d.comment_label}:`, '', mdBlock(d.comment), '');
  }

  out.push('### What the approval page showed', '');
  pageViewMd(out, e);

  out.push('### Pre-images', '');
  if (e.kind !== 'deploy') {
    out.push('Not applicable — pre-images are recorded for metadata deploys only.', '');
  } else {
    const lc = e.live_check;
    out.push(
      lc
        ? `Live check at validation: ${mdCode(lc.status ?? '', { empty: 'not recorded' })} at ${mdTime(lc.at, 'a time not recorded')}` +
            ` · stamp scheme ${lc.stamp_scheme === null ? '1 (listing only)' : mdCell(lc.stamp_scheme)}` +
            ` · dates unavailable for: ${mdList(lc.dates_unavailable_types, 'none')}` +
            ` · stamp queries failed for: ${mdList(lc.probe_failure_types, 'none')}` +
            ` · same-name rows under another namespace: ${mdList(lc.probe_unmatched, 'none')}`
        : 'Live check at validation: not recorded.',
      '',
    );
    if (e.pre_images.length === 0) {
      out.push('No members recorded.', '');
    } else {
      out.push(
        ...mdTable(
          ['Type', 'API name', 'Change', 'Present', 'sha256', 'Last modified', 'Last modified by', 'Source', 'Stamp source'],
          e.pre_images.map((p) => [
            mdCell(p.type),
            mdCell(p.api_name),
            mdCell(p.change),
            p.present === null ? 'unknown' : p.present ? 'yes' : 'no',
            mdCell(p.sha256),
            mdTime(p.last_modified_date, '—', true),
            mdCell(p.last_modified_by),
            mdCell(p.source),
            mdCell(p.stamp_source),
          ]),
        ),
        '',
      );
    }
  }

  out.push('### Target check at execution', '');
  targetCheckMd(out, e);

  out.push('### Org result', '');
  orgResultMd(out, e);

  out.push('### Revert package', '');
  revertMd(out, e);

  out.push('### Audit events', '', AUDIT_LISTED, '');
  if (e.audit_events_truncated) {
    out.push('Only the newest 1,000 audit events of this request are listed.', '');
  }
  if (e.audit_events.length === 0) out.push('None.', '');
  else out.push(...eventsTable(e.audit_events, false), '');
}

/**
 * The dossier, from rows the caller has already read: evidence.json and
 * evidence.md. Pure. Every stored value is read by name; nothing stored or
 * supplied reaches evidence.md outside a code span or a fenced block, so no
 * value can forge a heading, a table row or a provenance sentence.
 */
export function buildEvidence(input: EvidenceInput): {
  json: EvidenceDossier;
  markdown: string;
  counts: EvidenceCounts;
} {
  const requests = input.requests.map(requestEntry);
  const refusals = input.refusals.map(eventEntry);
  const by_status: Record<string, number> = {};
  for (const r of requests) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
  const counts: EvidenceCounts = {
    requests: requests.length,
    by_status,
    audit_events: requests.reduce((n, r) => n + r.audit_events.length, 0),
    policy_refusals: refusals.length,
  };
  const truncated =
    input.truncated ||
    input.scan_cut ||
    input.refusals_truncated ||
    requests.some((r) => r.audit_events_truncated);
  const json: EvidenceDossier = {
    v: 1,
    generated_at: input.generated_at,
    engine_version: input.engine_version,
    surface: input.surface,
    about: EVIDENCE_ABOUT,
    filters: { ...input.filters },
    policies_now: {
      status: input.policies.status,
      source: input.policies.source ?? null,
      sha256: input.policies.sha256 ?? null,
    },
    counts,
    truncated,
    requests_truncated: input.truncated,
    requests_scan_cut: input.scan_cut,
    requests,
    policy_refusals: refusals,
    policy_refusals_truncated: input.refusals_truncated,
  };

  const f = input.filters;
  const source = input.policies.source;
  const policiesNow =
    input.policies.status !== 'ok'
      ? 'could not be read'
      : `readable (source ${source ? mdKnown(source, new Set(['config', 'default'])) : 'not recorded'})`;
  const out: string[] = [
    '# Contrail change evidence',
    '',
    `Generated ${mdTime(input.generated_at, 'at a time not recorded')} by Contrail ` +
      `${/^\d+\.\d+\.\d+$/.test(input.engine_version) ? input.engine_version : mdCode(input.engine_version)} ` +
      `(${mdKnown(input.surface, new Set(['plugin', 'desktop']))}). Filters: connection ` +
      `${f.connection !== null ? mdCode(f.connection, { empty: 'any' }) : 'any'} · ticket ` +
      `${f.ticket !== null ? mdCode(f.ticket, { empty: 'any' }) : 'any'} · request ` +
      `${f.request_id !== null ? mdCode(f.request_id, { empty: 'any' }) : 'any'} · from ` +
      `${mdTime(f.since, 'the beginning')} to ${mdTime(f.until, 'now')}.`,
    '',
    EVIDENCE_ABOUT,
    '',
    '## Summary',
    '',
    `Requests: ${counts.requests}. Policy refusals with no request: ${counts.policy_refusals}. ` +
      `Policies when this dossier was written: ${policiesNow}.`,
    '',
  ];
  if (input.truncated) {
    out.push(
      `More requests matched than this dossier lists: it holds the newest ${EVIDENCE_MAX_REQUESTS}.`,
      '',
    );
  }
  if (input.scan_cut) {
    out.push(
      `The ticket search read only the newest ${EVIDENCE_SCAN_MAX_ROWS.toLocaleString('en-US')} ` +
        'requests; an older request recorded with this ticket would not be listed.',
      '',
    );
  }
  if (requests.length === 0) {
    out.push('No request matched.', '');
  } else {
    out.push(
      ...mdTable(
        ['Request', 'Kind', 'Connection', 'Status', 'Proposed', 'Executed', 'Ticket', 'Policy checks'],
        requests.map((r) => {
          const alias = aliasOf(r);
          return [
            mdCell(r.id),
            KNOWN_KINDS.has(r.kind) ? r.kind : mdCell(r.kind),
            alias !== null ? mdCell(alias) : 'connection removed',
            mdCell(r.status),
            mdTime(r.proposed_at, '—', true),
            mdTime(r.executed_at, '—', true),
            r.ticket !== null ? mdCode(r.ticket, { cell: true, empty: 'none given' }) : 'none given',
            r.policy_checks,
          ];
        }),
      ),
      '',
    );
  }
  for (const r of requests) requestMd(out, r);
  out.push('## Policy refusals in this window (no request was created)', '');
  if (input.refusals_truncated) {
    // True however many connections were read, and whatever share of the
    // rows read named a request (those are listed under their request).
    out.push(
      'The policy refusal list was cut: at most the newest 1,000 refusal rows per connection were read.',
      '',
    );
  }
  if (refusals.length === 0) out.push('None.', '');
  else out.push(...eventsTable(refusals, true), '');

  // One blank line between blocks. Collapsed entry by entry, never by a text
  // replace: a fenced value keeps its own blank lines.
  const lines: string[] = [];
  for (const l of out) {
    if (l === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(l);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { json, markdown: `${lines.join('\n')}\n`, counts };
}

// ── reading and writing ──────────────────────────────────────────────────

/**
 * A request row as the caller's database holds it — the fields the dossier
 * reads, and no confirmation code: the caller's row carries one, but this
 * type has no field for it, so nothing here can read it.
 */
export interface EvidenceSourceRow {
  id: string;
  connectionId: string;
  kind: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  validationId: string | null;
  payloadJson: string | null;
  summaryJson: string;
  resultJson: string | null;
}

/** A request as exportChangeEvidence reads it: JSON parsed, the payload reduced. */
export interface EvidenceRequestRecord {
  id: string;
  connection_id: string;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  validation_id: string | null;
  summary: unknown;
  result: unknown;
  payload: unknown;
  decision?: EvidenceDecision;
}

/**
 * payload_json reduced to what the dossier may hold: never a record value,
 * a record id list, a script or a CSV row. deploy: the test options; apex:
 * the script's fingerprint; activation: the agent, version and the two
 * statuses; bulk: each step's object, operation, row count and file
 * fingerprint; dml: each operation's object and record count.
 */
export function evidencePayload(kind: string, payloadJson: string | null): Record<string, unknown> | null {
  const p = asObj(parseJson(payloadJson));
  if (!p) return null;
  switch (kind) {
    case 'deploy':
      return { test_level: asStr(p.testLevel), run_tests: asStrList(p.runTests) };
    case 'apex': {
      const code = asStr(p.code) ?? '';
      return {
        sha256: sha256Of(code),
        lines: code.split(/\r?\n/).length,
        chars: code.length,
      };
    }
    case 'activation':
      return {
        agent: asStr(p.bot_developer_name),
        version: asStr(p.bot_version_developer_name),
        from: asStr(p.from_status),
        to: asStr(p.to_status),
      };
    case 'bulk':
      return {
        steps: scalarsOf(p.steps, ['n', 'object', 'operation', 'row_count', 'sha256']),
        stop_on_failure: asBool(p.stop_on_failure),
      };
    case 'dml': {
      if (p.plan === true) {
        return {
          operations: (Array.isArray(p.steps) ? p.steps : []).map((s, i) => {
            const step = asObj(s) ?? {};
            return { step: i + 1, operation: asStr(step.operation), object: asStr(step.object), rows: 1 };
          }),
        };
      }
      const rows = Array.isArray(p.records) ? p.records.length : lengthOf(p.ids);
      return { operations: [{ operation: asStr(p.operation), object: asStr(p.object), rows }] };
    }
    default:
      return null;
  }
}

/** One stored request, mapped by name for the dossier. */
export function evidenceRequestOf(
  row: EvidenceSourceRow,
  decision?: EvidenceDecision,
): EvidenceRequestRecord {
  const out: EvidenceRequestRecord = {
    id: row.id,
    connection_id: row.connectionId,
    kind: row.kind,
    status: row.status,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    executed_at: row.executedAt,
    validation_id: row.validationId,
    summary: parseJson(row.summaryJson),
    result: parseJson(row.resultJson),
    payload: evidencePayload(row.kind, row.payloadJson),
  };
  if (decision) out.decision = decision;
  return out;
}

/** An audit row as the caller's log holds it. */
export interface EvidenceAuditRow {
  ts: string;
  event_type: string;
  connection_id: string | null;
  tool: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
}

/**
 * What exportChangeEvidence needs from its engine, as plain functions — the
 * unit itself never opens the database, the config or the data directory.
 */
export interface EvidenceIo {
  /** Newest first (created_at DESC, id DESC); `since` / `until` bound created_at inclusively. */
  queryRequests(filter: {
    connectionId?: string;
    since?: string;
    until?: string;
    id?: string;
    limit: number;
    offset: number;
  }): EvidenceRequestRecord[];
  getConnection(id: string): EvidenceIdentity | null;
  /** Newest first. */
  queryAudit(filter: {
    connectionId?: string;
    since?: string;
    until?: string;
    requestId?: string;
    eventType?: string;
    limit: number;
  }): EvidenceAuditRow[];
  policyStatus(): EvidencePolicyStatus;
  evidenceDir(): string;
  now(): number;
  engineVersion: string;
  surface: 'plugin' | 'desktop';
}

export interface EvidenceFilters {
  /** The connection the human named, already resolved by the caller. */
  connection?: { id: string; alias: string };
  ticket?: string;
  request_id?: string;
  since?: string;
  until?: string;
}

export type EvidenceResult =
  | { status: 'refused'; refusal: 'no_filter' }
  | { status: 'refused'; refusal: 'request_not_found'; request_id: string; connection: string | null }
  | { status: 'refused'; refusal: 'bad_timestamp'; field: 'since' | 'until'; value: string }
  | { status: 'empty' }
  | {
      status: 'written';
      /** The dossier's folder. */
      path: string;
      /** Its name alone (the audit row records only this). */
      folder: string;
      files: ['evidence.md', 'evidence.json'];
      requests: number;
      by_status: Record<string, number>;
      audit_events: number;
      policy_refusals: number;
      truncated: boolean;
    };

function ticketOf(r: EvidenceRequestRecord): string | null {
  const t = asStr(asObj(asObj(r.summary)?.governance)?.ticket);
  return t === null ? null : t.trim().toLowerCase();
}

function byTime(a: { ts: string }, b: { ts: string }): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/** The folder label: the filters reduced to [A-Za-z0-9_-], at most 60 characters. */
function folderLabel(alias: string | undefined, ticket: string | undefined, id: string | undefined): string {
  const label = [alias, ticket, id]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join('-')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .slice(0, 60);
  return label === '' ? 'evidence' : label;
}

/** A new folder directly under `root`: `<base>`, else `<base>-2`, `<base>-3`, … */
function createDossierFolder(root: string, base: string): { folder: string; name: string } {
  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const folder = path.join(root, name);
    const rel = path.relative(root, folder);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).length !== 1) {
      throw new Error('the dossier folder would not be directly inside the evidence directory');
    }
    try {
      fs.mkdirSync(folder);
      return { folder, name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('no free folder name for the dossier');
}

/**
 * Write a change-evidence dossier for the requests the filters select, plus
 * the policy refusals in that window that created no request. Requests: the
 * newest 200 that match; a ticket filter (without request_id) pages through
 * the requests 1,000 rows at a time, up to 20,000, so an old match is not
 * lost behind a row cap. Refusals: by the named connection and window, or —
 * when neither connection nor since is given — once per connection of the
 * matched requests, so a ticket-only or request-only dossier never lists
 * another connection's refusals. Nothing matched → no folder. Otherwise a
 * new folder `<YYYYMMDD-HHMMSS>-<label>` directly under the evidence
 * directory, holding evidence.json and evidence.md.
 */
export function exportChangeEvidence(io: EvidenceIo, filters: EvidenceFilters): EvidenceResult {
  const ticket = filters.ticket?.trim() ? filters.ticket.trim() : undefined;
  const requestId = filters.request_id?.trim() ? filters.request_id.trim() : undefined;
  if (!filters.connection && ticket === undefined && requestId === undefined && !filters.since) {
    return { status: 'refused', refusal: 'no_filter' };
  }
  const window: { since?: string; until?: string } = {};
  for (const field of ['since', 'until'] as const) {
    const raw = filters[field];
    if (raw === undefined || raw === '') continue;
    const iso = isoOf(raw);
    if (iso === null) return { status: 'refused', refusal: 'bad_timestamp', field, value: raw };
    window[field] = iso;
  }
  const base = { connectionId: filters.connection?.id, ...window, id: requestId };

  let matched: EvidenceRequestRecord[];
  let scanCut = false;
  if (requestId !== undefined) {
    const byId = io.queryRequests({ ...base, limit: EVIDENCE_PAGE_ROWS, offset: 0 });
    if (byId.length === 0) {
      return {
        status: 'refused',
        refusal: 'request_not_found',
        request_id: requestId,
        connection: filters.connection?.alias ?? null,
      };
    }
    const want = ticket?.toLowerCase();
    matched = want === undefined ? byId : byId.filter((r) => ticketOf(r) === want);
  } else if (ticket !== undefined) {
    const want = ticket.toLowerCase();
    const seen = new Set<string>();
    matched = [];
    let scanned = 0;
    for (;;) {
      const page = io.queryRequests({ ...base, limit: EVIDENCE_PAGE_ROWS, offset: scanned });
      scanned += page.length;
      for (const r of page) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        if (ticketOf(r) === want) matched.push(r);
      }
      if (page.length < EVIDENCE_PAGE_ROWS) break;
      if (scanned >= EVIDENCE_SCAN_MAX_ROWS) {
        scanCut = true;
        break;
      }
    }
  } else {
    matched = io.queryRequests({ ...base, limit: EVIDENCE_PAGE_ROWS, offset: 0 });
  }
  const kept = matched.slice(0, EVIDENCE_MAX_REQUESTS);

  const rows: EvidenceRow[] = kept.map((r) => {
    const gov = asObj(asObj(r.summary)?.governance);
    const check = gov ? asObj(gov.execute_check) : null;
    const checkOrg = check ? asStr(check.org_id) : null;
    const events = io.queryAudit({ requestId: r.id, limit: EVIDENCE_MAX_EVENTS });
    const row: EvidenceRow = {
      id: r.id,
      kind: r.kind,
      status: r.status,
      created_at: r.created_at,
      expires_at: r.expires_at,
      executed_at: r.executed_at,
      validation_id: r.validation_id,
      target_at_proposal: gov ? identityOf(gov.target) : null,
      target_at_execution:
        check && checkOrg !== null ? { org_id: checkOrg, username: asStr(check.username) } : null,
      connection_now: io.getConnection(r.connection_id),
      summary: r.summary,
      result: r.result,
      payload: r.payload,
      events: events
        .map((e) => ({
          ts: e.ts,
          event_type: e.event_type,
          tool: e.tool,
          outcome: e.outcome,
          detail: e.detail,
        }))
        .sort(byTime),
      events_truncated: events.length >= EVIDENCE_MAX_EVENTS,
    };
    if (r.decision) row.decision = r.decision;
    return row;
  });

  const scope: Array<string | undefined> =
    filters.connection || window.since !== undefined
      ? [filters.connection?.id]
      : [...new Set(matched.map((r) => r.connection_id))];
  let refusalsCut = false;
  const refusals: EvidenceEvent[] = [];
  for (const connectionId of scope) {
    const found = io.queryAudit({
      eventType: 'policy.refused',
      connectionId,
      ...window,
      limit: EVIDENCE_MAX_EVENTS,
    });
    if (found.length >= EVIDENCE_MAX_EVENTS) refusalsCut = true;
    for (const e of found) {
      // A refusal at execute names its request and is listed under it.
      if (e.detail && Object.hasOwn(e.detail, 'requestId')) continue;
      refusals.push({
        ts: e.ts,
        event_type: e.event_type,
        tool: e.tool,
        outcome: e.outcome,
        detail: e.detail,
        connection: e.connection_id ? (io.getConnection(e.connection_id)?.alias ?? null) : null,
      });
    }
  }
  refusals.sort(byTime);

  if (rows.length === 0 && refusals.length === 0) return { status: 'empty' };

  const generatedAt = new Date(io.now()).toISOString();
  const built = buildEvidence({
    generated_at: generatedAt,
    engine_version: io.engineVersion,
    surface: io.surface,
    filters: {
      connection: filters.connection?.alias ?? null,
      ticket: ticket ?? null,
      request_id: requestId ?? null,
      since: window.since ?? null,
      until: window.until ?? null,
    },
    requests: rows,
    refusals,
    refusals_truncated: refusalsCut,
    policies: io.policyStatus(),
    truncated: matched.length > EVIDENCE_MAX_REQUESTS,
    scan_cut: scanCut,
  });
  const stamp = generatedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const { folder, name } = createDossierFolder(
    io.evidenceDir(),
    `${stamp}-${folderLabel(filters.connection?.alias, ticket, requestId)}`,
  );
  // Created exclusively: the folder is new, so nothing can be waiting at either name.
  fs.writeFileSync(path.join(folder, 'evidence.json'), `${JSON.stringify(built.json, null, 2)}\n`, {
    flag: 'wx',
  });
  fs.writeFileSync(path.join(folder, 'evidence.md'), built.markdown, { flag: 'wx' });
  return {
    status: 'written',
    path: folder,
    folder: name,
    files: ['evidence.md', 'evidence.json'],
    requests: built.counts.requests,
    by_status: built.counts.by_status,
    audit_events: built.counts.audit_events,
    policy_refusals: built.counts.policy_refusals,
    truncated: built.json.truncated,
  };
}

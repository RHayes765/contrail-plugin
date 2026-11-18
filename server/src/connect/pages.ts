import { GRANTS, GRANT_DESCRIPTIONS, type GrantSet } from '../core/grants.js';
import { policyChangedText, unmatchedRuleText } from '../core/policy.js';

/**
 * The localhost completion/management pages. This is the only place grants
 * can be set — never via the agent or tool arguments (spec §3). Everything
 * interpolated is escaped; the pages are served on 127.0.0.1 only.
 */

export function esc(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         background: light-dark(#f5f6f8, #14161a); color: light-dark(#1b1e24, #e6e8ec);
         display: flex; justify-content: center; padding: 3rem 1rem; }
  main { width: 100%; max-width: 34rem; }
  .brand { font-size: 0.85rem; letter-spacing: 0.14em; text-transform: uppercase;
           color: light-dark(#5b6472, #9aa4b2); margin-bottom: 0.75rem; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  .card { background: light-dark(#ffffff, #1d2026); border: 1px solid light-dark(#dfe3e9, #2c3038);
          border-radius: 10px; padding: 1.25rem 1.4rem; margin-bottom: 1rem; }
  .org-row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.2rem 0;
             font-size: 0.92rem; }
  .org-row .k { color: light-dark(#5b6472, #9aa4b2); white-space: nowrap; }
  .org-row .v { text-align: right; overflow-wrap: anywhere; }
  .badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
           font-size: 0.8rem; font-weight: 600; }
  .badge.sandbox { background: #1c4f7c22; color: light-dark(#1c5f9c, #7cb8e8); }
  .badge.production { background: #7c1c1c22; color: light-dark(#a32c2c, #e88c7c); }
  .badge.other { background: #4f7c1c22; color: light-dark(#4c7c1c, #a8d87c); }
  label.grant { display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.55rem 0.4rem;
                border-radius: 8px; cursor: pointer; }
  label.grant:hover { background: light-dark(#f0f2f5, #23262d); }
  label.grant input { margin-top: 0.25rem; width: 1rem; height: 1rem; }
  label.grant strong { font-family: ui-monospace, Consolas, monospace; font-size: 0.9rem; }
  label.grant p { margin: 0.15rem 0 0; font-size: 0.83rem; color: light-dark(#5b6472, #9aa4b2); }
  .field { margin-bottom: 1rem; }
  .field label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.3rem; }
  .field input[type=text], .field input[type=password], .field select, .field textarea {
      width: 100%; padding: 0.5rem 0.65rem; border-radius: 8px;
      border: 1px solid light-dark(#c9cfd8, #3a3f48); background: light-dark(#fff, #14161a);
      color: inherit; font-size: 0.95rem; }
  .field textarea { font: inherit; resize: vertical; }
  .field .hint { font-size: 0.8rem; color: light-dark(#5b6472, #9aa4b2); margin-top: 0.3rem; }
  .success { font-size: 0.9rem; background: #1a7c3a22; border: 1px solid #1a7c3a55;
             color: light-dark(#176b33, #8ce8a8); border-radius: 8px; padding: 0.6rem 0.8rem;
             margin-bottom: 1rem; }
  .actions { display: flex; gap: 0.6rem; }
  .actions button { width: auto; flex: 1; }
  button.secondary { background: transparent; color: inherit;
                     border: 1px solid light-dark(#c9cfd8, #3a3f48); }
  .note { font-size: 0.82rem; color: light-dark(#5b6472, #9aa4b2); margin: 0.75rem 0 0; }
  .warn { font-size: 0.85rem; background: #8a6d1a22; border: 1px solid #8a6d1a55;
          color: light-dark(#6d5a12, #e8d47c); border-radius: 8px; padding: 0.6rem 0.8rem;
          margin-bottom: 1rem; }
  .error { font-size: 0.9rem; background: #8a1a1a22; border: 1px solid #8a1a1a55;
           color: light-dark(#8a2020, #e88c8c); border-radius: 8px; padding: 0.6rem 0.8rem;
           margin-bottom: 1rem; }
  button { width: 100%; padding: 0.65rem; border-radius: 8px; border: none; cursor: pointer;
           background: light-dark(#1b1e24, #e6e8ec); color: light-dark(#fff, #14161a);
           font-size: 0.95rem; font-weight: 600; }
  button:hover { opacity: 0.9; }
  .ok { font-size: 2rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.6rem; }
  .chg { padding: 0.45rem 0.4rem; border-radius: 6px; }
  .chg-label { font-family: ui-monospace, Consolas, monospace; font-size: 0.88rem; }
  .chg-warn { font-size: 0.82rem; color: light-dark(#a32c2c, #e88c7c); margin-top: 0.15rem; }
  .chg-detail { font-family: ui-monospace, Consolas, monospace; font-size: 0.74rem;
    color: light-dark(#5a6570, #8b949e); margin-top: 0.15rem; word-break: break-all;
    white-space: pre-wrap; }
  .chg.danger { background: #8a1a1a15; }
  .danger-card { border-color: #8a1a1a88; }
  .danger-card h2 { color: light-dark(#a32c2c, #e88c7c); }
  .v.bad { color: light-dark(#a32c2c, #e88c7c); font-weight: 600; }
  .code-card { text-align: center; }
  .code { font-family: ui-monospace, Consolas, monospace; font-size: 1.9rem; font-weight: 700;
          letter-spacing: 0.12em; padding: 0.7rem 0; user-select: all; }
  .chg-diff { font-size: 0.78rem; margin-top: 0.25rem; }
  .chg-diff summary { cursor: pointer; color: light-dark(#5a6570, #8b949e); }
  .dh { font-family: ui-monospace, Consolas, monospace; font-size: 0.74rem; margin-top: 0.2rem;
        overflow-wrap: anywhere; }
  .dh del { color: light-dark(#a32c2c, #e88c7c); }
  .dh ins { color: light-dark(#176b33, #8ce8a8); text-decoration: none; }
  .dh-hunk { font-family: ui-monospace, Consolas, monospace; overflow-x: auto; overflow-y: auto;
             white-space: pre; max-height: 18rem; font-size: 0.72rem; margin: 0.3rem 0 0;
             padding: 0.4rem 0.5rem; border-radius: 6px; background: light-dark(#f0f2f5, #23262d); }
  .dh-file { font-weight: 600; }
  .dh-del { color: light-dark(#a32c2c, #e88c7c); }
  .dh-add { color: light-dark(#176b33, #8ce8a8); }
  .auto-line { font-size: 0.82rem; margin-top: 0.15rem; overflow-wrap: anywhere; }
  .auto-note { font-size: 0.78rem; color: light-dark(#5b6472, #9aa4b2); margin-top: 0.15rem;
               overflow-wrap: anywhere; }
  .auto-nc { font-size: 0.78rem; color: light-dark(#5b6472, #9aa4b2); margin-top: 0.6rem; }
  .auto-nc ul { margin: 0.2rem 0 0; padding-left: 1.1rem; }
  .gov-k { font-size: 0.85rem; font-weight: 600; margin-bottom: 0.3rem; }
  .gov-text { font-size: 0.9rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .gov-list { margin: 0.3rem 0 0; padding-left: 1.1rem; font-size: 0.85rem; }
  .freeze-line { font-weight: 600; }
`;

/** The shared page shell — exported so sibling human-only pages (S42 Settings) keep the exact look. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><div class="brand">Contrail</div>${body}</main></body>
</html>`;
}

export interface GrantsPageOptions {
  mode: 'connect' | 'manage';
  sessionId: string;
  actionPath: string;
  org: {
    orgName: string | null;
    orgId: string;
    orgType: string;
    instanceUrl: string;
    username: string | null;
  };
  label: string;
  labelLocked: boolean;
  grants: GrantSet;
  error?: string;
}

export function renderGrantsPage(opts: GrantsPageOptions): string {
  const badgeClass =
    opts.org.orgType === 'sandbox' ? 'sandbox' : opts.org.orgType === 'production' ? 'production' : 'other';
  const heading =
    opts.mode === 'connect' ? 'Confirm connection & set grants' : 'Manage connection grants';

  const grantRows = GRANTS.map(
    (g) => `
    <label class="grant">
      <input type="checkbox" name="${g}" id="g-${g}" ${opts.grants[g] ? 'checked' : ''}>
      <div><strong>${g}</strong><p>${esc(GRANT_DESCRIPTIONS[g])}</p></div>
    </label>`,
  ).join('');

  const labelField = opts.labelLocked
    ? `<div class="field"><label>Connection label</label>
         <input type="text" value="${esc(opts.label)}" disabled>
         <input type="hidden" name="label" value="${esc(opts.label)}">
       </div>`
    : `<div class="field"><label for="label">Connection label</label>
         <input type="text" id="label" name="label" value="${esc(opts.label)}"
                maxlength="64" required pattern="[A-Za-z0-9][A-Za-z0-9 _.\\-]*"
                title="Letters, numbers, spaces, dots, dashes, underscores">
       </div>`;

  return page(
    heading,
    `
    <h1>${esc(heading)}</h1>
    ${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ''}
    <div class="card">
      <div class="org-row"><span class="k">Org</span><span class="v">${esc(opts.org.orgName ?? '(unnamed)')}</span></div>
      <div class="org-row"><span class="k">Org ID</span><span class="v">${esc(opts.org.orgId)}</span></div>
      <div class="org-row"><span class="k">Type</span><span class="v"><span class="badge ${badgeClass}">${esc(opts.org.orgType)}</span></span></div>
      <div class="org-row"><span class="k">Instance</span><span class="v">${esc(opts.org.instanceUrl)}</span></div>
      <div class="org-row"><span class="k">Logged in as</span><span class="v">${esc(opts.org.username ?? '(unknown)')}</span></div>
    </div>
    <div class="warn">Grants are set on this page only. Contrail does not show the AI agent
      this page; the agent cannot set grants and cannot change them later — changes always
      come back here. Every deploy or data write additionally requires your explicit
      confirmation, in every environment.</div>
    <form method="post" action="${esc(opts.actionPath)}" class="card">
      <input type="hidden" name="session" value="${esc(opts.sessionId)}">
      ${labelField}
      ${grantRows}
      <p class="note">metadata_write requires metadata_read; data_write requires data_read
        (auto-selected). Leave everything unticked for a connect-only entry.</p>
      <button type="submit">${opts.mode === 'connect' ? 'Save connection' : 'Save grants'}</button>
    </form>
    <script>
      const deps = { metadata_write: 'metadata_read', data_write: 'data_read' };
      for (const [w, r] of Object.entries(deps)) {
        const wEl = document.getElementById('g-' + w);
        const rEl = document.getElementById('g-' + r);
        wEl.addEventListener('change', () => { if (wEl.checked) rEl.checked = true; });
        rEl.addEventListener('change', () => { if (!rEl.checked) wEl.checked = false; });
      }
    </script>`,
  );
}

export function renderSuccessPage(opts: {
  mode: 'connect' | 'manage';
  alias: string;
  grants: GrantSet;
}): string {
  const granted = GRANTS.filter((g) => opts.grants[g]);
  const summary =
    granted.length === 0
      ? 'No grants enabled — the agent can list this connection but cannot touch the org.'
      : `Enabled grants: ${granted.join(', ')}.`;
  return page(
    'Saved',
    `
    <div class="card">
      <div class="ok">✓</div>
      <h1>${opts.mode === 'connect' ? 'Connection saved' : 'Grants updated'}</h1>
      <p><strong>${esc(opts.alias)}</strong> is ready. ${esc(summary)}</p>
      <p class="note">You can close this tab and return to your conversation.</p>
    </div>`,
  );
}

/**
 * S45: one row's collapsed diff (deploy pages). Structural copies of the
 * diff/semantic.ts shapes, so this file imports no diff code. The engine
 * composes every sentence (`summary`, `note`); this page only escapes and
 * lays them out. Pre-image text is untrusted org content — esc() on all of it.
 */
export interface ApprovalRowDiff {
  format: 'xml' | 'text' | 'bundle';
  identical: boolean;
  /** "diff vs live org (retrieved HH:MM)" or "diff vs your snapshot (<date>)". */
  baseline_label: string;
  /** The <summary> line, e.g. "diff vs live org (retrieved 15:02) · 3 changes". */
  summary: string;
  xml_changes?: Array<{
    kind: string;
    path: string;
    a?: unknown;
    b?: unknown;
    key?: string;
    note?: string;
  }>;
  /** Bundles carry `file` (the path inside the bundle) on every hunk. */
  text_hunks?: Array<{
    file?: string;
    a_line: number;
    b_line: number;
    removed: string[];
    added: string[];
    removed_truncated?: boolean;
    added_truncated?: boolean;
  }>;
  counts?: {
    changes?: number;
    lines_added?: number;
    lines_removed?: number;
    files_changed?: string[];
    files_added?: string[];
    files_removed?: string[];
  };
  truncated: boolean;
  /** Why the body is shorter than the summary line (budget spent, too large to diff). */
  note?: string;
}

/**
 * S45 F3: one object's section of the automation card (DML / bulk / Apex
 * pages) — a structural subset of deps/automation.ts's ObjectAutomation, so
 * this file imports no snapshot code. That module composes every line
 * (`summary_lines` from formatAutomationLines, `notes`, `not_covered`); this
 * page only escapes and lays them out. The card is read from the local
 * snapshot, never the org — its heading says so and names the snapshot date.
 */
export interface ApprovalAutomation {
  object: string;
  /** ISO time the snapshot rows behind this section were retrieved; null when none. */
  snapshot_at: string | null;
  summary_lines: string[];
  notes: string[];
  not_covered: string[];
}

export interface ApprovalPageOptions {
  kind: 'deploy' | 'dml' | 'apex' | 'bulk' | 'activation';
  code: string;
  expiresAt: string;
  org: { alias: string; orgName: string | null; orgType: string; instanceUrl: string };
  /**
   * Non-destructive changes, one row each. `detail` renders monospace, pre-wrap (multiline-safe).
   * S45: `diff` (deploy rows) renders collapsed under the warnings.
   */
  changes: Array<{ label: string; warnings: string[]; detail?: string; diff?: ApprovalRowDiff }>;
  /** Destructive changes — rendered first, in red. */
  destructive: Array<{
    label: string;
    warnings: string[];
    detail?: string;
    diff?: ApprovalRowDiff;
  }>;
  /**
   * S45 F3: what the snapshot says fires on the objects this write touches —
   * one entry per object (at most 10), rendered as one card after Changes.
   */
  automation?: ApprovalAutomation[];
  /**
   * S45 F3 (Apex pages): the not_covered lines for a script in which no
   * object was found. `automation` is then empty and the card still renders
   * — its prefix line says none were found in the text, followed by these
   * lines — so the page never reads as "no automation fires". Supplied by the
   * engine (deps/automation.ts NOT_COVERED), so this file imports nothing.
   */
  automationNotCovered?: string[];
  /** Validation/test result lines. */
  results: Array<{ label: string; value: string; bad?: boolean }>;
  /** Blast radius lines. */
  blast: string[];
  /** Advisory warnings (e.g. new components with no permissions) — amber, near the top. */
  warnings?: string[];
  /**
   * S46 (B): the request's change record — ticket, justification, the
   * policies that apply and the policy state of the request. Code-free:
   * every text in it is shown to the human only, and the engine fills it
   * per render. Absent = the page has no Change record card.
   */
  governance?: ApprovalGovernance;
}

/**
 * S46 (B): the Change record of one approval page. The engine composes every
 * sentence (`provenance`, `policyLines`, `freezeLine`, `blockedLines`); this
 * page escapes and lays them out, apart from the policies-changed and
 * unmatched-rule sentences, which come from core/policy.ts so Deploy Review
 * prints the same words.
 */
export interface ApprovalGovernance {
  gate: 'open' | 'frozen' | 'overridden' | 'blocked';
  /** Absent → read-only card, no forms. */
  sessionId?: string;
  ticket: string | null;
  justification: { text: string; provenance: string; required: boolean };
  /** From the same load that produced policyLines. */
  policySource: 'default' | 'config';
  policyLines: string[];
  /** Rule names; live page state only. */
  unmatchedRules?: string[];
  /** ISO; engine.policyChangeNotice(now), filled live. */
  policyChangedAt?: string;
  /** frozen | overridden. */
  freezeLine?: string;
  /** Stored governance.freeze !== null. */
  frozenAtMint: boolean;
  override?: { reason: string; at: string };
  blockedBy?: 'unreadable' | 'violations';
  blockedLines?: string[];
  notice?: { kind: 'success' | 'error'; text: string };
  rev: string;
  limits: { justificationMax: number; reasonMin: number; reasonMax: number };
}

/**
 * The write-approval page. This page is the ONLY place the confirmation code
 * appears — Contrail never hands the agent this page or the code, so reading
 * it back is what approval means. Everything shown here also went to the
 * agent except the code. Anything that shows the agent this page shows it
 * the code too (a screenshot pasted into the chat, an agent that can view
 * the human's screen): the code card says so, and promises nothing about
 * closing the tab that the page does not do.
 */
export function renderApprovalPage(opts: ApprovalPageOptions): string {
  const isProd = opts.org.orgType === 'production';
  const badgeClass = isProd ? 'production' : opts.org.orgType === 'sandbox' ? 'sandbox' : 'other';
  const title =
    opts.kind === 'deploy'
      ? 'Approve this deploy'
      : opts.kind === 'apex'
        ? 'Approve this anonymous Apex script'
        : opts.kind === 'bulk'
          ? 'Approve this bulk data load'
          : opts.kind === 'activation'
            ? 'Approve this agent activation change'
            : 'Approve this data change';

  // S46 (B): no code (the request is no longer pending), a change freeze with
  // no emergency reason recorded, or a policy that blocks the request:
  // neither the code element nor the note that tells the human to read a
  // code back is emitted.
  const gate = opts.governance?.gate;
  const codeShown = opts.code !== '' && gate !== 'blocked' && gate !== 'frozen';
  const codeHidden =
    gate === 'frozen'
      ? 'Hidden while the change freeze is in effect — record an emergency reason above to show it.'
      : gate === 'blocked'
        ? 'Not shown — see "Blocked by policy" above.'
        : null;

  // `detail` carries file provenance for components read from disk. The human
  // is approving bytes they did not type, so the page has to say which file
  // they came from and fingerprint it.
  const row = (
    c: { label: string; warnings: string[]; detail?: string; diff?: ApprovalRowDiff },
    danger: boolean,
  ) => `
    <div class="chg${danger ? ' danger' : ''}">
      <div class="chg-label">${esc(c.label)}</div>
      ${c.detail ? `<div class="chg-detail">${esc(c.detail)}</div>` : ''}
      ${c.warnings.map((w) => `<div class="chg-warn">⚠ ${esc(w)}</div>`).join('')}
      ${c.diff ? renderRowDiff(c.diff) : ''}
    </div>`;

  return page(
    title,
    `
    <h1>${esc(title)}</h1>
    <div class="card">
      <div class="org-row"><span class="k">Target</span><span class="v"><strong>${esc(
        opts.org.alias,
      )}</strong> — ${esc(opts.org.orgName ?? '')}</span></div>
      <div class="org-row"><span class="k">Type</span><span class="v"><span class="badge ${badgeClass}">${esc(
        opts.org.orgType,
      )}</span></span></div>
      <div class="org-row"><span class="k">Instance</span><span class="v">${esc(
        opts.org.instanceUrl,
      )}</span></div>
    </div>
    ${opts.governance ? renderGovernance(opts.governance) : ''}
    ${
      opts.warnings && opts.warnings.length
        ? `<div class="warn">${opts.warnings.map((w) => esc(w)).join('<br><br>')}</div>`
        : ''
    }
    ${
      opts.destructive.length
        ? `<div class="card danger-card"><h2>Destructive changes</h2>${opts.destructive
            .map((c) => row(c, true))
            .join('')}</div>`
        : ''
    }
    ${
      opts.changes.length
        ? `<div class="card"><h2>Changes</h2>${opts.changes.map((c) => row(c, false)).join('')}</div>`
        : ''
    }
    ${
      (opts.automation && opts.automation.length) ||
      (opts.kind === 'apex' && opts.automationNotCovered && opts.automationNotCovered.length)
        ? renderAutomationCard(opts.kind, opts.automation ?? [], opts.automationNotCovered ?? [])
        : ''
    }
    ${
      opts.results.length
        ? `<div class="card"><h2>Validation</h2>${opts.results
            .map(
              (r) =>
                `<div class="org-row"><span class="k">${esc(r.label)}</span><span class="v${
                  r.bad ? ' bad' : ''
                }">${esc(r.value)}</span></div>`,
            )
            .join('')}</div>`
        : ''
    }
    ${
      opts.blast.length
        ? `<div class="card"><h2>Blast radius</h2>${opts.blast
            .map((b) => `<div class="chg"><div class="chg-label">${esc(b)}</div></div>`)
            .join('')}</div>`
        : ''
    }
    <div class="card code-card" id="code-card">
      <h2>Confirmation code</h2>
      ${
        codeShown
          ? `<div class="code" id="code">${esc(opts.code)}</div>
      <p class="note">If — and only if — you approve everything above, read this code back to
        the agent. Contrail itself never gives the agent this page or the code — but anything that
        shows the agent this page hands it the code too (a screenshot or copy pasted into the chat,
        or an agent that can view your screen), so share it only if you mean to approve. If anything
        looks wrong, close this tab and do not give the agent the code; if the agent has already
        seen this page, tell it you do not approve. The code is single-use and expires
        ${esc(new Date(opts.expiresAt).toLocaleTimeString())}; re-validating replaces it.</p>`
          : codeHidden !== null
            ? `<p class="note">${codeHidden}</p>`
            : ''
      }
    </div>
    <div class="card danger-card" id="dead" style="display:none">
      <h2>This code is no longer valid</h2>
      <p class="note" id="dead-why">Close this tab.</p>
    </div>
    <script>
      // Blank the code whenever it can no longer be a live confirmation:
      //  (a) the /status poll reports the request is no longer 'validated', OR
      //  (b) sustained poll failure — the server is gone (process restart), so
      //      we must not keep showing a code we can't confirm, OR
      //  (c) the embedded expiry passes — works even with no server at all.
      // Backend claimCode() is the real gate; this is defense-in-depth so a
      // stale tab is never misread as a live code.
      (function () {
        // S46 (B): a form on this page answers with ?n=<notice>. Drop it from
        // the address before the first poll, so a reload never replays the
        // notice; ?s= stays, because the /status poll reads it.
        var q = new URLSearchParams(location.search);
        if (q.has('n')) {
          var s = q.get('s') || '';
          history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(s));
        }
        // S46 (B): the request's policy state as this render drew it. When
        // /status reports another one — a freeze began or ended, a reason was
        // recorded, the policies changed — the page reloads, so a code that
        // is no longer to be shown leaves the screen within one poll.
        var REV = ${JSON.stringify(opts.governance ? opts.governance.rev : null).replace(/</g, '\\u003c')};
        var reasons = {
          executed: 'This change has already been executed.',
          executing: 'This change is currently being executed.',
          superseded:
            'This code was replaced — by a newer validation, or because Contrail found the ' +
            'target had changed before executing.',
          expired: 'This code has expired.',
          locked: 'This code was locked after too many incorrect attempts.',
          execution_failed: 'The execution failed; this code is spent.',
          gone: 'This approval session has ended — the code can no longer be confirmed.'
        };
        var done = false;
        function invalidate(status) {
          if (done) return;
          done = true;
          var cc = document.getElementById('code-card');
          var dead = document.getElementById('dead');
          if (cc) cc.style.display = 'none';
          if (dead) {
            document.getElementById('dead-why').textContent =
              reasons[status] || 'This code is no longer valid.';
            dead.style.display = 'block';
          }
        }
        var fails = 0;
        function check() {
          if (done) return;
          fetch('/status' + location.search, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : { active: false, status: 'gone' }; })
            .then(function (s) {
              fails = 0;
              if (s && s.active === false) invalidate(s.status);
              else if (REV !== null && s && s.rev && s.rev !== REV) location.reload();
              else setTimeout(check, 3000);
            })
            .catch(function () {
              // A gone server = code can't be confirmed; blank after a few misses.
              if (++fails >= 3) invalidate('gone');
              else setTimeout(check, 3000);
            });
        }
        setTimeout(check, 3000);
        var msLeft = ${JSON.stringify(new Date(opts.expiresAt).getTime())} - Date.now();
        setTimeout(function () { invalidate('expired'); }, msLeft > 0 ? msLeft : 0);
      })();
    </script>`,
  );
}

/**
 * S46 (B): everything the page shows about the request's governance, between
 * the org card and the warnings — the notice a form answered with, the
 * freeze or block card when the gate is not open, then the Change record
 * card.
 */
function renderGovernance(g: ApprovalGovernance): string {
  const notice = g.notice ? `<div class="${g.notice.kind}">${esc(g.notice.text)}</div>` : '';
  return `${notice}${renderGateCard(g)}${renderChangeRecord(g)}`;
}

/** HH:MM on this machine's wall clock (24-hour). */
function wallClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * S46 (B): the card a gate other than 'open' adds above the Change record.
 * frozen — the freeze, why no code is shown (by whether the freeze held the
 * request when it was proposed, or began afterwards and its code may already
 * have been seen), and, with a session, the emergency-reason form: the reason
 * releases this request only, and the freeze stays configured. overridden —
 * the reason the human recorded. blocked — what stops the request, and what
 * the human can do about it. Every value goes through esc().
 */
function renderGateCard(g: ApprovalGovernance): string {
  const freezeLine = g.freezeLine ? `<p class="freeze-line">${esc(g.freezeLine)}</p>` : '';
  if (g.gate === 'frozen') {
    const lead = g.frozenAtMint
      ? 'No confirmation code is shown, and none was sent to your phone.'
      : 'No confirmation code is shown. This freeze began after the request was proposed, so its ' +
        'code may already have been shown on this page or sent to your phone; while the freeze ' +
        'lasts that code does not execute until an emergency reason is recorded here.';
    const form = g.sessionId
      ? `<form method="post" action="/override" id="gov-override">` +
        `<input type="hidden" name="session" value="${esc(g.sessionId)}">` +
        `<div class="field"><label for="reason">Emergency reason</label>` +
        `<textarea id="reason" name="reason" rows="3" required minlength="${g.limits.reasonMin}" ` +
        `maxlength="${g.limits.reasonMax}" placeholder="Why this cannot wait until the freeze ends">` +
        `</textarea>` +
        `<div class="hint">At least ${g.limits.reasonMin} characters. Kept with this request in the ` +
        `audit log and the change-evidence dossier.</div></div>` +
        `<div class="actions"><button type="submit">Record emergency reason and show the code</button></div>` +
        `</form>`
      : '';
    return (
      `<div class="card danger-card" id="gov-freeze"><h2>CHANGE FREEZE</h2>${freezeLine}` +
      `<p class="note">${lead} If this change cannot wait, type the emergency reason below: ` +
      `the code then appears on this page, and the reason is recorded in Contrail's audit log as ` +
      `a freeze override for this request only. The freeze itself stays configured — only ` +
      `editing config.json changes it.</p>${form}</div>`
    );
  }
  if (g.gate === 'overridden') {
    const recorded = g.override
      ? `<p class="note">You recorded an emergency reason at ${esc(wallClock(g.override.at))}: ` +
        `“${esc(g.override.reason)}”. The override applies to this request only and is in the ` +
        `audit log; the freeze stays configured.</p>`
      : '';
    return (
      `<div class="card danger-card" id="gov-freeze">` +
      `<h2>CHANGE FREEZE — OVERRIDDEN FOR THIS REQUEST</h2>${freezeLine}${recorded}</div>`
    );
  }
  if (g.gate === 'blocked') {
    const lines = (g.blockedLines ?? []).map((l) => `<div class="chg-warn">${esc(l)}</div>`).join('');
    const closing =
      g.blockedBy === 'unreadable'
        ? 'No confirmation code is shown: Contrail could not read the policies in config.json — ' +
          'the line above says why. Once the file is fixed, this page updates by itself within a ' +
          'few seconds.'
        : "No confirmation code is shown: this request does not satisfy this connection's " +
          'policies as they stand now — the lines above say what is missing. If it is a ' +
          'justification, type it under Change record below and save; otherwise ask the agent ' +
          'to propose the change again.';
    return (
      `<div class="card danger-card" id="gov-block"><h2>BLOCKED BY POLICY</h2>${lines}` +
      `<p class="note">${closing}</p></div>`
    );
  }
  return '';
}

/**
 * S46 (B): the Change record card — the ticket, the justification and who
 * wrote it, and the policies that apply to this connection now. With no
 * session it is read-only: nothing on it records anything. With one, the
 * justification is a form the human can save; saving records their text and
 * approves nothing. The ticket is read-only either way. Every value goes
 * through esc(): the ticket and the justification are agent-written, the
 * rule names and patterns come from the human's config.json.
 */
function renderChangeRecord(g: ApprovalGovernance): string {
  const changed = g.policyChangedAt
    ? `<p class="chg-warn" id="gov-changed">${esc(policyChangedText(g.policyChangedAt))}</p>`
    : '';
  const ticket =
    `<div class="org-row"><span class="k">Ticket</span>` +
    `<span class="v">${esc(g.ticket ?? 'none given')}</span></div>`;
  const j = g.justification;
  const label = `Justification${j.required ? ' (required by policy)' : ''}`;
  const justification = g.sessionId
    ? `<form method="post" action="/justification" id="gov-justification">` +
      `<input type="hidden" name="session" value="${esc(g.sessionId)}">` +
      `<div class="field"><label for="justification">${label}</label>` +
      `<textarea id="justification" name="justification" rows="3" maxlength="${g.limits.justificationMax}">` +
      `${esc(j.text)}</textarea>` +
      `<div class="hint">${esc(j.provenance)}</div></div>` +
      `<div class="actions"><button type="submit" class="secondary">Save justification</button></div>` +
      `<p class="note">Saving records the text as typed on this page. It approves nothing and ` +
      `does not change the code.</p></form>`
    : `<div class="field" id="gov-justification">` +
      `<div class="gov-k">${label}</div>` +
      (j.text ? `<div class="gov-text">${esc(j.text)}</div>` : '') +
      `<div class="hint">${esc(j.provenance)}</div></div>`;
  // Unreadable policies: nothing is known about what applies, so no list.
  const policies =
    g.blockedBy === 'unreadable'
      ? ''
      : `<div class="gov-k">${
          g.policySource === 'config'
            ? 'Policies on this connection (from config.json):'
            : "Policies on this connection (Contrail's built-in default — config.json has no policies section):"
        }</div>` +
        (g.policyLines.length
          ? `<ul class="gov-list">${g.policyLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
          : '<p class="note">No policy rule applies to this connection.</p>');
  const unmatched = (g.unmatchedRules ?? [])
    .map((name) => `<p class="note">${esc(unmatchedRuleText(name))}</p>`)
    .join('');
  return (
    `<div class="card" id="gov-record"><h2>Change record</h2>` +
    `${changed}${ticket}${justification}${policies}${unmatched}</div>`
  );
}

/**
 * S45: a row's diff, collapsed. No JavaScript — a native <details>. Hunks
 * scroll horizontally inside the 34rem column (phones stay readable).
 * Everything interpolated goes through esc(): pre-images are org text.
 */
function renderRowDiff(d: ApprovalRowDiff): string {
  if (d.identical) return `<div class="chg-diff">${esc(d.summary)}</div>`;
  const value = (v: unknown) =>
    v === null || v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v);
  const parts: string[] = [];
  for (const ch of d.xml_changes ?? []) {
    const where = `<span class="dh-file">${esc(ch.path || '(root)')}</span>`;
    if (ch.kind === 'scalar') {
      parts.push(
        `<div class="dh">${where} <del>${esc(value(ch.a))}</del> → ` +
          `<ins>${esc(value(ch.b))}</ins></div>`,
      );
    } else if (ch.kind === 'added') {
      parts.push(`<div class="dh">${where} <ins>+ ${esc(ch.key)}</ins></div>`);
    } else if (ch.kind === 'removed') {
      parts.push(`<div class="dh">${where} <del>− ${esc(ch.key)}</del></div>`);
    } else {
      parts.push(`<div class="dh">${where} ${esc(ch.note)}</div>`);
    }
  }
  if (d.counts?.files_added?.length) {
    parts.push(`<div class="dh">added: ${esc(d.counts.files_added.join(', '))}</div>`);
  }
  if (d.counts?.files_removed?.length) {
    parts.push(`<div class="dh">removed: ${esc(d.counts.files_removed.join(', '))}</div>`);
  }
  for (const h of d.text_hunks ?? []) {
    const lines: string[] = [];
    if (h.file) lines.push(`<span class="dh-file">${esc(h.file)}</span>`);
    lines.push(esc(`@@ −${h.a_line} +${h.b_line} @@`));
    for (const l of h.removed) lines.push(`<span class="dh-del">- ${esc(l)}</span>`);
    if (h.removed_truncated) lines.push(`<span class="dh-del">  … more removed lines</span>`);
    for (const l of h.added) lines.push(`<span class="dh-add">+ ${esc(l)}</span>`);
    if (h.added_truncated) lines.push(`<span class="dh-add">  … more added lines</span>`);
    parts.push(`<pre class="dh-hunk">${lines.join('\n')}</pre>`);
  }
  if (d.note) parts.push(`<div class="dh">${esc(d.note)}</div>`);
  else if (d.truncated) {
    parts.push(`<div class="dh">… truncated — more differences than this page shows</div>`);
  }
  return (
    `<details class="chg-diff"><summary>${esc(d.summary)}</summary>` +
    `${parts.join('')}</details>`
  );
}

/**
 * S45 F3: the automation card. Lines come from deps/automation.ts (the one
 * text source); the heading names the snapshot date(s) behind them and says
 * the org was not read. esc() on everything — flow, trigger and rule names are
 * org text.
 */
function renderAutomationCard(
  kind: ApprovalPageOptions['kind'],
  list: ApprovalAutomation[],
  extraNotCovered: string[],
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  };
  const dates = [
    ...new Set(list.flatMap((a) => (a.snapshot_at ? [stamp(a.snapshot_at)] : []))),
  ];
  // No object at all (an Apex script naming none) means no snapshot row was
  // read, so the heading names no date rather than "an unknown date".
  const heading =
    (list.length
      ? `AUTOMATION IN YOUR SNAPSHOT (from ${dates.length ? dates.join(', ') : 'an unknown date'})`
      : 'AUTOMATION IN YOUR SNAPSHOT') + ' — read from the local snapshot, not the live org';
  // An Apex page with no object found still says so, rather than dropping
  // the card (the not_covered lines then come from extraNotCovered).
  const prefix =
    kind === 'apex'
      ? `<div class="auto-line">${esc(
          'Objects this script MAY touch (parsed from the text; dynamic SOQL and called Apex ' +
            `hide more): ${
              list.length ? list.map((a) => a.object).join(', ') : 'none found in the text'
            }`,
        )}</div>`
      : '';
  const objects = list
    .map(
      (a) =>
        `<div class="chg"><div class="chg-label">${esc(a.object)}</div>` +
        a.summary_lines.map((l) => `<div class="auto-line">${esc(l)}</div>`).join('') +
        a.notes.map((n) => `<div class="auto-note">${esc(n)}</div>`).join('') +
        '</div>',
    )
    .join('');
  const notCovered = [...new Set([...list.flatMap((a) => a.not_covered), ...extraNotCovered])];
  const nc = notCovered.length
    ? `<div class="auto-nc">Not visible in the snapshot:<ul>${notCovered
        .map((l) => `<li>${esc(l)}</li>`)
        .join('')}</ul></div>`
    : '';
  return `<div class="card"><h2>${esc(heading)}</h2>${prefix}${objects}${nc}</div>`;
}

export function renderErrorPage(message: string): string {
  return page(
    'Contrail error',
    `
    <div class="card">
      <h1>Something went wrong</h1>
      <div class="error">${esc(message)}</div>
      <p class="note">Close this tab and ask the agent to open the page again. Details are in
        the server log (stderr) if you need them.</p>
    </div>`,
  );
}

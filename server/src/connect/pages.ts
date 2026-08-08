import { GRANTS, GRANT_DESCRIPTIONS, type GrantSet } from '../core/grants.js';

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
  .field input[type=text] { width: 100%; padding: 0.5rem 0.65rem; border-radius: 8px;
      border: 1px solid light-dark(#c9cfd8, #3a3f48); background: light-dark(#fff, #14161a);
      color: inherit; font-size: 0.95rem; }
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
  .chg.danger { background: #8a1a1a15; }
  .danger-card { border-color: #8a1a1a88; }
  .danger-card h2 { color: light-dark(#a32c2c, #e88c7c); }
  .v.bad { color: light-dark(#a32c2c, #e88c7c); font-weight: 600; }
  .code-card { text-align: center; }
  .code { font-family: ui-monospace, Consolas, monospace; font-size: 1.9rem; font-weight: 700;
          letter-spacing: 0.12em; padding: 0.7rem 0; user-select: all; }
`;

function page(title: string, body: string): string {
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
    <div class="warn">Grants are set on this page only. The AI agent cannot see this page,
      cannot set grants, and cannot change them later — changes always come back here.
      Every deploy or data write additionally requires your explicit confirmation, in every
      environment.</div>
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

export interface ApprovalPageOptions {
  kind: 'deploy' | 'dml';
  code: string;
  expiresAt: string;
  org: { alias: string; orgName: string | null; orgType: string; instanceUrl: string };
  /** Non-destructive changes, one row each. */
  changes: Array<{ label: string; warnings: string[] }>;
  /** Destructive changes — rendered first, in red. */
  destructive: Array<{ label: string; warnings: string[] }>;
  /** Validation/test result lines. */
  results: Array<{ label: string; value: string; bad?: boolean }>;
  /** Blast radius lines. */
  blast: string[];
  /** Advisory warnings (e.g. new components with no permissions) — amber, near the top. */
  warnings?: string[];
}

/**
 * The write-approval page. This page is the ONLY place the confirmation code
 * appears — the agent never sees it, so reading it back is what approval
 * means. Everything shown here also went to the agent except the code.
 */
export function renderApprovalPage(opts: ApprovalPageOptions): string {
  const isProd = opts.org.orgType === 'production';
  const badgeClass = isProd ? 'production' : opts.org.orgType === 'sandbox' ? 'sandbox' : 'other';
  const title = opts.kind === 'deploy' ? 'Approve this deploy' : 'Approve this data change';

  const row = (c: { label: string; warnings: string[] }, danger: boolean) => `
    <div class="chg${danger ? ' danger' : ''}">
      <div class="chg-label">${esc(c.label)}</div>
      ${c.warnings.map((w) => `<div class="chg-warn">⚠ ${esc(w)}</div>`).join('')}
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
      <div class="code" id="code">${esc(opts.code)}</div>
      <p class="note">If — and only if — you approve everything above, read this code back to
        the agent. The agent cannot see this page. If anything looks wrong, close this tab and
        nothing happens. The code is single-use and expires
        ${esc(new Date(opts.expiresAt).toLocaleTimeString())}; re-validating replaces it.</p>
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
        var reasons = {
          executed: 'This change has already been executed.',
          executing: 'This change is currently being executed.',
          superseded: 'A newer validation replaced this code.',
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

export function renderErrorPage(message: string): string {
  return page(
    'Connection error',
    `
    <div class="card">
      <h1>Something went wrong</h1>
      <div class="error">${esc(message)}</div>
      <p class="note">Close this tab and ask the agent to retry connect_org. Details are in
        the server log (stderr) if you need them.</p>
    </div>`,
  );
}

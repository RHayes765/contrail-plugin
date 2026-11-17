import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mirror gate: the plugin engine (server/src) against the desktop engine
 * (<desktop>/packages/engine/src). Three checks, all reproducible from the
 * repo:
 *
 *   1. TEXT tuples — describe/schema/refusal strings and the hand-mirrored
 *      engine texts must be WORD-identical. Each tuple names a file in both
 *      engines and a start/end anchor; every string literal in the file is
 *      evaluated (escapes resolved, `${…}` placeholders reduced to `${}` so
 *      variable names may differ, comments ignored) and joined, and the text
 *      from the start anchor through the end anchor must match exactly. Line
 *      wrapping and quote style may differ; words may not.
 *   2. BYTE-identical mirror units (`cmp`).
 *   3. CODE-identical files — every non-comment line equal (comments may
 *      differ).
 *
 * Usage: node scripts/describe-identity.mjs [--desktop <path>] [--skip-mirror]
 *
 * The desktop checkout is --desktop <path>, else CONTRAIL_DESKTOP_ROOT, else
 * ../../desktop from server/ (the sibling checkout). When it is absent the
 * gate REFUSES (exit 2) unless --skip-mirror is passed; --skip-mirror checks
 * the plugin side only (every anchor resolves, every listed file exists) and
 * never compares. Exit 1 on any MISSING/MISMATCH.
 *
 * LOCAL gate only (release.mjs step 2): CI's runner has no desktop checkout,
 * so this never goes into .github/workflows/release.yml.
 */

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrc = path.join(serverRoot, 'src');

const argv = process.argv.slice(2);
const skipMirror = argv.includes('--skip-mirror');
const desktopFlag = argv.indexOf('--desktop');
if (desktopFlag >= 0 && (!argv[desktopFlag + 1] || argv[desktopFlag + 1].startsWith('--'))) {
  console.error('--desktop needs a path.');
  process.exit(2);
}
const desktopRoot = path.resolve(
  desktopFlag >= 0
    ? argv[desktopFlag + 1]
    : process.env.CONTRAIL_DESKTOP_ROOT || path.join(serverRoot, '..', '..', 'desktop'),
);
const desktopSrc = path.join(desktopRoot, 'packages', 'engine', 'src');

// ── What must match ──────────────────────────────────────────────────────

/**
 * [plugin file, desktop file, start anchor, end anchor] — paths relative to
 * each engine's src/. Anchors are matched against the EVALUATED literal
 * text, so they may contain apostrophes and `${}` placeholders.
 */
const TEXT_TUPLES = [
  // S44 — run_agent_eval / AiTestingDefinition describes and refusals.
  ['tools/deploy.ts', 'capabilities/deploy.ts', 'AiEvaluationDefinition (legacy', 'through run_agent_eval.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Start and poll an Agentforce agent test run', 'Testing Center requires an ACTIVE agent version'],
  ['tools/data.ts', 'capabilities/data.ts', 'Run id from a previous submit', 'if the prefix differs).'],
  ['tools/data.ts', 'capabilities/data.ts', 'The test definition DeveloperName to run', 'Exactly one of eval, run_id.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Force a runner instead of detecting it', 'lacks metadata_read.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Cannot tell which runner issued run_id', 'pass runner explicitly.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Runner detection reads the org', 'Nothing was started.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Submitted to the Agentforce Studio runner', 'poll, sparingly.'],
  ['tools/data.ts', 'capabilities/data.ts', 'Agentforce Studio runner is BETA:', 'read raw).'],

  // S45 — the four describe edits (validate_deploy live diff; execute_deploy
  // target check + revert package; dml_execute and agent_activation_execute
  // target checks).
  ['tools/deploy.ts', 'capabilities/deploy.ts', 'Live diff (real validations only, never dry_run)', 'the restorable bytes become its revert package.'],
  ['tools/deploy.ts', 'capabilities/deploy.ts', "Target check: before claiming the code, Contrail re-lists the package's members", 'the deploy still runs and target_check says the check did not happen.'],
  ['tools/deploy.ts', 'capabilities/deploy.ts', "Revert package: on success the result's revert_package", 'a revert is its own validate_deploy.'],
  ['tools/deploy.ts', 'capabilities/deploy.ts', 'Target check: before claiming the code, Contrail re-runs the preview query', 'the write still runs and target_check says the check did not happen.'],
  ['tools/deploy.ts', 'capabilities/deploy.ts', "Target check: before claiming the code, Contrail re-reads the agent version's Status", 'the change still runs and target_check says the check did not happen.'],

  // S45 — the TARGET MOVED refusals (one text source, preimage.ts).
  ['deploy/preimage.ts', 'deploy/preimage.ts', 'TARGET MOVED — not executed, and this code is now void.', 'is not caught.'],
  ['deploy/preimage.ts', 'deploy/preimage.ts', '(the approval showed', 'and get a fresh code.'],
  ['deploy/preimage.ts', 'deploy/preimage.ts', 'SELECT Status at', 'Re-run agent_activation_propose.'],
  ['deploy/preimage.ts', 'deploy/preimage.ts', 'the approval was based on the version last modified at', 'minus a 5-second ordering margin)'],
  ['deploy/preimage.ts', 'deploy/preimage.ts', 'within 5 seconds before this', 'minus a 5-second ordering margin)'],
  // S45 — the revert README / result note (one text source, preimage.ts).
  ['deploy/preimage.ts', 'deploy/preimage.ts', 'Before submitting this deploy (whose outcome Contrail lost track of', 'in one package.'],

  // S45 — hand-mirrored engine.ts texts.
  ['deploy/engine.ts', 'deploy/engine.ts', 'Contrail could not re-read the org to confirm nothing had moved', 'may not describe what was overwritten.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No live baseline was captured when this package was validated', 'ran without a target check.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'This code was already voided and was not executed — ', 'This code was already voided and was not executed — '],
  ['deploy/engine.ts', 'deploy/engine.ts', 'EXISTS IN TARGET — this deploy OVERWRITES a live', '; the diff below is against the live version.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'NOT IN TARGET — your snapshot has', 'This deploy CREATES it rather than modifying it.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'CHANGED IN TARGET SINCE YOUR SNAPSHOT — the diff below is against the LIVE version', 'so any diff below is against your snapshot.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'live bytes differ from your snapshot (retrieved', 'Contrail cannot say who or when.'],
  ['deploy/engine.ts', 'deploy/engine.ts', "this member's last-modified stamp is within a minute of when your snapshot was taken", 'Contrail cannot say who or when.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'dml_propose recorded no before-values Contrail could compare against', 'this write ran without a target check.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No starting status was recorded when this change was proposed', 'this change ran without a target check.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'not present in the target (retrieved', 'whether this delete fails or no-ops'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'component(s) changed in', 'except rows labelled "diff vs your snapshot".'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'LIVE COMPARISON UNAVAILABLE (', 'local snapshot only.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'Live diff is against the org (retrieved', 'will report them as unchecked.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'Contrail lost track of this deploy (', 'package was validated.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No member could be compared (each one', 'without a target check.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'bulk loads are not re-checked before executing', 'nothing to compare against'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'the Tooling live check for', 'from the live Metadata API retrieve.'],
  ['deploy/engine.ts', 'deploy/engine.ts', '(live retrieve) and this envelope is', 'or use a new name.'],

  // S45 — hand-mirrored engine.ts texts: the diff summary lines, row detail,
  // revert notes and moved notes.
  ['deploy/engine.ts', 'deploy/engine.ts', 'diff vs live org (retrieved', ')'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'diff vs your snapshot (', ')'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'identical to the live version', 'identical to the live version'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'no structural differences (formatting', 'comments only)'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'too large for a line-by-line diff', 'counts only'],
  ['deploy/engine.ts', 'deploy/engine.ts', "diff body omitted — this page's 150 KB diff budget", 'still counts this row'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'last modified in the org by', ' at '],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No revert package: this request was validated without a live pre-image retrieve', 'what the org had before.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No revert package: the live pre-image retrieve was unavailable', 'that could restore a state the org never had.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No revert package: Contrail could not write the pre-image files', 'was validated ('],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No revert package: the pre-image files Contrail wrote at validate', 'are no longer under '],
  ['deploy/engine.ts', 'deploy/engine.ts', 'No revert package: Contrail could not finalize the revert files', 'whether a revert-plan.json is there.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'Nothing was deployed and this confirmation code is void.', 'get a fresh code.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'Nothing was written and this confirmation code is void.', 'get a fresh code.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'Nothing was changed and this confirmation code is void.', 'get a fresh code.'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'no fixed org target to re-check', 'no fixed org target to re-check'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'an insert has no existing record to re-check', 'an insert has no existing record to re-check'],
  ['deploy/engine.ts', 'deploy/engine.ts', 'This card covers the first', 'not shown: '],

  // S45 — the approval page's superseded reason (pages.ts; it sits in the
  // page's inline script, inside a template literal, so the slice carries
  // that script's own quote-and-plus wrapping — pages.ts is code-identical).
  ['connect/pages.ts', 'connect/pages.ts', 'This code was replaced — by a newer validation', 'target had changed before executing.'],
];

/**
 * Byte-identical mirror units: the plan's Mirror checklist as of S45 (S46
 * adds its NEW units), plus the twin tests S45 extended. livediff /
 * targetmoved / revert are adapted twins (D7) and are not listed. preimage
 * and automation tests import only modules both engines carry with the same
 * exports — including the hand-mirrored core/paths (stagingDir) and core/db
 * (ContrailDb), as the byte-identical engine/flow/graph-search tests already
 * do; the mirrored SOURCE units import neither.
 */
const BYTE_IDENTICAL = [
  'core/grants.ts',
  'core/gate.ts',
  'core/audit.ts',
  'core/errors.ts',
  'core/notify.ts',
  'core/updateCheck.ts',
  'core/agentforceScorers.ts',
  'salesforce/bulk.ts',
  'salesforce/client.ts',
  'salesforce/flowversion.ts',
  'salesforce/metadataSoap.ts',
  'salesforce/oauth.ts',
  'salesforce/pkce.ts',
  'salesforce/tokens.ts',
  'salesforce/xml.ts',
  'deploy/csv.ts',
  'deploy/sources.ts',
  'deploy/codes.ts',
  'deploy/package.ts',
  'deploy/preimage.ts',
  'deps/extract.ts',
  'deps/graph.ts',
  'deps/orgdeps.ts',
  'deps/automation.ts',
  'diff/semantic.ts',
  'snapshot/indexer.ts',
  'snapshot/store.ts',
  'test/preimage.test.ts',
  'test/automation.test.ts',
  'test/soap.test.ts',
  'test/typecoverage.test.ts',
  'test/config.test.ts',
  'test/db.test.ts',
  'test/semantic.test.ts',
];

/** Code-identical: every non-comment line equal; comments may differ. */
const CODE_IDENTICAL = ['connect/pages.ts', 'core/config.ts'];

// ── A small JS/TS scanner: string literals and comment-free code ─────────

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'instanceof', 'yield', 'await',
]);

function unescapeLiteral(s) {
  return s.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g,
    (_, e) => {
      if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
      if (e.length === 5 && e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
      if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      switch (e) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        case '\n':
        case '\r\n': return '';
        default: return e;
      }
    },
  );
}

/**
 * Scan source text. Returns `literals` (each string/template literal's
 * evaluated value, in source order; a template's `${expr}` becomes `${}` —
 * or `${"lit"|…}` listing the literals inside the expression) and `code`
 * (the source with comments removed, newlines kept).
 */
function scan(src) {
  let i = 0;
  const n = src.length;

  function readQuoted() {
    const q = src[i];
    const start = i;
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    i = Math.min(j + 1, n);
    return { raw: src.slice(start, i), value: unescapeLiteral(src.slice(start + 1, j)) };
  }

  function readTemplate() {
    const start = i;
    let j = i + 1;
    let chunk = '';
    let value = '';
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') {
        chunk += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        value += unescapeLiteral(chunk);
        chunk = '';
        i = j + 2;
        const inner = [];
        scanCode(inner, null, true);
        value += '${' + inner.map((l) => JSON.stringify(l)).join('|') + '}';
        j = i;
        continue;
      }
      chunk += src[j++];
    }
    value += unescapeLiteral(chunk);
    i = Math.min(j + 1, n);
    return { raw: src.slice(start, i), value };
  }

  function readRegex() {
    // src[i] === '/'; returns the raw literal, or null when it is not one.
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\n') return null;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') inClass = true;
      else if (c === '/') break;
      j++;
    }
    if (j >= n) return null;
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++;
    const raw = src.slice(i, j);
    i = j;
    return raw;
  }

  /** Scan code until EOF (or, inside a template placeholder, its closing brace). */
  function scanCode(literals, code, untilBrace) {
    let depth = 0;
    let prevSig = '';
    let prevWord = '';
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && d === '*') {
        const e = src.indexOf('*/', i + 2);
        const end = e < 0 ? n : e + 2;
        if (code) code.push(src.slice(i, end).replace(/[^\n]/g, ''));
        i = end;
        continue;
      }
      if (c === "'" || c === '"') {
        const t = readQuoted();
        literals.push(t.value);
        if (code) code.push(t.raw);
        prevSig = c;
        prevWord = '';
        continue;
      }
      if (c === '`') {
        const t = readTemplate();
        literals.push(t.value);
        if (code) code.push(t.raw);
        prevSig = c;
        prevWord = '';
        continue;
      }
      if (c === '/') {
        const regexAllowed = prevWord
          ? REGEX_KEYWORDS.has(prevWord)
          : !/[)\]}'"`\w$]/.test(prevSig);
        if (regexAllowed) {
          const raw = readRegex();
          if (raw !== null) {
            if (code) code.push(raw);
            prevSig = '/';
            prevWord = '';
            continue;
          }
        }
      }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        if (code) code.push(word);
        prevWord = word;
        prevSig = word[word.length - 1];
        i = j;
        continue;
      }
      if (code) code.push(c);
      if (!/\s/.test(c)) {
        prevSig = c;
        prevWord = '';
      }
      i++;
    }
  }

  const literals = [];
  const code = [];
  scanCode(literals, code, false);
  return { literals, code: code.join('') };
}

const scanCache = new Map();
function scanFile(abs) {
  if (!scanCache.has(abs)) scanCache.set(abs, scan(fs.readFileSync(abs, 'utf8')));
  return scanCache.get(abs);
}

/** The evaluated text from `start` through `end`, or null when either anchor is absent. */
function grab(abs, start, end) {
  if (!fs.existsSync(abs)) return null;
  const text = scanFile(abs).literals.join('');
  const i = text.indexOf(start);
  if (i < 0) return null;
  const j = text.indexOf(end, i);
  if (j < 0) return null;
  return text.slice(i, j + end.length);
}

function codeLines(abs) {
  return scanFile(abs)
    .code.split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
}

function firstDifference(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k++) if (a[k] !== b[k]) return k;
  return a.length === b.length ? -1 : len;
}

const short = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);

// ── Run ──────────────────────────────────────────────────────────────────

const desktopPresent = fs.existsSync(desktopSrc);
if (!desktopPresent && !skipMirror) {
  console.error(
    `REFUSED: no desktop checkout at ${desktopRoot} (expected packages/engine/src under it). ` +
      'Point at it with --desktop <path> or CONTRAIL_DESKTOP_ROOT, or pass --skip-mirror ' +
      'explicitly to release without the mirror check.',
  );
  process.exit(2);
}
const compare = desktopPresent && !skipMirror;
console.log(
  compare
    ? `Mirror check: plugin ${pluginSrc}\n          vs desktop ${desktopSrc}`
    : `Mirror check SKIPPED (--skip-mirror): plugin-side anchors and files only (${pluginSrc})`,
);

let bad = 0;

console.log('\n── Text tuples (word-identical) ──');
for (const [pf, df, start, end] of TEXT_TUPLES) {
  const label = `${pf}: ${short(start)}`;
  const a = grab(path.join(pluginSrc, pf), start, end);
  if (!compare) {
    if (a === null) {
      bad++;
      console.log(`MISSING   ${label} (plugin anchor not found)`);
    } else console.log(`OK        ${label} (${a.length} chars, plugin only)`);
    continue;
  }
  const b = grab(path.join(desktopSrc, df), start, end);
  if (a === null || b === null) {
    bad++;
    console.log(
      `MISSING   ${label} (plugin ${a !== null ? 'yes' : 'NO'}, desktop ${df} ${b !== null ? 'yes' : 'NO'})`,
    );
    continue;
  }
  if (a === b) {
    console.log(`IDENTICAL ${label} (${a.length} chars)`);
    continue;
  }
  bad++;
  const k = firstDifference(a, b);
  console.log(
    `MISMATCH  ${label} (desktop ${df}; first difference at char ${k})\n` +
      `  plugin : …${JSON.stringify(a.slice(Math.max(0, k - 40), k + 80))}\n` +
      `  desktop: …${JSON.stringify(b.slice(Math.max(0, k - 40), k + 80))}`,
  );
}

console.log('\n── Byte-identical mirror units ──');
for (const f of BYTE_IDENTICAL) {
  const pa = path.join(pluginSrc, f);
  const da = path.join(desktopSrc, f);
  if (!fs.existsSync(pa)) {
    bad++;
    console.log(`MISSING   ${f} (plugin)`);
    continue;
  }
  if (!compare) {
    console.log(`OK        ${f} (plugin only)`);
    continue;
  }
  if (!fs.existsSync(da)) {
    bad++;
    console.log(`MISSING   ${f} (desktop)`);
    continue;
  }
  const a = fs.readFileSync(pa);
  const b = fs.readFileSync(da);
  if (a.equals(b)) {
    console.log(`IDENTICAL ${f} (${a.length} bytes)`);
    continue;
  }
  bad++;
  const k = firstDifference(a, b);
  const line = a.subarray(0, k).toString('utf8').split('\n').length;
  console.log(`MISMATCH  ${f} (${a.length} vs ${b.length} bytes; first difference at byte ${k}, line ${line})`);
}

console.log('\n── Code-identical files (comments may differ) ──');
for (const f of CODE_IDENTICAL) {
  const pa = path.join(pluginSrc, f);
  const da = path.join(desktopSrc, f);
  if (!fs.existsSync(pa)) {
    bad++;
    console.log(`MISSING   ${f} (plugin)`);
    continue;
  }
  if (!compare) {
    console.log(`OK        ${f} (plugin only)`);
    continue;
  }
  if (!fs.existsSync(da)) {
    bad++;
    console.log(`MISSING   ${f} (desktop)`);
    continue;
  }
  const a = codeLines(pa);
  const b = codeLines(da);
  const k = firstDifference(a, b);
  if (k < 0) {
    console.log(`IDENTICAL ${f} (${a.length} code lines)`);
    continue;
  }
  bad++;
  console.log(
    `MISMATCH  ${f} (${a.length} vs ${b.length} code lines; first difference at code line ${k + 1})\n` +
      `  plugin : ${JSON.stringify(short(a[k] ?? '<end of file>'))}\n` +
      `  desktop: ${JSON.stringify(short(b[k] ?? '<end of file>'))}`,
  );
}

console.log(
  bad
    ? `\n${bad} problem(s) — the mirror is NOT in step.`
    : compare
      ? '\nMirror in step.'
      : '\nPlugin side in order (desktop not compared).',
);
process.exit(bad ? 1 : 0);

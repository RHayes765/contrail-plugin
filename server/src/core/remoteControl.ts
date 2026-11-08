import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApprovalPageOptions } from '../connect/pages.js';
import type { ApprovalNotifier, NotifierStatus, NotifyOutcome } from './notify.js';
import { dataDir } from './paths.js';
import { log } from './log.js';

/**
 * S43: the Remote Control gate — push an approval code to the phone ONLY
 * while the Claude Code session it was minted in has Remote Control
 * connected. A code on a phone is useless when it cannot be typed from one,
 * so the default (`notifications.when: 'remote_control'`) holds the push back
 * otherwise. PLUGIN-ONLY: the desktop app has no Remote Control.
 *
 * How the state reaches us. A stdio MCP server cannot observe Remote Control:
 * its environment is frozen at spawn, and Claude Code documents no file,
 * setting or event for it. What a HOOK process can see, two ways:
 * (1) CLAUDE_CODE_BRIDGE_SESSION_ID in its environment — documented, Claude
 * Code ≥ 2.1.199, set while the session has an active Remote Control
 * connection and removed when it ends; (2) Claude Code's per-process session
 * record `<CLAUDE_CONFIG_DIR | ~/.claude>/sessions/<CLAUDE_PID>.json`, whose
 * `bridgeSessionId` is present while connected — observed in the Claude
 * Desktop app's Code tab (Claude Code 2.1.317, 2026-11-08), where the
 * variable is NOT exported; undocumented, so the hook trusts it only when the
 * record's sessionId equals the hook's own session_id. So Contrail runs a
 * tiny PreToolUse hook on its code-minting tools (shipped with the plugin as
 * hooks/hooks.json; installable into ~/.claude/settings.json from the
 * Settings page for the Claude Desktop extension and manual installs). The
 * hook writes a MARKER before the tool runs:
 *
 *   <dataDir>/remote-control/<tool_use_id>.json   (this call)
 *   <dataDir>/remote-control/latest.json          (most recent call)
 *   { v:1, remote_control: boolean, at: ISO, tool_name, tool_use_id,
 *     signal: 'env' | 'session_record' | 'none' }
 *
 * — a boolean, timestamps and which signal fired, never the bridge session
 * id, never tool arguments. The server samples the marker when the tool call STARTS (the
 * hook has just run; the mint may be minutes later, after org validation):
 * - when the request's `_meta` carried Claude Code's tool-use id
 *   (`claudecode/toolUseId` — observed in Claude Code, not documented, and
 *   not yet verified through the Claude Desktop extension bridge), ONLY the
 *   per-call file counts: an id with no file means the hook did not fire for
 *   this call, and borrowing another call's state would defeat the gate;
 * - with no id at all, the most recent marker for the same tool within
 *   RECENT_WINDOW_MS stands in — which can be another session's call to the
 *   same tool (documented honestly on the Settings page);
 * - otherwise "unknown" — and unknown is NOT on: the push is skipped and the
 *   tool result says why, so a human who expected one learns what to fix
 *   instead of waiting for a phone that stays silent.
 *
 * Trust model. In Claude Code the agent already has Bash and could write a
 * marker itself; that would only earn a push to the human's OWN phone, which
 * is the one destination the agent can never change. The write-safety
 * invariant (the code never reaches the agent) is untouched by anything here.
 * What S43 must NOT do is leave an executable the agent can edit where Claude
 * Code will run it: the data dir is the tree agents are TOLD to write into
 * (staging/), so the user-level hook carries its few lines of script INLINE
 * in the settings.json entry — nothing on disk — and Claude Code's own
 * settings file is the one place an agent is never to touch.
 */

/**
 * Tools whose hook report matters: the six code-minting tools (deactivate_flow
 * mints through validateDeploy), plus the two whose results show the state.
 */
export const RC_HOOKED_TOOLS = [
  'validate_deploy',
  'deactivate_flow',
  'dml_propose',
  'apex_propose',
  'agent_activation_propose',
  'bulk_load_propose',
  'list_connections',
  'open_settings',
] as const;

/**
 * The hook matcher. Server-name-agnostic on purpose: the same tools are
 * `mcp__plugin_contrail_contrail-engine__X` (plugin), `mcp__contrail-engine__X`
 * (manual mcpServers entry) and `mcp__Contrail__X` (Claude Desktop extension
 * seen from the Desktop app's Code tab). Regex characters put Claude Code's
 * matcher on its regex path; the anchors are ours.
 */
export const RC_HOOK_MATCHER = `^mcp__.*__(${RC_HOOKED_TOOLS.join('|')})$`;

/** First token of every inline hook body — how the installer recognises its own entry. */
export const RC_HOOK_SIGNATURE = 'contrail:remote-control-hook v1';

const META_TOOL_USE_ID = 'claudecode/toolUseId';
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** A same-tool marker older than this is not evidence about THIS call. */
const RECENT_WINDOW_MS = 30 * 60 * 1000;
/** Per-call marker files are swept after an hour; latest.json stays. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;
const HOOK_TIMEOUT_S = 15;

export type RcState = 'on' | 'off' | 'unknown';

export interface RcSample {
  state: RcState;
  /** 'call' = the per-call marker; 'recent' = latest.json for the same tool; 'none' = nothing usable. */
  source: 'call' | 'recent' | 'none';
  at: string | null;
}

export type UserHookState = 'installed' | 'not_installed' | 'unreadable';

/** Agent- and page-facing status: the last report, and whether the user-level hook is in place. */
export interface RcStatus {
  state: RcState;
  /** When the most recent hook report was written, whatever its age. */
  at: string | null;
  /**
   * The entry in Claude Code's USER settings.json only — the plugin's bundled
   * hook is invisible from here, so `not_installed` is the normal state of a
   * plugin install. Judge delivery by `state`.
   */
  user_hook: UserHookState;
}

interface Marker {
  remoteControl: boolean;
  at: number;
  toolName: string;
}

interface ToolCallContext {
  toolName: string;
  sample: RcSample;
}

export interface RemoteControlProbeOptions {
  /** Contrail data dir (default dataDir()). Markers live under <root>/remote-control. */
  root?: string;
  /** Claude Code's user settings file (default $CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json). */
  claudeSettingsFile?: string;
  platform?: NodeJS.Platform;
  /** Clock for marker-age decisions (tests). Pruning compares file mtimes against it, so an injected clock should stay near real time. */
  now?: () => number;
}

export class RemoteControlProbe {
  private readonly als = new AsyncLocalStorage<ToolCallContext>();
  readonly root: string;
  readonly claudeSettingsFile: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(opts: RemoteControlProbeOptions = {}) {
    this.root = opts.root ?? dataDir();
    this.claudeSettingsFile = opts.claudeSettingsFile ?? claudeSettingsPath();
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
  }

  get markerDir(): string {
    return path.join(this.root, 'remote-control');
  }

  /**
   * Run a tool handler with the Remote Control state sampled NOW, at call
   * start — the hook has just written its marker, and the mint may be minutes
   * away. `extra` is the MCP request extra; Claude Code puts its tool-use id
   * in `_meta`.
   */
  run<T>(extra: { _meta?: Record<string, unknown> } | undefined, toolName: string, fn: () => T): T {
    const raw = extra?._meta?.[META_TOOL_USE_ID];
    const toolUseId = typeof raw === 'string' && TOOL_USE_ID_RE.test(raw) ? raw : null;
    const sample = this.sample(toolUseId, toolName);
    return this.als.run({ toolName, sample }, fn);
  }

  /** The sample taken when the current tool call started, or null outside a wrapped call. */
  current(): RcSample | null {
    return this.als.getStore()?.sample ?? null;
  }

  sample(toolUseId: string | null, toolName: string): RcSample {
    this.prune();
    if (toolUseId) {
      // An id means Claude Code identified this call; the hook, if it ran,
      // wrote THIS file. Nothing there = no report for this call. Full stop.
      const own = this.readMarker(path.join(this.markerDir, `${toolUseId}.json`));
      return own
        ? { state: own.remoteControl ? 'on' : 'off', source: 'call', at: new Date(own.at).toISOString() }
        : { state: 'unknown', source: 'none', at: null };
    }
    const latest = this.readMarker(path.join(this.markerDir, 'latest.json'));
    if (latest && this.now() - latest.at <= RECENT_WINDOW_MS && toolNameMatches(latest.toolName, toolName)) {
      return { state: latest.remoteControl ? 'on' : 'off', source: 'recent', at: new Date(latest.at).toISOString() };
    }
    return { state: 'unknown', source: 'none', at: null };
  }

  /** Status for list_connections and the Settings page. */
  status(): RcStatus {
    const latest = this.readMarker(path.join(this.markerDir, 'latest.json'));
    const fresh = latest !== null && this.now() - latest.at <= RECENT_WINDOW_MS;
    return {
      state: latest && fresh ? (latest.remoteControl ? 'on' : 'off') : 'unknown',
      at: latest ? new Date(latest.at).toISOString() : null,
      user_hook: userHookState(this.claudeSettingsFile),
    };
  }

  // ---- the user-level hook -------------------------------------------------

  /**
   * The settings.json entry the installer writes. Exec form (a real binary
   * plus an args array — no shell tokenisation anywhere) with the hook's
   * script INLINE: `powershell.exe -Command <body>` on Windows, `sh -c <body>`
   * elsewhere. Nothing executable lands on disk (see the trust model above);
   * the marker directory is baked in so CONTRAIL_DATA_DIR overrides hold.
   */
  userHookEntry(): HookEntry {
    const handler: HookHandler =
      this.platform === 'win32'
        ? {
            type: 'command',
            command: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powerShellHookBody(this.markerDir)],
            timeout: HOOK_TIMEOUT_S,
          }
        : { type: 'command', command: 'sh', args: ['-c', shHookBody(this.markerDir)], timeout: HOOK_TIMEOUT_S };
    return { matcher: RC_HOOK_MATCHER, hooks: [handler] };
  }

  hookState(): UserHookState {
    return userHookState(this.claudeSettingsFile);
  }

  /**
   * Add the hook to Claude Code's user settings. Everything else in the file
   * is preserved (re-serialised as 2-space JSON); a file that is not valid
   * JSON — or whose `hooks` / `hooks.PreToolUse` have the wrong shape — is
   * never touched (the error says so); the first write over a file Contrail
   * has never touched keeps a backup of it beside it; the write is atomic and
   * keeps the file's identity (symlink target) and mode. An older Contrail
   * entry is replaced, never duplicated. Claude Code watches its settings
   * files, so running sessions pick the hook up.
   */
  installUserHook(): { changed: boolean; file: string; backup: string | null } {
    const file = this.claudeSettingsFile;
    const settings = readSettings(file);
    const { hooks, pre } = hookLists(settings, file);
    const entry = this.userHookEntry();
    const ours = pre.filter(isOurEntry);
    const kept = pre.filter((e) => !isOurEntry(e));
    if (ours.length === 1 && deepEqual(ours[0], entry)) return { changed: false, file, backup: null };
    hooks.PreToolUse = [...kept, entry];
    settings.hooks = hooks;
    const backup = writeSettings(file, settings, { touchedBefore: ours.length > 0 });
    return { changed: true, file, backup };
  }

  removeUserHook(): { changed: boolean; file: string } {
    const file = this.claudeSettingsFile;
    if (!fs.existsSync(file)) return { changed: false, file };
    const settings = readSettings(file);
    const { hooks, pre } = hookLists(settings, file);
    const kept = pre.filter((e) => !isOurEntry(e));
    if (kept.length === pre.length) return { changed: false, file };
    if (kept.length > 0) hooks.PreToolUse = kept;
    else delete hooks.PreToolUse;
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
    writeSettings(file, settings, { touchedBefore: true });
    return { changed: true, file };
  }

  // ---- internals ----------------------------------------------------------

  private readMarker(file: string): Marker | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Record<string, unknown>;
    if (m.v !== 1 || typeof m.remote_control !== 'boolean' || typeof m.at !== 'string') return null;
    const at = Date.parse(m.at);
    if (Number.isNaN(at)) return null;
    // A stamp from the future (skew, or a forged file) would read as fresh
    // forever; the hook and the server share one clock, so a minute is ample.
    if (at > this.now() + 60_000) return null;
    return { remoteControl: m.remote_control, at, toolName: typeof m.tool_name === 'string' ? m.tool_name : '' };
  }

  private prune(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.markerDir);
    } catch {
      return;
    }
    const cutoff = this.now() - PRUNE_AFTER_MS;
    for (const name of names) {
      if (name === 'latest.json' || !name.endsWith('.json')) continue;
      const file = path.join(this.markerDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * The notifier the plugin actually wires: Pushover behind the gate. Method
 * 'none' and `when: 'always'` pass straight through; otherwise the sample
 * taken at the start of the current tool call decides. Outside a wrapped
 * call (nothing sampled) the state is unknown, which skips — never sends.
 */
export class GatedNotifier implements ApprovalNotifier {
  constructor(
    private readonly inner: ApprovalNotifier,
    private readonly probe: RemoteControlProbe,
  ) {}

  async notify(view: ApprovalPageOptions, opts: { includeCode: boolean }): Promise<NotifyOutcome> {
    // status() also folds the on-disk section into the live config (S42), so
    // a `when` saved on the other surface applies to this send.
    const status = this.inner.status();
    if (status.method !== 'pushover' || status.when === 'always') return this.inner.notify(view, opts);
    const sample = this.probe.current() ?? { state: 'unknown' as const, source: 'none' as const, at: null };
    if (sample.state === 'on') return this.inner.notify(view, opts);
    log('info', 'approval notification held back by the Remote Control gate', {
      state: sample.state,
      source: sample.source,
    });
    return {
      status: 'skipped',
      reason: sample.state === 'off' ? 'remote_control_off' : 'remote_control_unknown',
    };
  }

  sendTest(): Promise<{ ok: boolean; message: string }> {
    return this.inner.sendTest();
  }

  status(): NotifierStatus {
    return this.inner.status();
  }

  resetCircuit(): void {
    this.inner.resetCircuit();
  }
}

// ---- settings.json plumbing --------------------------------------------------

interface HookHandler {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
}

interface HookEntry {
  matcher: string;
  hooks: HookHandler[];
}

export function claudeSettingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

export function userHookState(file: string): UserHookState {
  if (!fs.existsSync(file)) return 'not_installed';
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(file);
  } catch {
    return 'unreadable';
  }
  const hooks = asObject(settings.hooks);
  const pre = hooks && Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  return pre.some(isOurEntry) ? 'installed' : 'not_installed';
}

/**
 * Ours = any handler that carries the inline hook signature, or runs one of
 * Contrail's hook scripts by path (`…/hooks/remote-control.{mjs,ps1,sh}`,
 * whatever the root is called — a data dir need not contain "contrail").
 */
export function isOurEntry(entry: unknown): boolean {
  const e = asObject(entry);
  if (!e || !Array.isArray(e.hooks)) return false;
  return (e.hooks as unknown[]).some((h) => {
    const handler = asObject(h);
    if (!handler) return false;
    const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].filter(
      (v): v is string => typeof v === 'string',
    );
    return parts.some(
      (p) => p.includes(RC_HOOK_SIGNATURE) || /(^|[\\/])hooks[\\/]remote-control\.(mjs|ps1|sh)$/i.test(p),
    );
  });
}

function readSettings(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — nothing was changed. ` +
        'Fix the file, then try again.',
    );
  }
  const obj = asObject(parsed);
  if (!obj) throw new Error(`${file} does not hold a JSON object — nothing was changed.`);
  return obj;
}

/** The `hooks` object and its `PreToolUse` list, refusing shapes Claude Code itself would reject. */
function hookLists(
  settings: Record<string, unknown>,
  file: string,
): { hooks: Record<string, unknown>; pre: unknown[] } {
  const hooks = settings.hooks === undefined ? {} : asObject(settings.hooks);
  if (!hooks) throw new Error(`${file}: "hooks" is not an object — fix the file, then try again. Nothing was changed.`);
  const pre = hooks.PreToolUse === undefined ? [] : hooks.PreToolUse;
  if (!Array.isArray(pre)) {
    throw new Error(`${file}: "hooks.PreToolUse" is not an array — fix the file, then try again. Nothing was changed.`);
  }
  return { hooks, pre: [...pre] };
}

/**
 * Atomic write that keeps the file's identity and mode. `touchedBefore` is
 * whether the current content already carried a Contrail entry — the backup
 * is the file as it was BEFORE Contrail ever touched it, so it is written
 * once, on the first install over a pre-existing file, and never again.
 * Returns the backup's path when one exists beside the file (written now or
 * earlier), else null — so a banner never promises a file that is not there.
 */
function writeSettings(
  file: string,
  settings: Record<string, unknown>,
  opts: { touchedBefore: boolean },
): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write THROUGH a symlink (dotfiles setups) and keep the original's mode:
  // settings.json may hold `env` secrets and be 0600.
  let target = file;
  let mode: number | null = null;
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    try {
      target = fs.realpathSync(file);
      mode = fs.statSync(target).mode & 0o777;
    } catch {
      target = file;
    }
    const candidate = `${target}.contrail-backup`;
    if (!opts.touchedBefore && !fs.existsSync(candidate)) {
      try {
        fs.copyFileSync(target, candidate);
      } catch {
        /* the backup is a courtesy — reported honestly below */
      }
    }
    if (fs.existsSync(candidate)) backup = candidate;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', ...(mode !== null ? { mode } : {}) });
    if (mode !== null) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {
        /* Windows: no mode bits */
      }
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    // Never leave a stray .tmp in Claude Code's config directory.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
  return backup;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Structural equality for plain JSON (Claude Code rewrites settings.json and may reorder keys). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const oa = asObject(a);
  const ob = asObject(b);
  if (!oa || !ob) return false;
  const ka = Object.keys(oa);
  const kb = Object.keys(ob);
  return ka.length === kb.length && ka.every((k) => k in ob && deepEqual(oa[k], ob[k]));
}

function toolNameMatches(markerTool: string, toolName: string): boolean {
  return markerTool === toolName || markerTool.endsWith(`__${toolName}`);
}

// ---- the inline hook bodies ---------------------------------------------------
//
// Both do exactly what hooks/remote-control.mjs does: read the PreToolUse JSON
// from stdin, take session_id / tool_use_id / tool_name, decide ON from either
// signal (the environment variable, or the session record whose sessionId
// matches), write latest.json and <id>.json, exit 0. No double quotes anywhere
// in either body: the exec form hands the body to the interpreter as ONE
// argument, and a body free of `"` survives every quoting layer between a JSON
// string and a Windows command line.

/** PowerShell 5.1-compatible, one line (newlines inside a Windows argument are not worth the risk). */
export function powerShellHookBody(markerDir: string): string {
  const dir = markerDir.replace(/'/g, "''");
  return [
    `<# ${RC_HOOK_SIGNATURE} #>`,
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '$raw = [Console]::In.ReadToEnd()',
    // Garbage or empty stdin still records the state (as the Node flavour does).
    '$j = $null',
    'try { $j = $raw | ConvertFrom-Json } catch { $j = $null }',
    "$id = if ($j) { [string]$j.tool_use_id } else { '' }",
    "if ($id -notmatch '^[A-Za-z0-9_-]{1,80}$') { $id = '' }",
    "$tool = if ($j) { ([string]$j.tool_name) -replace '[^A-Za-z0-9_.-]', '' } else { '' }",
    'if ($tool.Length -gt 120) { $tool = $tool.Substring(0, 120) }',
    "$sid = if ($j) { [string]$j.session_id } else { '' }",
    "$signal = 'none'",
    "if (-not [string]::IsNullOrEmpty($env:CLAUDE_CODE_BRIDGE_SESSION_ID)) { $signal = 'env' }",
    // Signal 2: Claude Code's session record for this very process (PID + session id must both
    // match). A plain second `if`, not `elseif`: the statements are joined with `; `, and
    // PowerShell rejects a separator between `}` and `elseif`.
    "if ($signal -eq 'none' -and $sid -and $env:CLAUDE_PID -match '^[0-9]{1,10}$') {",
    "$cfg = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR.Trim() } else { Join-Path $env:USERPROFILE '.claude' }",
    "$sf = Join-Path (Join-Path $cfg 'sessions') ($env:CLAUDE_PID + '.json')",
    'try { if (Test-Path -LiteralPath $sf) { $rec = Get-Content -LiteralPath $sf -Raw | ConvertFrom-Json',
    "if ($rec -and ([string]$rec.sessionId) -eq $sid -and -not [string]::IsNullOrEmpty([string]$rec.bridgeSessionId)) { $signal = 'session_record' } } } catch { }",
    '}',
    "$on = $signal -ne 'none'",
    `$dir = '${dir}'`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    "$body = @{ v = 1; remote_control = $on; at = [DateTime]::UtcNow.ToString('o'); tool_name = $tool; tool_use_id = $id; signal = $signal } | ConvertTo-Json -Compress",
    '$enc = New-Object System.Text.UTF8Encoding($false)',
    "[IO.File]::WriteAllText((Join-Path $dir 'latest.json'), $body, $enc)",
    "if ($id) { [IO.File]::WriteAllText((Join-Path $dir ($id + '.json')), $body, $enc) }",
    '} catch { }',
    'exit 0',
  ].join('; ');
}

/**
 * POSIX sh. Claude Code's hook input is JSON, compact or pretty-printed, with
 * the documented key order hook_event_name, tool_name, tool_input,
 * tool_use_id. Without a JSON parser the body takes the FIRST `tool_name`
 * occurrence (the top-level one precedes tool_input) and the LAST
 * `tool_use_id` occurrence (the top-level one follows tool_input), so a
 * decoy key inside the tool's own arguments cannot win either. `grep -o`
 * lists matches in document order on GNU and BSD alike. A decoy can at
 * worst make THIS call read as unknown.
 */
export function shHookBody(markerDir: string): string {
  const dir = markerDir.replace(/'/g, "'\\''");
  const pick = (key: string, cls: string, max: number, which: 'head' | 'tail') =>
    `$(printf '%s' "$input" | grep -o '"${key}"[[:space:]]*:[[:space:]]*"${cls}\\{1,${max}\\}"' | ${which} -n 1 | sed 's/.*"\\(${cls}*\\)"$/\\1/')`;
  return [
    `# ${RC_HOOK_SIGNATURE}`,
    'input=$(cat)',
    `id=${pick('tool_use_id', '[A-Za-z0-9_-]', 80, 'tail')}`,
    `tool=${pick('tool_name', '[A-Za-z0-9_.-]', 120, 'head')}`,
    `sid=${pick('session_id', '[A-Za-z0-9_-]', 80, 'head')}`,
    'signal=none',
    'if [ -n "$CLAUDE_CODE_BRIDGE_SESSION_ID" ]; then signal=env',
    // Signal 2: Claude Code's session record for this very process (PID + session id must both match).
    'elif [ -n "$sid" ] && printf \'%s\' "$CLAUDE_PID" | grep -q \'^[0-9]\\{1,10\\}$\'; then',
    '  cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; sf="$cfg/sessions/$CLAUDE_PID.json"',
    '  if [ -f "$sf" ] && grep -q "\\"sessionId\\"[[:space:]]*:[[:space:]]*\\"$sid\\"" "$sf" 2>/dev/null && grep -q \'"bridgeSessionId"[[:space:]]*:[[:space:]]*"[^"][^"]*"\' "$sf" 2>/dev/null; then signal=session_record; fi',
    'fi',
    'if [ "$signal" != none ]; then on=true; else on=false; fi',
    `dir='${dir}'`,
    'mkdir -p "$dir" 2>/dev/null || exit 0',
    'at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `body=$(printf '{"v":1,"remote_control":%s,"at":"%s","tool_name":"%s","tool_use_id":"%s","signal":"%s"}' "$on" "$at" "$tool" "$id" "$signal")`,
    'printf \'%s\' "$body" > "$dir/latest.json" 2>/dev/null',
    'if [ -n "$id" ]; then printf \'%s\' "$body" > "$dir/$id.json" 2>/dev/null; fi',
    'exit 0',
  ].join('\n');
}

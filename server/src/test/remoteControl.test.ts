import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { ApprovalPageOptions } from '../connect/pages.js';
import {
  GatedNotifier,
  RC_HOOKED_TOOLS,
  RC_HOOK_MATCHER,
  RC_HOOK_SIGNATURE,
  RemoteControlProbe,
  claudeSettingsPath,
  deepEqual,
  isOurEntry,
  powerShellHookBody,
  shHookBody,
  userHookState,
} from '../core/remoteControl.js';

/**
 * S43: the Remote Control gate. What these pin: the probe reads exactly the
 * marker the hook writes (a present tool-use id selects THAT call's file and
 * nothing else; with no id a recent same-tool report stands in; otherwise
 * unknown — and unknown never sends); the three hook flavours (plugin node
 * script, inline PowerShell, inline sh) write the same marker from the same
 * stdin + environment, garbage stdin included; the user-hook installer edits
 * Claude Code's settings.json surgically and recognises its own entry
 * whatever the data dir is called; the gated notifier passes 'always' and
 * method 'none' straight through.
 */

const HOOK_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'remote-control.mjs');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

let tmp: string;
let probe: RemoteControlProbe;

beforeEach(() => {
  // The root deliberately does NOT contain "contrail": recognition must not depend on the path's spelling.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfe-rc-'));
  probe = new RemoteControlProbe({ root: tmp, claudeSettingsFile: path.join(tmp, 'claude-home', 'settings.json'), platform: 'win32' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function marker(opts: { id?: string; on: boolean; tool?: string; at?: Date; latest?: boolean }): void {
  const dir = path.join(tmp, 'remote-control');
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({
    v: 1,
    remote_control: opts.on,
    at: (opts.at ?? new Date()).toISOString(),
    tool_name: opts.tool ?? 'mcp__plugin_contrail_contrail-engine__validate_deploy',
    tool_use_id: opts.id ?? '',
  });
  if (opts.id) fs.writeFileSync(path.join(dir, `${opts.id}.json`), body);
  if (opts.latest ?? true) fs.writeFileSync(path.join(dir, 'latest.json'), body);
}

function view(): ApprovalPageOptions {
  return {
    kind: 'deploy',
    code: 'ABCD-2345',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    org: { alias: 'a', orgName: null, orgType: 'sandbox', instanceUrl: '' },
    changes: [],
    destructive: [],
    results: [],
    blast: [],
    warnings: [],
  };
}

class Inner implements ApprovalNotifier {
  calls = 0;
  method: 'none' | 'pushover' = 'pushover';
  when: 'remote_control' | 'always' = 'remote_control';
  async notify(): Promise<NotifyOutcome> {
    this.calls += 1;
    return this.method === 'none' ? { status: 'off' } : { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: this.method, when: this.when, configured: true };
  }
  resetCircuit() {}
}

describe('RemoteControlProbe.sample', () => {
  it('a present tool-use id selects THAT call\'s marker — on, off, or (no file) unknown, never a neighbour\'s', () => {
    marker({ id: 'toolu_a', on: true });
    marker({ id: 'toolu_b', on: false });
    expect(probe.sample('toolu_a', 'validate_deploy')).toMatchObject({ state: 'on', source: 'call' });
    expect(probe.sample('toolu_b', 'validate_deploy')).toMatchObject({ state: 'off', source: 'call' });
    // latest.json says ON for this very tool, but the id had no file: the hook did not fire for this call.
    expect(probe.sample('toolu_missing', 'validate_deploy')).toEqual({ state: 'unknown', source: 'none', at: null });
  });

  it('with no id, a recent latest.json for the SAME tool (any server name) stands in; another tool or a stale one does not', () => {
    marker({ on: true, tool: 'mcp__Contrail__validate_deploy' });
    expect(probe.sample(null, 'validate_deploy')).toMatchObject({ state: 'on', source: 'recent' });
    expect(probe.sample(null, 'dml_propose')).toMatchObject({ state: 'unknown', source: 'none' });
    marker({ on: true, tool: 'mcp__Contrail__validate_deploy', at: new Date(Date.now() - 31 * 60_000) });
    expect(probe.sample(null, 'validate_deploy')).toMatchObject({ state: 'unknown', source: 'none' });
  });

  it('is unknown with no directory, a malformed marker, or a wrong version — never a throw, never "on"', () => {
    expect(probe.sample('toolu_x', 'validate_deploy')).toEqual({ state: 'unknown', source: 'none', at: null });
    fs.mkdirSync(path.join(tmp, 'remote-control'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'remote-control', 'toolu_bad.json'), '{not json');
    fs.writeFileSync(path.join(tmp, 'remote-control', 'latest.json'), JSON.stringify({ v: 2, remote_control: true, at: new Date().toISOString() }));
    expect(probe.sample('toolu_bad', 'validate_deploy').state).toBe('unknown');
    expect(probe.sample(null, 'validate_deploy').state).toBe('unknown');
    fs.writeFileSync(path.join(tmp, 'remote-control', 'latest.json'), JSON.stringify({ v: 1, remote_control: 'yes', at: new Date().toISOString() }));
    expect(probe.sample(null, 'validate_deploy').state).toBe('unknown');
    // A stamp from the future would read as fresh forever: unusable, in sample() and status() alike.
    marker({ id: 'toolu_future', on: true, at: new Date(Date.now() + 10 * 60_000) });
    expect(probe.sample('toolu_future', 'validate_deploy').state).toBe('unknown');
    expect(probe.sample(null, 'validate_deploy').state).toBe('unknown');
    expect(probe.status().state).toBe('unknown');
  });

  it('prunes per-call markers older than an hour and keeps latest.json', () => {
    marker({ id: 'toolu_old', on: true });
    const old = path.join(tmp, 'remote-control', 'toolu_old.json');
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(path.join(tmp, 'remote-control', 'latest.json'), past, past);
    marker({ id: 'toolu_new', on: true, latest: false });
    probe.sample('toolu_new', 'validate_deploy');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'remote-control', 'toolu_new.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'remote-control', 'latest.json'))).toBe(true);
  });

  it('run() samples at call start and current() reads it inside the call only; a malformed _meta id is never a file name', () => {
    marker({ id: 'toolu_run', on: true });
    expect(probe.current()).toBeNull();
    const seen = probe.run({ _meta: { 'claudecode/toolUseId': 'toolu_run' } }, 'validate_deploy', () => probe.current());
    expect(seen).toMatchObject({ state: 'on', source: 'call' });
    // Marker changes after call start do not change the sampled state.
    const stable = probe.run({ _meta: { 'claudecode/toolUseId': 'toolu_run' } }, 'validate_deploy', () => {
      marker({ id: 'toolu_run', on: false });
      return probe.current();
    });
    expect(stable).toMatchObject({ state: 'on' });
    // A malformed id is treated as "no id": the recent same-tool report answers, and nothing is read by that name.
    expect(probe.run({ _meta: { 'claudecode/toolUseId': '../evil' } }, 'validate_deploy', () => probe.current())).toMatchObject({
      source: 'recent',
    });
    fs.rmSync(path.join(tmp, 'remote-control', 'latest.json'));
    expect(probe.run({ _meta: { 'claudecode/toolUseId': '../evil' } }, 'validate_deploy', () => probe.current())).toMatchObject({
      state: 'unknown',
    });
    expect(probe.run(undefined, 'validate_deploy', () => probe.current())).toMatchObject({ state: 'unknown' });
    expect(probe.current()).toBeNull();
  });

  it('status() reports the last report (fresh → its state, stale → unknown but dated) and the user hook', () => {
    expect(probe.status()).toEqual({ state: 'unknown', at: null, user_hook: 'not_installed' });
    marker({ on: false });
    expect(probe.status()).toMatchObject({ state: 'off', user_hook: 'not_installed' });
    const at = new Date(Date.now() - 40 * 60_000);
    marker({ on: true, at });
    expect(probe.status()).toMatchObject({ state: 'unknown', at: at.toISOString() });
  });
});

describe('GatedNotifier', () => {
  it("'always' and method 'none' pass straight through; the gate decides only for 'remote_control' + pushover", async () => {
    const inner = new Inner();
    const gated = new GatedNotifier(inner, probe);
    inner.when = 'always';
    expect(await gated.notify(view(), { includeCode: true })).toEqual({ status: 'sent' });
    inner.when = 'remote_control';
    inner.method = 'none';
    expect(await gated.notify(view(), { includeCode: true })).toEqual({ status: 'off' });
    expect(inner.calls).toBe(2);
    inner.method = 'pushover';
    // Outside any wrapped call nothing was sampled → unknown → skipped, never sent.
    expect(await gated.notify(view(), { includeCode: true })).toEqual({ status: 'skipped', reason: 'remote_control_unknown' });
    expect(inner.calls).toBe(2);
    marker({ id: 'toolu_g1', on: false });
    expect(await probe.run({ _meta: { 'claudecode/toolUseId': 'toolu_g1' } }, 'validate_deploy', () => gated.notify(view(), { includeCode: true }))).toEqual({
      status: 'skipped',
      reason: 'remote_control_off',
    });
    marker({ id: 'toolu_g2', on: true });
    expect(await probe.run({ _meta: { 'claudecode/toolUseId': 'toolu_g2' } }, 'validate_deploy', () => gated.notify(view(), { includeCode: true }))).toEqual({
      status: 'sent',
    });
    expect(inner.calls).toBe(3);
    expect(gated.status()).toEqual(inner.status());
  });
});

describe('hook flavours', () => {
  // Claude Code's documented key order: hook_event_name, tool_name, tool_input, tool_use_id —
  // with decoys for BOTH keys inside the tool's own arguments (zod strips unknown keys, so an
  // agent could add them without the call failing).
  const compact = (toolUseId: string, toolName = 'mcp__Contrail__validate_deploy') =>
    JSON.stringify({
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {
        connection: 'x',
        components: [{ content: '"tool_use_id":"toolu_DECOY" "tool_name":"mcp__Contrail__DECOYTOOL"' }],
        tool_name: 'mcp__Contrail__ARGDECOY',
        tool_use_id: 'toolu_ARGDECOY',
      },
      tool_use_id: toolUseId,
    });
  const pretty = (toolUseId: string) => JSON.stringify(JSON.parse(compact(toolUseId)), null, 2);

  /**
   * The hook's environment: the documented variable when `on`, plus a Claude
   * config dir of our own (so the real ~/.claude/sessions is never read) and
   * a CLAUDE_PID the session-record cases key their fixture file on.
   */
  function envWith(on: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONTRAIL_DATA_DIR: tmp,
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-cfg'),
      CLAUDE_PID: '4242',
      USERPROFILE: tmp,
      HOME: tmp,
    };
    if (on) env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'session_abc';
    else delete env.CLAUDE_CODE_BRIDGE_SESSION_ID;
    return env;
  }

  /** Claude Code's per-process session record (the Desktop app's signal). */
  function sessionRecord(fields: Record<string, unknown> | null): void {
    const dir = path.join(tmp, 'claude-cfg', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '4242.json');
    if (fields === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify({ pid: 4242, kind: 'interactive', ...fields }));
  }

  function readMarker(name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(tmp, 'remote-control', name), 'utf8')) as Record<string, unknown>;
  }

  /** What every flavour must do, driven through the given runner. */
  function behavesLikeTheHook(run: (input: string, on: boolean) => ReturnType<typeof spawnSync>, tag: string): void {
    const on = run(compact(`toolu_${tag}1`), true);
    expect(on.status).toBe(0);
    expect(String(on.stdout)).toBe(''); // a silent hook never influences the tool call
    expect(readMarker(`toolu_${tag}1.json`)).toMatchObject({ v: 1, remote_control: true, tool_name: 'mcp__Contrail__validate_deploy', tool_use_id: `toolu_${tag}1` });
    expect(readMarker('latest.json')).toMatchObject({ remote_control: true });
    expect(JSON.stringify(readMarker('latest.json'))).not.toContain('session_abc');

    expect(readMarker(`toolu_${tag}1.json`)).toMatchObject({ signal: 'env' });

    const off = run(compact(`toolu_${tag}2`), false);
    expect(off.status).toBe(0);
    expect(readMarker(`toolu_${tag}2.json`)).toMatchObject({ remote_control: false, signal: 'none' });

    // Signal 2 — the Desktop app's case: no variable, but Claude Code's session record for
    // THIS process says the bridge is up for THIS session id.
    sessionRecord({ sessionId: 'sess-1', bridgeSessionId: 'session_recorded_xyz' });
    const rec = run(compact(`toolu_${tag}4`), false);
    expect(rec.status).toBe(0);
    expect(readMarker(`toolu_${tag}4.json`)).toMatchObject({ remote_control: true, signal: 'session_record' });
    expect(JSON.stringify(readMarker(`toolu_${tag}4.json`))).not.toContain('session_recorded_xyz'); // never the id
    // A record for ANOTHER session (reused PID), or one with the bridge gone, does not count.
    sessionRecord({ sessionId: 'sess-other', bridgeSessionId: 'session_recorded_xyz' });
    run(compact(`toolu_${tag}5`), false);
    expect(readMarker(`toolu_${tag}5.json`)).toMatchObject({ remote_control: false, signal: 'none' });
    sessionRecord({ sessionId: 'sess-1', bridgeSessionId: '' });
    run(compact(`toolu_${tag}6`), false);
    expect(readMarker(`toolu_${tag}6.json`)).toMatchObject({ remote_control: false, signal: 'none' });
    sessionRecord({ sessionId: 'sess-1' });
    run(compact(`toolu_${tag}7`), false);
    expect(readMarker(`toolu_${tag}7.json`)).toMatchObject({ remote_control: false, signal: 'none' });
    // The variable wins the label when both are present.
    sessionRecord({ sessionId: 'sess-1', bridgeSessionId: 'session_recorded_xyz' });
    run(compact(`toolu_${tag}8`), true);
    expect(readMarker(`toolu_${tag}8.json`)).toMatchObject({ remote_control: true, signal: 'env' });
    sessionRecord(null);

    // Pretty-printed input (Claude Code's documented example shape), decoys and all.
    const pp = run(pretty(`toolu_${tag}3`), true);
    expect(pp.status).toBe(0);
    expect(readMarker(`toolu_${tag}3.json`)).toMatchObject({ tool_use_id: `toolu_${tag}3`, tool_name: 'mcp__Contrail__validate_deploy' });
    expect(fs.readdirSync(path.join(tmp, 'remote-control')).some((f) => f.includes('DECOY'))).toBe(false);
    for (const f of fs.readdirSync(path.join(tmp, 'remote-control'))) expect(JSON.stringify(readMarker(f))).not.toContain('DECOY');

    // A garbage id → latest.json only; garbage / null / empty stdin → still exit 0 and the state is recorded.
    run(compact('../etc/passwd'), true);
    expect(fs.readdirSync(path.join(tmp, 'remote-control')).some((f) => f.includes('passwd'))).toBe(false);
    for (const junk of ['not json', 'null', '']) {
      fs.rmSync(path.join(tmp, 'remote-control', 'latest.json'), { force: true });
      const r = run(junk, true);
      expect(r.status).toBe(0);
      expect(readMarker('latest.json')).toMatchObject({ remote_control: true, tool_use_id: '' });
    }
    expect(probe.sample(`toolu_${tag}1`, 'validate_deploy').state).toBe('on');
    expect(probe.sample(`toolu_${tag}2`, 'validate_deploy').state).toBe('off');
  }

  // Each flavour spawns its interpreter seven times; under a loaded full-suite run PowerShell
  // alone needs several seconds, so these get a generous per-test timeout.
  const SPAWN_TEST_TIMEOUT = 90_000;

  it(
    'the plugin node hook (hooks/remote-control.mjs)',
    () => {
      behavesLikeTheHook((input, on) => spawnSync(process.execPath, [HOOK_MJS], { input, env: envWith(on), encoding: 'utf8' }), 'node');
    },
    SPAWN_TEST_TIMEOUT,
  );

  it.skipIf(process.platform !== 'win32')('the inline PowerShell body, run exactly as the settings.json entry runs it (Windows)', () => {
    const entry = probe.userHookEntry();
    expect(entry.hooks[0]!.command).toBe('powershell.exe');
    expect(entry.hooks[0]!.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    const body = entry.hooks[0]!.args[5]!;
    expect(body.startsWith(`<# ${RC_HOOK_SIGNATURE} #>`)).toBe(true);
    expect(body).not.toContain('"'); // survives every quoting layer unchanged
    expect(body).toContain(`$dir = '${path.join(tmp, 'remote-control')}'`);
    behavesLikeTheHook(
      (input, on) => spawnSync(entry.hooks[0]!.command, entry.hooks[0]!.args, { input, env: envWith(on), encoding: 'utf8', timeout: 60_000 }),
      'ps',
    );
  }, SPAWN_TEST_TIMEOUT);

  it.skipIf(!hasSh)('the inline sh body, run exactly as the settings.json entry runs it (POSIX sh)', () => {
    const posix = new RemoteControlProbe({ root: tmp, claudeSettingsFile: path.join(tmp, 's.json'), platform: 'linux' });
    const entry = posix.userHookEntry();
    expect(entry.hooks[0]).toEqual({ type: 'command', command: 'sh', args: ['-c', shHookBody(path.join(tmp, 'remote-control'))], timeout: 15 });
    const body = entry.hooks[0]!.args[1]!;
    expect(body.startsWith(`# ${RC_HOOK_SIGNATURE}\n`)).toBe(true);
    behavesLikeTheHook(
      (input, on) => spawnSync(entry.hooks[0]!.command, entry.hooks[0]!.args, { input, env: envWith(on), encoding: 'utf8', timeout: 60_000 }),
      'sh',
    );
  }, SPAWN_TEST_TIMEOUT);

  it('bodies bake the marker dir with its quotes escaped for each interpreter', () => {
    expect(powerShellHookBody("C:\\it's\\here")).toContain("$dir = 'C:\\it''s\\here'");
    expect(shHookBody("/home/it's")).toContain("dir='/home/it'\\''s'");
  });
});

describe('the user-level hook installer', () => {
  const settingsOf = (p: RemoteControlProbe) => JSON.parse(fs.readFileSync(p.claudeSettingsFile, 'utf8')) as Record<string, unknown>;
  const preOf = (p: RemoteControlProbe) => ((settingsOf(p).hooks as Record<string, unknown>).PreToolUse as unknown[]);

  it('matcher covers exactly the hooked tools under any server name; hooks.json agrees with it', () => {
    const re = new RegExp(RC_HOOK_MATCHER);
    for (const t of RC_HOOKED_TOOLS) {
      expect(re.test(`mcp__plugin_contrail_contrail-engine__${t}`)).toBe(true);
      expect(re.test(`mcp__Contrail__${t}`)).toBe(true);
      expect(re.test(`mcp__contrail-engine__${t}`)).toBe(true);
    }
    expect(re.test('mcp__Contrail__soql_query')).toBe(false);
    expect(re.test('mcp__Contrail__execute_deploy')).toBe(false);
    expect(re.test('Bash')).toBe(false);
    const bundled = JSON.parse(fs.readFileSync(path.resolve(path.dirname(HOOK_MJS), 'hooks.json'), 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; args: string[]; timeout: number }> }> };
    };
    expect(bundled.hooks.PreToolUse[0]!.matcher).toBe(RC_HOOK_MATCHER);
    expect(bundled.hooks.PreToolUse[0]!.hooks[0]).toEqual({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/hooks/remote-control.mjs'],
      timeout: 15,
    });
  });

  it('recognises its own entries by signature or script path — never by the spelling of the data dir', () => {
    expect(isOurEntry(probe.userHookEntry())).toBe(true);
    expect(isOurEntry(new RemoteControlProbe({ root: 'D:\\sfe-data', claudeSettingsFile: 'x', platform: 'linux' }).userHookEntry())).toBe(true);
    // The plugin's own hooks.json entry, and the earlier generated-script shape, both read as ours.
    expect(isOurEntry({ matcher: 'x', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/remote-control.mjs'] }] })).toBe(true);
    expect(isOurEntry({ matcher: 'x', hooks: [{ type: 'command', command: 'sh', args: ['/data/hooks/remote-control.sh'] }] })).toBe(true);
    expect(isOurEntry({ matcher: 'x', hooks: [{ type: 'command', command: 'powershell.exe', args: ['-File', 'D:\\x\\hooks\\remote-control.ps1'] }] })).toBe(true);
    // Not ours: a user's hook that merely mentions Contrail, or a different script.
    expect(isOurEntry({ matcher: 'mcp__Contrail__.*', hooks: [{ type: 'command', command: 'echo contrail' }] })).toBe(false);
    expect(isOurEntry({ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh', args: ['/hooks/other.sh'] }] })).toBe(false);
    expect(isOurEntry(null)).toBe(false);
    expect(isOurEntry({ hooks: 'nope' })).toBe(false);
  });

  it('installs into a fresh file (no backup — there was nothing before), is idempotent even when keys are reordered, replaces an older variant, and removes cleanly', () => {
    const file = probe.claudeSettingsFile;
    expect(probe.hookState()).toBe('not_installed');
    expect(probe.installUserHook()).toEqual({ changed: true, file, backup: null }); // nothing predated it, so no backup is claimed
    expect(probe.hookState()).toBe('installed');
    expect(fs.existsSync(`${file}.contrail-backup`)).toBe(false);
    expect(probe.installUserHook().changed).toBe(false);

    // Claude Code rewrites settings.json itself and may reorder keys: still "already installed".
    const entry = preOf(probe)[0] as { matcher: string; hooks: Array<Record<string, unknown>> };
    const reordered = { hooks: [{ timeout: entry.hooks[0]!.timeout, args: entry.hooks[0]!.args, command: entry.hooks[0]!.command, type: 'command' }], matcher: entry.matcher };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [reordered] } }));
    expect(probe.installUserHook().changed).toBe(false);
    expect(preOf(probe)).toHaveLength(1);

    // An entry from an older release (different body) is OURS and gets replaced, not duplicated.
    const stale = { matcher: RC_HOOK_MATCHER, hooks: [{ type: 'command', command: 'sh', args: ['-c', `# ${RC_HOOK_SIGNATURE}\nold body`], timeout: 15 }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [stale] } }));
    expect(probe.hookState()).toBe('installed');
    expect(probe.installUserHook().changed).toBe(true);
    expect(preOf(probe)).toHaveLength(1);
    expect(JSON.stringify(settingsOf(probe))).not.toContain('old body');
    expect(deepEqual(preOf(probe)[0], probe.userHookEntry())).toBe(true);

    expect(probe.removeUserHook()).toEqual({ changed: true, file });
    expect(probe.hookState()).toBe('not_installed');
    expect(probe.removeUserHook().changed).toBe(false);
    expect(settingsOf(probe)).toEqual({});
  });

  it('a pre-existing settings.json is backed up ONCE, as it was before Contrail, and its other content survives install + remove', () => {
    const file = probe.claudeSettingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [] } }, null, 2);
    fs.writeFileSync(file, original);
    expect(probe.installUserHook()).toEqual({ changed: true, file, backup: `${file}.contrail-backup` });
    expect(fs.readFileSync(`${file}.contrail-backup`, 'utf8')).toBe(original);
    expect(preOf(probe)).toHaveLength(2);
    probe.installUserHook(); // no-op
    probe.removeUserHook();
    expect(fs.readFileSync(`${file}.contrail-backup`, 'utf8')).toBe(original); // never overwritten
    const after = settingsOf(probe);
    expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect((after.hooks as Record<string, unknown>).PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]);
    expect((after.hooks as Record<string, unknown>).Stop).toEqual([]);
  });

  it('refuses an unparseable or mis-shaped settings.json (nothing written) and reports it as unreadable', () => {
    const file = probe.claudeSettingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "hooks": [ }');
    expect(probe.hookState()).toBe('unreadable');
    expect(userHookState(file)).toBe('unreadable');
    expect(() => probe.installUserHook()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "hooks": [ }');
    fs.writeFileSync(file, '[1,2,3]');
    expect(() => probe.installUserHook()).toThrow(/JSON object/);
    fs.writeFileSync(file, JSON.stringify({ hooks: [] }));
    expect(() => probe.installUserHook()).toThrow(/"hooks" is not an object/);
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: {} } }));
    expect(() => probe.installUserHook()).toThrow(/not an array/);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ hooks: { PreToolUse: {} } }));
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink and keeps a 0600 mode (dotfiles setups, settings with env secrets)', () => {
    const real = path.join(tmp, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{}', { mode: 0o600 });
    const link = probe.claudeSettingsFile;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    probe.installUserHook();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); // the link survived
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.PreToolUse).toHaveLength(1);
    expect(fs.existsSync(`${real}.contrail-backup`)).toBe(true);
  });

  it('claudeSettingsPath honours CLAUDE_CONFIG_DIR and otherwise lands in ~/.claude', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = tmp;
      expect(claudeSettingsPath()).toBe(path.join(tmp, 'settings.json'));
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(claudeSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

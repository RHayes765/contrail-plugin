import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContrailDb } from '../core/db.js';
import { AuditLog } from '../core/audit.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, loadConfig, saveConfigSection, type ContrailConfig } from '../core/config.js';
import { NOTIFY_ACCOUNTS, type ApprovalNotifier, type NotifyOutcome } from '../core/notify.js';
import { RC_HOOK_MATCHER, RC_HOOK_SIGNATURE, RemoteControlProbe } from '../core/remoteControl.js';
import { SettingsPageServer } from '../connect/settings.js';
import { SnapshotStore } from '../snapshot/store.js';
import { createDeps, createServer } from '../server.js';

/**
 * S42: the human-only Settings page and the open_settings tool. What these
 * pin: the page is session-tokened and loopback-only like the grants page;
 * stored keys are never rendered back; a save writes the keychain + the
 * on-disk config section + the LIVE config object; the agent's tool result
 * never carries the URL (it bears the session token and the page takes
 * secrets); the config writer preserves unknown sections and never freezes
 * environment overrides into the file.
 */

const USER = 'U'.repeat(30);
const TOKEN = 'T'.repeat(30);

class FakeNotifier implements ApprovalNotifier {
  tests = 0;
  resets = 0;
  testResult = { ok: true, message: 'Test notification sent to iphone. Check your phone.' };
  constructor(
    private readonly config: ContrailConfig,
    private readonly tokens: MemoryTokenStore,
  ) {}
  async notify(): Promise<NotifyOutcome> {
    return { status: 'off' };
  }
  async sendTest() {
    this.tests += 1;
    return this.testResult;
  }
  status() {
    return {
      method: this.config.notifications.method,
      when: this.config.notifications.when,
      configured:
        this.tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser) !== null &&
        this.tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken) !== null,
    };
  }
  resetCircuit() {
    this.resets += 1;
  }
}

let tmp: string;
let db: ContrailDb;
let tokens: MemoryTokenStore;
let config: ContrailConfig;
let notifier: FakeNotifier;
let opened: string[];
let page: SettingsPageServer;
let toolPages: SettingsPageServer[];
let probe: RemoteControlProbe;
/** Claude Code's settings.json — ALWAYS a temp file here; the installer must never touch the real one from a test. */
let claudeSettings: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-settings-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  config = { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications } };
  notifier = new FakeNotifier(config, tokens);
  opened = [];
  toolPages = [];
  claudeSettings = path.join(tmp, 'claude-home', 'settings.json');
  probe = new RemoteControlProbe({ root: tmp, claudeSettingsFile: claudeSettings, platform: 'win32' });
  page = new SettingsPageServer({
    config,
    tokens,
    audit: new AuditLog(db),
    notifier,
    remoteControl: probe,
    openBrowser: async (url) => {
      opened.push(url);
    },
  });
});

afterEach(() => {
  // Each open() binds a loopback listener with a 10-minute unref'd life —
  // drop them now rather than leaning on worker teardown.
  page.closeAll();
  for (const p of toolPages) p.closeAll();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

async function openPage(): Promise<{ url: URL; session: string }> {
  const { url, opened: ok } = await page.open();
  expect(ok).toBe(true);
  const parsed = new URL(url);
  return { url: parsed, session: parsed.searchParams.get('s')! };
}

describe('the Settings page', () => {
  it('serves the form only to the session URL, with the grants-page hardening headers', async () => {
    const { url } = await openPage();
    expect(url.pathname).toBe('/settings');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('Approval codes on your phone');
    expect(html).toContain('name="pushover_user"');
    expect(html).toContain('type="password"');
    // S43: the "when" choice and the Remote Control hook block, honest about its state.
    expect(html).toContain('name="when"');
    expect(html).toContain('value="remote_control" selected');
    expect(html).toContain('Remote Control hook');
    expect(html).toContain('not installed');
    expect(html).toContain('none yet');
    expect(html).toContain('value="install_hook"');

    const noSession = await fetch(`${url.origin}/settings`);
    expect(noSession.status).toBe(404);
    const wrongSession = await fetch(`${url.origin}/settings?s=nope`);
    expect(wrongSession.status).toBe(404);
  });

  it('never renders a stored key — only a masked tail', async () => {
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, TOKEN);
    const { url } = await openPage();
    const html = await (await fetch(url)).text();
    expect(html).not.toContain(USER);
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('…UUUU');
    expect(html).toContain('…TTTT');
    expect(html).toContain('leave blank to keep the stored key');
  });

  it('a POST with the wrong session token is refused and audited; nothing is stored', async () => {
    const { url } = await openPage();
    const res = await fetch(`${url.origin}/settings`, form({ session: 'forged', method: 'pushover', pushover_user: USER }));
    expect(res.status).toBe(403);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    const refusals = db.queryAuditEvents({}).filter((e) => e.eventType === 'local_request.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.detail).toMatchObject({ reason: 'invalid_session_token', path: '/settings' });
  });

  it('save: keys → keychain, method/summary → config.json AND the live config; audit carries no values', async () => {
    const { url, session } = await openPage();
    const res = await fetch(
      `${url.origin}/settings`,
      form({ session, action: 'save', method: 'pushover', summary: 'full', when: 'always', pushover_user: USER, pushover_token: TOKEN }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Saved. Use &quot;Send test notification&quot; to confirm delivery.');
    expect(html).toContain('Every approval is pushed');
    expect(html).not.toContain(USER);

    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBe(TOKEN);
    // The running engine's config object changed in place — no restart needed.
    expect(config.notifications).toEqual({ method: 'pushover', summary: 'full', when: 'always' });
    // And the on-disk file now carries the section for the next start.
    expect(loadConfig().notifications).toEqual({ method: 'pushover', summary: 'full', when: 'always' });
    expect(notifier.resets).toBe(1);

    const changed = db.queryAuditEvents({}).filter((e) => e.eventType === 'settings.notifications_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.detail).toEqual({ method: 'pushover', summary: 'full', when: 'always', user_key_set: true, token_set: true });
    expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(USER);

    // Back to the default gate: the banner says what that means while no hook reports.
    const gated = await fetch(`${url.origin}/settings`, form({ session, action: 'save', method: 'pushover', summary: 'full', when: 'remote_control' }));
    expect(await gated.text()).toContain('install the hook below');
    expect(config.notifications.when).toBe('remote_control');

    // The page is still alive after a save, so "Send test" can follow.
    expect((await fetch(url)).status).toBe(200);
  });

  it('"Send test" on a fresh page saves the typed keys FIRST, then tests — the documented first-run flow', async () => {
    const { url, session } = await openPage();
    const res = await fetch(
      `${url.origin}/settings`,
      form({ session, action: 'test', method: 'pushover', summary: 'minimal', pushover_user: USER, pushover_token: TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Test notification sent to iphone');
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBe(TOKEN);
    expect(config.notifications.method).toBe('pushover');
    expect(notifier.tests).toBe(1);

    // A malformed typed key stops at the save error — no test is attempted.
    const bad = await fetch(`${url.origin}/settings`, form({ session, action: 'test', method: 'pushover', pushover_user: 'short' }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('exactly 30 letters and digits');
    expect(notifier.tests).toBe(1);
  });

  it('an unknown action is refused and writes nothing', async () => {
    const { url, session } = await openPage();
    const res = await fetch(`${url.origin}/settings`, form({ session, action: 'frobnicate', method: 'pushover', pushover_user: USER }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Unknown action');
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    expect(config.notifications.method).toBe('none');
  });

  it('save refuses a malformed key and stores nothing', async () => {
    const { url, session } = await openPage();
    const res = await fetch(`${url.origin}/settings`, form({ session, action: 'save', method: 'pushover', pushover_user: 'short' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('exactly 30 letters and digits');
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    expect(config.notifications.method).toBe('none');
  });

  it('save with blank key fields keeps the stored keys', async () => {
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, TOKEN);
    const { url, session } = await openPage();
    const res = await fetch(`${url.origin}/settings`, form({ session, action: 'save', method: 'pushover', summary: 'minimal', pushover_user: '', pushover_token: '' }));
    expect(res.status).toBe(200);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(config.notifications.method).toBe('pushover');
  });

  it('test: delegates to the notifier and shows its verdict; clear: removes keys and switches off', async () => {
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, TOKEN);
    config.notifications.method = 'pushover';
    const { url, session } = await openPage();

    const tested = await fetch(`${url.origin}/settings`, form({ session, action: 'test' }));
    expect(tested.status).toBe(200);
    expect(await tested.text()).toContain('Test notification sent to iphone');
    expect(notifier.tests).toBe(1);

    notifier.testResult = { ok: false, message: 'Pushover rejected the keys: user identifier is invalid. Nothing was sent.' };
    const failed = await fetch(`${url.origin}/settings`, form({ session, action: 'test' }));
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('user identifier is invalid');

    const cleared = await fetch(`${url.origin}/settings`, form({ session, action: 'clear' }));
    expect(cleared.status).toBe(200);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBeNull();
    expect(config.notifications.method).toBe('none');
    expect(loadConfig().notifications.method).toBe('none');
  });
});

describe('S43: the Remote Control hook block', () => {
  function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(claudeSettings, 'utf8')) as Record<string, unknown>;
  }

  it('install writes ONE PreToolUse entry into Claude Code\'s user settings (created if absent), idempotently; remove takes it back out', async () => {
    const { url, session } = await openPage();
    expect(fs.existsSync(claudeSettings)).toBe(false);

    const installed = await fetch(`${url.origin}/settings`, form({ session, action: 'install_hook' }));
    expect(installed.status).toBe(200);
    const html = await installed.text();
    expect(html).toContain('Hook installed in');
    expect(html).toContain('the file did not exist and was created'); // no backup is promised for a file Contrail made
    expect(html).toContain('pick it up within moments');
    expect(html).toContain('installed in Claude Code&#39;s user settings'); // the status line re-rendered (HTML-escaped)

    const settings = readSettings();
    const pre = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(pre).toHaveLength(1);
    const entry = pre[0] as { matcher: string; hooks: Array<{ type: string; command: string; args: string[]; timeout: number }> };
    expect(entry.matcher).toBe(RC_HOOK_MATCHER);
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0]!.command).toBe('powershell.exe');
    expect(entry.hooks[0]!.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    // The hook body rides INLINE — nothing executable is written anywhere on disk.
    expect(entry.hooks[0]!.args[5]).toContain(RC_HOOK_SIGNATURE);
    expect(entry.hooks[0]!.args[5]).toContain(path.join(tmp, 'remote-control'));
    expect(fs.existsSync(path.join(tmp, 'hooks'))).toBe(false);

    const again = await fetch(`${url.origin}/settings`, form({ session, action: 'install_hook' }));
    expect(await again.text()).toContain('already installed');
    expect((readSettings().hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);

    const removed = await fetch(`${url.origin}/settings`, form({ session, action: 'remove_hook' }));
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain('Hook removed from');
    expect(readSettings()).toEqual({}); // nothing of ours left behind, no empty hooks object either
    expect(fs.existsSync(`${claudeSettings}.contrail-backup`)).toBe(false); // Contrail created the file: nothing predated it

    const events = db.queryAuditEvents({}).filter((e) => e.eventType === 'settings.remote_control_hook');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.detail)).toEqual(
      expect.arrayContaining([
        { action: 'install', changed: true },
        { action: 'install', changed: false },
        { action: 'remove', changed: true },
      ]),
    );
  });

  it('install preserves everything else in settings.json — other hooks, other keys — and remove leaves them intact', async () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
    fs.writeFileSync(
      claudeSettings,
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [theirs], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, 2),
    );
    const original = fs.readFileSync(claudeSettings, 'utf8');
    const { url, session } = await openPage();
    const installed = await fetch(`${url.origin}/settings`, form({ session, action: 'install_hook' }));
    expect(await installed.text()).toContain('is kept at'); // the banner names the backup only when one exists
    expect(fs.readFileSync(`${claudeSettings}.contrail-backup`, 'utf8')).toBe(original); // the pre-Contrail file
    let s = readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    const pre = (s.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0]).toEqual(theirs);
    expect((s.hooks as { Stop: unknown[] }).Stop).toHaveLength(1);

    await fetch(`${url.origin}/settings`, form({ session, action: 'remove_hook' }));
    s = readSettings();
    expect((s.hooks as { PreToolUse: unknown[] }).PreToolUse).toEqual([theirs]);
    expect((s.hooks as { Stop: unknown[] }).Stop).toHaveLength(1);
    expect(s.permissions).toEqual({ allow: ['Bash(ls:*)'] });
  });

  it('Install / Remove save anything typed or changed above FIRST — nothing is silently dropped, and a bad key stops before the hook is touched', async () => {
    const { url, session } = await openPage();
    const res = await fetch(
      `${url.origin}/settings`,
      form({ session, action: 'install_hook', method: 'pushover', summary: 'full', when: 'remote_control', pushover_user: USER, pushover_token: TOKEN }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Saved.');
    expect(html).toContain('Hook installed in');
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(config.notifications).toEqual({ method: 'pushover', summary: 'full', when: 'remote_control' });
    expect(probe.hookState()).toBe('installed');

    const bad = await fetch(`${url.origin}/settings`, form({ session, action: 'remove_hook', method: 'pushover', summary: 'full', when: 'remote_control', pushover_user: 'short' }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('exactly 30 letters and digits');
    expect(probe.hookState()).toBe('installed'); // the hook action never ran

    // Nothing typed, nothing changed → no save, just the hook action.
    const plain = await fetch(`${url.origin}/settings`, form({ session, action: 'remove_hook', method: 'pushover', summary: 'full', when: 'remote_control' }));
    expect(await plain.text()).not.toContain('Saved.');
    expect(probe.hookState()).toBe('not_installed');
  });

  it('a settings.json that is not valid JSON is never touched — the page says so and the audit row records the failure', async () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    const broken = '{ "hooks": { "PreToolUse": [ ] , }';
    fs.writeFileSync(claudeSettings, broken);
    const { url, session } = await openPage();
    const html = await (await fetch(url)).text();
    expect(html).toContain('not valid JSON'); // status line
    const res = await fetch(`${url.origin}/settings`, form({ session, action: 'install_hook' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Could not install the hook');
    expect(fs.readFileSync(claudeSettings, 'utf8')).toBe(broken);
    const events = db.queryAuditEvents({}).filter((e) => e.eventType === 'settings.remote_control_hook');
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('error');
  });

  it('the page shows the last hook report, and the tool-facing status carries state + hook but never a path', async () => {
    fs.mkdirSync(path.join(tmp, 'remote-control'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'remote-control', 'latest.json'),
      JSON.stringify({ v: 1, remote_control: true, at: new Date().toISOString(), tool_name: 'mcp__Contrail__list_connections', tool_use_id: 'toolu_1' }),
    );
    const { url } = await openPage();
    const html = await (await fetch(url)).text();
    expect(html).toContain('Remote Control ON at');
    const status = page.status();
    expect(status.when).toBe('remote_control');
    expect(status.remote_control).toMatchObject({ state: 'on', user_hook: 'not_installed' });
    expect(JSON.stringify(status)).not.toContain('settings.json');
    expect(JSON.stringify(status)).not.toContain(tmp);
  });
});

describe('saveConfigSection', () => {
  it('patches one section on disk, preserves unknown sections, never freezes env overrides', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ salesforce: { apiVersion: 'v60.0' }, extra: { keep: true } }, null, 2));
    process.env.CONTRAIL_SF_API_VERSION = 'v99.0';
    try {
      expect(loadConfig().salesforce.apiVersion).toBe('v99.0'); // the override applies at runtime…
      saveConfigSection('notifications', { method: 'pushover' });
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(onDisk.notifications).toEqual({ method: 'pushover' }); // only the patch, no defaults sprayed in
      expect(onDisk.extra).toEqual({ keep: true });
      expect(onDisk.salesforce).toEqual({ apiVersion: 'v60.0' }); // …but is never written back
      expect(loadConfig().notifications).toEqual({ method: 'pushover', summary: 'minimal', when: 'remote_control' });
    } finally {
      delete process.env.CONTRAIL_SF_API_VERSION;
    }
  });

  it('refuses to overwrite a config.json that is not valid JSON — a hand-edit typo stays repairable', () => {
    const file = path.join(tmp, 'config.json');
    const broken = '{ "deploy": { "allowedSourceRoots": ["C:\\\\work"], }';
    fs.writeFileSync(file, broken);
    expect(() => saveConfigSection('notifications', { method: 'pushover' })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });
});

describe('open_settings (the tool)', () => {
  async function toolClient(openBrowser: (url: string) => Promise<void>) {
    const deps = createDeps({
      db,
      tokens,
      config,
      store: new SnapshotStore(path.join(tmp, 'snapshots')),
      notifier,
      remoteControl: probe,
      flowOps: {
        exchangeCode: async () => {
          throw new Error('not exercised');
        },
        fetchOrgInfo: async () => {
          throw new Error('not exercised');
        },
        fetchIdentity: async () => ({ username: null, userId: null, displayName: null }),
        revokeToken: async () => ({ ok: true }),
        openBrowser,
      },
    });
    toolPages.push(deps.settingsPage);
    const server = createServer(deps);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'settings-test', version: '0.0.0' });
    await client.connect(c);
    return client;
  }

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
  }

  it('opens the page in the browser and tells the agent status only — never the URL', async () => {
    const client = await toolClient(async (url) => {
      opened.push(url);
    });
    const result = await client.callTool({ name: 'open_settings', arguments: {} });
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(opened.some((u) => u.includes('/settings?s='))).toBe(true);
    expect(text).toContain('"page_opened_in_browser": true');
    expect(text).toContain('"method": "none"');
    expect(text).toContain('"configured": false');
    // S43: when + the hook's last report ride along; the settings file path never does.
    expect(text).toContain('"when": "remote_control"');
    expect(text).toContain('"remote_control"');
    expect(text).toContain('"user_hook": "not_installed"');
    expect(text).not.toContain('settings.json');
    expect(text).not.toContain('?s=');
    expect(text).not.toMatch(/http:\/\/localhost:\d+/);
    await client.close();
  });

  it('when the browser cannot open, the URL still never reaches the agent', async () => {
    const client = await toolClient(async () => {
      throw new Error('no display');
    });
    const text = textOf(await client.callTool({ name: 'open_settings', arguments: {} }));
    expect(text).toContain('"page_opened_in_browser": false');
    expect(text).toContain('deliberately NOT');
    expect(text).not.toContain('?s=');
    expect(text).not.toMatch(/http:\/\/localhost:\d+/);
    await client.close();
  });

  it('list_connections reports approval_notifications status, never a key', async () => {
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, TOKEN);
    config.notifications.method = 'pushover';
    const client = await toolClient(async () => {});
    const text = textOf(await client.callTool({ name: 'list_connections', arguments: {} }));
    expect(text).toContain('"approval_notifications"');
    expect(text).toContain('"method": "pushover"');
    expect(text).toContain('"configured": true');
    expect(text).toContain('"when": "remote_control"');
    expect(text).toContain('"remote_control"');
    expect(text).toContain('"state": "unknown"'); // no hook has reported in this test
    expect(text).not.toContain(USER);
    expect(text).not.toContain(TOKEN);
    await client.close();
  });
});

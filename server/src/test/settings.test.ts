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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-settings-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  tokens = new MemoryTokenStore();
  config = { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications } };
  notifier = new FakeNotifier(config, tokens);
  opened = [];
  toolPages = [];
  page = new SettingsPageServer({
    config,
    tokens,
    audit: new AuditLog(db),
    notifier,
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
      form({ session, action: 'save', method: 'pushover', summary: 'full', pushover_user: USER, pushover_token: TOKEN }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Saved. Approval codes will be pushed to your phone');
    expect(html).not.toContain(USER);

    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(tokens.getSecret(NOTIFY_ACCOUNTS.pushoverToken)).toBe(TOKEN);
    // The running engine's config object changed in place — no restart needed.
    expect(config.notifications).toEqual({ method: 'pushover', summary: 'full' });
    // And the on-disk file now carries the section for the next start.
    expect(loadConfig().notifications).toEqual({ method: 'pushover', summary: 'full' });
    expect(notifier.resets).toBe(1);

    const changed = db.queryAuditEvents({}).filter((e) => e.eventType === 'settings.notifications_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.detail).toEqual({ method: 'pushover', summary: 'full', user_key_set: true, token_set: true });
    expect(JSON.stringify(db.queryAuditEvents({}))).not.toContain(USER);

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
      expect(loadConfig().notifications).toEqual({ method: 'pushover', summary: 'minimal' });
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
    expect(text).not.toContain(USER);
    expect(text).not.toContain(TOKEN);
    await client.close();
  });
});

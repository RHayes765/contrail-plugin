import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { MemoryTokenStore } from '../core/keychain.js';
import {
  FREEZE_TAIL,
  NOTIFY_ACCOUNTS,
  NullNotifier,
  PUSHOVER_KEY_RE,
  PushoverNotifier,
  composePushover,
  describePhoneOutcome,
  type NotifyOutcome,
} from '../core/notify.js';
import type { ApprovalPageOptions } from '../connect/pages.js';

/**
 * S42: the approval notifier. MIRROR test (byte-identical in both repos).
 * What these pin: the message carries review substance + the code and never
 * loses the code to truncation; 'minimal' leaks no metadata names; the
 * Pushover client reports CATEGORIES only, never a key or a body; a rejected
 * key opens the circuit so a bad token can never earn an IP block; off and
 * unconfigured states never touch the network.
 */

const USER = 'u'.repeat(30);
const TOKEN = 't'.repeat(30);
const CODE = 'QRST-2345';

function view(overrides: Partial<ApprovalPageOptions> = {}): ApprovalPageOptions {
  return {
    kind: 'deploy',
    code: CODE,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    org: { alias: 'acme-uat', orgName: 'Acme', orgType: 'sandbox', instanceUrl: 'https://x' },
    changes: [
      { label: 'ADD  CustomField:Invoice__c.Secret_Field__c', warnings: ['no permission set grants it'] },
      { label: 'MODIFY  ApexClass:InvoiceService', warnings: [] },
    ],
    destructive: [{ label: 'DELETE  Flow:Old_Router', warnings: ['deleting this breaks dependents: X'] }],
    results: [],
    blast: [],
    warnings: ['top-level advisory'],
    ...overrides,
  };
}

function configWith(method: 'none' | 'pushover', summary: 'minimal' | 'full' = 'minimal'): ContrailConfig {
  return { ...DEFAULT_CONFIG, notifications: { method, summary, when: 'remote_control' } };
}

/** S43: the code is the LAST line, alone, after a blank line — and appears exactly once. */
function expectCodeIsLastLine(message: string): void {
  const lines = message.split('\n');
  expect(lines.at(-1)).toBe(CODE);
  expect(lines.at(-2)).toBe('');
  expect(message.split(CODE)).toHaveLength(2);
}

function storeWithKeys(): MemoryTokenStore {
  const s = new MemoryTokenStore();
  s.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
  s.setSecret(NOTIFY_ACCOUNTS.pushoverToken, TOKEN);
  return s;
}

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(
  responder: (call: Call) => { status: number; json?: unknown; headers?: Record<string, string> } | Error,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? { status: r.status < 400 ? 1 : 0 }), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('composePushover', () => {
  it('minimal: counts + code, no metadata names leave the machine', () => {
    const m = composePushover(view(), { includeCode: true, summary: 'minimal' });
    expect(m.title).toBe('Contrail: approve deploy → acme-uat (sandbox)');
    expect(m.message).toContain('2 changes · 1 deletion · 3 warnings');
    expect(m.message).toContain('Includes DELETIONS.');
    expect(m.message).toContain('it expires at');
    expectCodeIsLastLine(m.message);
    expect(m.message).not.toContain('Secret_Field__c');
    expect(m.message).not.toContain('Old_Router');
    expect(m.message).not.toContain('advisory');
    expect(m.ttl).toBeGreaterThan(29 * 60);
    expect(m.ttl).toBeLessThanOrEqual(30 * 60);
  });

  it('full: labels (destructive first, squashed) and up to three warnings', () => {
    const m = composePushover(view(), { includeCode: true, summary: 'full' });
    const lines = m.message.split('\n');
    expect(lines).toContain('• DELETE Flow:Old_Router');
    expect(lines).toContain('• ADD CustomField:Invoice__c.Secret_Field__c');
    expect(lines.indexOf('• DELETE Flow:Old_Router')).toBeLessThan(lines.indexOf('• MODIFY ApexClass:InvoiceService'));
    expect(m.message).toContain('⚠ top-level advisory');
    expectCodeIsLastLine(m.message);
  });

  it('full with many long labels: the 1024 cap holds and the code lines survive intact', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      label: `MODIFY  CustomObject:${'VeryLongObjectName'.repeat(8)}_${i}__c`,
      warnings: [],
    }));
    const m = composePushover(view({ changes: many, destructive: [] }), { includeCode: true, summary: 'full' });
    expect(m.message.length).toBeLessThanOrEqual(1024);
    expect(m.message).toContain('approval page on your desktop.');
    expectCodeIsLastLine(m.message); // the tail — instruction, blank line, code — is intact
    expect(m.message).toContain('…'); // the HEAD was clipped, never the tail
  });

  it('full caps the label list at ten and says how many it left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `MODIFY  ApexClass:C${i}`, warnings: [] }));
    const m = composePushover(view({ changes: many, destructive: [], warnings: [] }), { includeCode: true, summary: 'full' });
    expect(m.message.split('\n').filter((l) => l.startsWith('• MODIFY'))).toHaveLength(10);
    expect(m.message).toContain('• … 30 more');
    expectCodeIsLastLine(m.message);
  });

  it('S43: the message reads head → instruction with the expiry → blank line → bare code', () => {
    const m = composePushover(view(), { includeCode: true, summary: 'minimal' });
    const lines = m.message.split('\n');
    expect(lines[0]).toBe('2 changes · 1 deletion · 3 warnings');
    expect(lines[1]).toBe('Includes DELETIONS.');
    expect(lines[2]).toMatch(/^Type the code below into your Contrail session to approve — it expires at /);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe(CODE);
    expect(lines).toHaveLength(5);
    expect(m.message).not.toContain('Code:'); // no label glued to the code — a thumb selects the bare line
  });

  it('full strips record field values from DATA-change labels — PII never rides a push', () => {
    const dml = view({
      kind: 'dml',
      destructive: [{ label: 'DELETE Contact 003000000000001AAA: Email = "a@b.c"', warnings: [] }],
      changes: [{ label: 'INSERT Contact: LastName = "Hayes", Email = "ryley@example.com", Phone = "555"', warnings: [] }],
      warnings: [],
    });
    const m = composePushover(dml, { includeCode: true, summary: 'full' });
    expect(m.message).toContain('• INSERT Contact');
    expect(m.message).toContain('• DELETE Contact 003000000000001AAA');
    expect(m.message).not.toContain('Hayes');
    expect(m.message).not.toContain('example.com');
    expect(m.message).not.toContain('a@b.c');
    // Metadata labels keep their full type:name — those are the review substance.
    const meta = composePushover(view(), { includeCode: true, summary: 'full' });
    expect(meta.message).toContain('• ADD CustomField:Invoice__c.Secret_Field__c');
  });

  it('production org is called out; a native (desktop) presentation omits the code', () => {
    const prod = composePushover(view({ org: { alias: 'acme-prod', orgName: null, orgType: 'production', instanceUrl: 'https://x' } }), {
      includeCode: true,
      summary: 'minimal',
    });
    expect(prod.message).toContain('PRODUCTION org.');
    const native = composePushover(view(), { includeCode: false, summary: 'minimal' });
    expect(native.message).not.toContain(CODE);
    expect(native.message).toContain('Deploy Review');
  });

  it('title is capped at 250 and never throws on an unparseable expiry', () => {
    const m = composePushover(view({ org: { alias: 'a'.repeat(300), orgName: null, orgType: 'sandbox', instanceUrl: '' }, expiresAt: 'garbage' }), {
      includeCode: true,
      summary: 'minimal',
    });
    expect(m.title.length).toBeLessThanOrEqual(250);
    expect(m.message).toContain('expires soon');
    expect(m.ttl).toBe(3600);
  });
});

// S46 (B): the freeze tail and the policies-change line.
const SIXTY = Array.from({ length: 60 }, (_, i) => ({
  label: `MODIFY  CustomObject:${'VeryLongObjectName'.repeat(8)}_${i}__c`,
  warnings: [`row warning ${i}`],
}));
const CHANGED_AT = '2026-11-17T09:30:00.000Z';
const CHANGED_LINE =
  /^Contrail noticed a policies change in config\.json at \d{2}:\d{2} — read the approval page or Deploy Review before approving\.$/;

describe('composePushover during a change freeze, and after a policies change', () => {
  it('the freeze tail is verbatim, the last line, and carries no code', () => {
    expect(FREEZE_TAIL).toBe(
      'CHANGE FREEZE in effect — this message carries no code. While the freeze lasts, this can ' +
        'only be approved at your desk, after you type an emergency reason there (the approval ' +
        'page in your browser, or Deploy Review in the Contrail desktop app).',
    );
    const m = composePushover(view({ code: '' }), { includeCode: false, freeze: true, summary: 'minimal' });
    const lines = m.message.split('\n');
    expect(lines.at(-1)).toBe(FREEZE_TAIL);
    expect(lines[0]).toBe('2 changes · 1 deletion · 3 warnings');
    expect(m.message).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(m.message).not.toContain('Type the code below');
    expect(m.message).not.toContain('Waiting in Deploy Review');
    // Even a view that still carried the code is pushed without it.
    const leaked = composePushover(view(), { includeCode: false, freeze: true, summary: 'full' });
    expect(leaked.message).not.toContain(CODE);
  });

  it('the freeze tail survives truncation with summary full and 60 labels', () => {
    const m = composePushover(view({ code: '', changes: SIXTY, destructive: [] }), {
      includeCode: false,
      freeze: true,
      summary: 'full',
    });
    expect(m.message.length).toBeLessThanOrEqual(1024);
    expect(m.message.endsWith(`\n${FREEZE_TAIL}`)).toBe(true);
    expect(m.message).toContain('…');
  });

  it('the policies-change line sits directly after the counts line and takes none of the three warning slots', () => {
    const m = composePushover(view({ warnings: ['one', 'two', 'three', 'four'] }), {
      includeCode: true,
      summary: 'full',
      policyChangedAt: CHANGED_AT,
    });
    const lines = m.message.split('\n');
    expect(lines[0]).toBe('2 changes · 1 deletion · 6 warnings');
    expect(lines[1]).toMatch(CHANGED_LINE);
    expect(lines.filter((l) => l.startsWith('⚠ '))).toEqual(['⚠ one', '⚠ two', '⚠ three']);
    expectCodeIsLastLine(m.message);
    // Without the instant there is no such line.
    const plain = composePushover(view(), { includeCode: true, summary: 'full' });
    expect(plain.message).not.toContain('policies change');
  });

  it('the policies-change line survives the same truncation, beside the code or the freeze tail', () => {
    for (const freeze of [false, true]) {
      const m = composePushover(view({ code: freeze ? '' : CODE, changes: SIXTY, destructive: [] }), {
        includeCode: !freeze,
        freeze,
        summary: 'full',
        policyChangedAt: CHANGED_AT,
      });
      const lines = m.message.split('\n');
      expect(m.message.length).toBeLessThanOrEqual(1024);
      expect(lines[0]).toBe('60 changes · 0 deletions · 61 warnings');
      expect(lines[1]).toMatch(CHANGED_LINE);
      expect(m.message).toContain('…');
      if (freeze) expect(lines.at(-1)).toBe(FREEZE_TAIL);
      else expectCodeIsLastLine(m.message);
    }
  });

  it('PushoverNotifier sends what the engine asked for: the freeze tail and the policies line, no code', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    const out = await n.notify(view({ code: '' }), {
      includeCode: false,
      freeze: true,
      policyChangedAt: CHANGED_AT,
    });
    expect(out).toEqual({ status: 'sent' });
    const message = String(f.calls[0]!.body.message);
    expect(message.split('\n')[1]).toMatch(CHANGED_LINE);
    expect(message.endsWith(FREEZE_TAIL)).toBe(true);
    expect(message).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
  });
});

describe('describePhoneOutcome during a change freeze', () => {
  const OUTCOMES: NotifyOutcome[] = [
    { status: 'sent' },
    { status: 'skipped', reason: 'remote_control_off' },
    { status: 'skipped', reason: 'remote_control_unknown' },
    { status: 'failed', reason: 'rejected' },
    { status: 'failed', reason: 'not_configured' },
    { status: 'failed', reason: 'network' },
  ];
  const page = (o: NotifyOutcome) =>
    describePhoneOutcome(o, { includeCode: false, freeze: true, surface: 'page' });
  const native = (o: NotifyOutcome) =>
    describePhoneOutcome(o, { includeCode: false, freeze: true, surface: 'native' });

  it('sent: a code-free summary, approved at the desk after an emergency reason', () => {
    const text =
      "A code-free summary was pushed to the human's phone: a change freeze is in effect, and " +
      'while it lasts they can only approve at their desk, after typing an emergency reason there.';
    expect(page({ status: 'sent' })).toEqual({ status: 'sent', note: text });
    expect(native({ status: 'sent' })).toEqual({ status: 'sent', note: text });
  });

  it('skipped: both reasons, with where the human types the reason', () => {
    for (const [describeFor, where, settings] of [
      [page, 'on the approval page', 'via open_settings'],
      [native, 'in Deploy Review', "in the app's Settings → Notifications"],
    ] as const) {
      expect(describeFor({ status: 'skipped', reason: 'remote_control_off' })).toEqual({
        status: 'skipped',
        reason: 'remote_control_off',
        note:
          'Phone notification skipped: Remote Control was not connected when this was proposed ' +
          '(phone delivery is set to "only while Remote Control is on"). A change freeze is in ' +
          'effect, so a push would have carried no code; while it lasts the human approves at ' +
          `their desk, after typing an emergency reason ${where}.`,
      });
      expect(describeFor({ status: 'skipped', reason: 'remote_control_unknown' })).toEqual({
        status: 'skipped',
        reason: 'remote_control_unknown',
        note:
          'Phone notification skipped: phone delivery is set to "only while Remote Control is ' +
          'on", but Contrail\'s Remote Control hook did not report for this call — it is not ' +
          'installed, or this is not a Claude Code session. A change freeze is in effect: while ' +
          `it lasts the request cannot be approved until the human types an emergency reason ${where}. ` +
          `If the human expected a push, they can install the hook or switch delivery to Always ${settings}.`,
      });
    }
  });

  it('failed: the reason, then the freeze sentence', () => {
    expect(page({ status: 'failed', reason: 'rejected' })).toEqual({
      status: 'failed',
      reason: 'rejected',
      note:
        'Phone notification failed (Pushover rejected the stored keys — the human should ' +
        're-check them via open_settings). A change freeze is in effect, so the human approves ' +
        'at their desk either way.',
    });
    expect(native({ status: 'failed', reason: 'network' }).note).toBe(
      'Phone notification failed (Pushover was unreachable from this machine). A change freeze ' +
        'is in effect, so the human approves at their desk either way.',
    );
  });

  it('a frozen plugin outcome points at open_settings and never says the code is on the page; a native one never names open_settings', () => {
    for (const o of OUTCOMES) {
      const p = JSON.stringify(page(o));
      expect(p).not.toContain("the app's Settings");
      expect(p).not.toContain('as always');
      expect(p).not.toContain('approval page in the human');
      expect(p).not.toContain('nothing to do');
      expect(p).not.toContain(CODE);
      const n = JSON.stringify(native(o));
      expect(n).not.toContain('open_settings');
      expect(n).not.toContain(CODE);
    }
    expect(page({ status: 'failed', reason: 'not_configured' }).note).toContain('via open_settings');
    expect(describePhoneOutcome({ status: 'off' }, { includeCode: false, freeze: true, surface: 'page' })).toEqual({
      status: 'off',
    });
  });

  it('the settings phrase keys on the surface, which defaults from includeCode', () => {
    const rejected: NotifyOutcome = { status: 'failed', reason: 'rejected' };
    expect(describePhoneOutcome(rejected, { includeCode: false, surface: 'page' }).note).toContain('open_settings');
    expect(describePhoneOutcome(rejected, { includeCode: true, surface: 'native' }).note).toContain(
      'Settings → Notifications',
    );
    expect(describePhoneOutcome(rejected, { includeCode: true }).note).toContain('open_settings');
    expect(describePhoneOutcome(rejected, { includeCode: false }).note).not.toContain('open_settings');
  });
});

describe('PushoverNotifier', () => {
  it('method none → off, and the network is never touched', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const n = new PushoverNotifier(configWith('none'), storeWithKeys(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'off' });
    expect(f.calls).toHaveLength(0);
    expect(n.status()).toEqual({ method: 'none', when: 'remote_control', configured: true });
  });

  it('method pushover without keys → not_configured, no network', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const n = new PushoverNotifier(configWith('pushover'), new MemoryTokenStore(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'not_configured' });
    expect(f.calls).toHaveLength(0);
    expect(n.status()).toEqual({ method: 'pushover', when: 'remote_control', configured: false });
  });

  it('sends ONE JSON POST with token, user, title, message, ttl — and reports sent', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { status: 1, request: 'r1' } }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'sent' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.pushover.net/1/messages.json');
    const body = f.calls[0]!.body;
    expect(body.token).toBe(TOKEN);
    expect(body.user).toBe(USER);
    expect(body.priority).toBe(0);
    expect(String(body.message)).toContain(CODE);
    expect(typeof body.ttl).toBe('number');
    expect(String(body.title)).toContain('acme-uat');
  });

  it('a 4xx is final: rejected, then the circuit stays open until reset', async () => {
    let status = 400;
    const f = fakeFetch(() =>
      status === 200
        ? { status, json: { status: 1 } }
        : { status, json: { status: 0, errors: ['application token is invalid'] } },
    );
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'rejected' });
    // No second request while paused — a wrong key must not earn an IP block.
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'circuit_open' });
    expect(f.calls).toHaveLength(1);
    status = 200;
    n.resetCircuit();
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'sent' });
    expect(f.calls).toHaveLength(2);
  });

  it('429 → quota (paused); 5xx → network (not paused); timeout → timeout', async () => {
    const quota = fakeFetch(() => ({ status: 429, json: { status: 0, errors: ['limit'] } }));
    const nq = new PushoverNotifier(configWith('pushover'), storeWithKeys(), quota.fetch);
    expect(await nq.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'quota' });
    expect(await nq.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'circuit_open' });

    const five = fakeFetch(() => ({ status: 503 }));
    const n5 = new PushoverNotifier(configWith('pushover'), storeWithKeys(), five.fetch);
    expect(await n5.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'network' });
    expect(await n5.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'network' });
    expect(five.calls).toHaveLength(2);

    const timeoutErr = new Error('aborted');
    timeoutErr.name = 'TimeoutError';
    const slow = fakeFetch(() => timeoutErr);
    const nt = new PushoverNotifier(configWith('pushover'), storeWithKeys(), slow.fetch);
    expect(await nt.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('a 200 whose body says status:0 is a REFUSAL (rejected), not a network failure, and does not pause', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { status: 0, errors: ['message is too long'] } }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'rejected' });
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'rejected' });
    expect(f.calls).toHaveLength(2); // no circuit pause for a non-4xx
  });

  it('a 429 whose reset stamp is already in the past still pauses (the breaker cannot be disarmed by a stale header)', async () => {
    const past = String(Math.floor(Date.now() / 1000) - 60);
    const f = fakeFetch(() => ({ status: 429, json: { status: 0 }, headers: { 'x-limit-app-reset': past } }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'quota' });
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'circuit_open' });
    expect(f.calls).toHaveLength(1);
  });

  it('a locked or absent OS keychain is store_unavailable, never "not configured"', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const locked = new MemoryTokenStore();
    locked.getSecret = () => {
      throw new Error('OS keychain unavailable (locked)');
    };
    const n = new PushoverNotifier(configWith('pushover'), locked, f.fetch);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'failed', reason: 'store_unavailable' });
    expect(f.calls).toHaveLength(0);
    const status = n.status();
    expect(status.configured).toBe(false);
    expect(status.storeError).toContain('locked');
    expect((await n.sendTest()).message).toContain('could not be read');
  });

  it('syncs method/summary/when from the on-disk section before every send and status read', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { status: 1 } }));
    let disk: { method?: string; summary?: string; when?: string } | null = { method: 'pushover', summary: 'full' };
    const cfg = configWith('none'); // in-memory says off…
    const n = new PushoverNotifier(cfg, storeWithKeys(), f.fetch, () => disk as never);
    expect(await n.notify(view(), { includeCode: true })).toEqual({ status: 'sent' }); // …disk says on
    expect(cfg.notifications).toEqual({ method: 'pushover', summary: 'full', when: 'remote_control' }); // live object converged
    expect(String(f.calls[0]!.body.message)).toContain('• DELETE'); // and 'full' applied
    disk = { method: 'bogus', summary: 'everything', when: 'sometimes' }; // garbage on disk is ignored
    expect(n.status().method).toBe('pushover');
    expect(n.status().when).toBe('remote_control');
    disk = { when: 'always' }; // S43: the gate setting converges the same way
    expect(n.status().when).toBe('always');
    expect(cfg.notifications.when).toBe('always');
    disk = null;
    expect(n.status().method).toBe('pushover');
  });

  it('outcomes and agent-facing descriptions never carry the code or a key; key-shaped runs in Pushover errors are redacted', async () => {
    const f = fakeFetch(() => ({ status: 400, json: { status: 0, errors: [`user ${USER} is invalid`] } }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    const out = await n.notify(view(), { includeCode: true });
    const text = JSON.stringify([
      out,
      describePhoneOutcome(out, { includeCode: true }),
      describePhoneOutcome(out, { includeCode: false }),
      describePhoneOutcome({ status: 'sent' }, { includeCode: true }),
      describePhoneOutcome({ status: 'sent' }, { includeCode: false }),
      describePhoneOutcome({ status: 'skipped', reason: 'remote_control_off' }, { includeCode: true }),
      describePhoneOutcome({ status: 'skipped', reason: 'remote_control_unknown' }, { includeCode: true }),
    ]);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(USER);
    expect(text).not.toContain(TOKEN);
    n.resetCircuit();
    const test = await n.sendTest();
    expect(test.message).toContain('user [redacted] is invalid');
    expect(test.message).not.toContain(USER);
  });

  it('describePhoneOutcome speaks to the presentation the human actually got', () => {
    const page = describePhoneOutcome({ status: 'sent' }, { includeCode: true });
    expect(page.note).toContain('summary and code were also pushed');
    expect(page.note).toContain('counts only when the human gives it to you as their approval');
    const native = describePhoneOutcome({ status: 'sent' }, { includeCode: false });
    expect(native.note).toContain('code-free summary');
    expect(native.note).toContain('Deploy Review');
    expect(native.note).not.toContain('code were also');

    const pageFail = describePhoneOutcome({ status: 'failed', reason: 'rejected' }, { includeCode: true });
    expect(pageFail.note).toContain('open_settings');
    expect(pageFail.note).toContain('approval page');
    const nativeFail = describePhoneOutcome({ status: 'failed', reason: 'rejected' }, { includeCode: false });
    expect(nativeFail.note).toContain('Settings → Notifications');
    expect(nativeFail.note).not.toContain('open_settings');
    expect(nativeFail.note).toContain('Deploy Review');
    expect(describePhoneOutcome({ status: 'off' }, { includeCode: false })).toEqual({ status: 'off' });
  });

  it('S43: a skipped push is described as the quiet case it is — off needs no remark, unknown names the fix', () => {
    const off = describePhoneOutcome({ status: 'skipped', reason: 'remote_control_off' }, { includeCode: true });
    expect(off.status).toBe('skipped');
    expect(off.reason).toBe('remote_control_off');
    expect(off.note).toContain('nothing to do');
    expect(off.note).not.toContain('open_settings');

    const unknown = describePhoneOutcome({ status: 'skipped', reason: 'remote_control_unknown' }, { includeCode: true });
    expect(unknown.reason).toBe('remote_control_unknown');
    expect(unknown.note).toContain('hook did not report');
    expect(unknown.note).toContain('open_settings');
    expect(unknown.note).toContain('Always');
    const unknownNative = describePhoneOutcome({ status: 'skipped', reason: 'remote_control_unknown' }, { includeCode: false });
    expect(unknownNative.note).toContain('Settings → Notifications');
    expect(unknownNative.note).not.toContain('open_settings');
  });

  it('sendTest validates the keys first, then sends a test message naming the devices', async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith('/users/validate.json')
        ? { status: 200, json: { status: 1, devices: ['iphone'], licenses: ['iOS'] } }
        : { status: 200, json: { status: 1 } },
    );
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    const r = await n.sendTest();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('iphone');
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.pushover.net/1/users/validate.json',
      'https://api.pushover.net/1/messages.json',
    ]);
    expect(f.calls[0]!.body).toEqual({ token: TOKEN, user: USER });
  });

  it('sendTest surfaces Pushover\'s own error text and sends nothing when validation fails', async () => {
    const f = fakeFetch(() => ({ status: 400, json: { status: 0, user: 'invalid', errors: ['user identifier is invalid'] } }));
    const n = new PushoverNotifier(configWith('pushover'), storeWithKeys(), f.fetch);
    const r = await n.sendTest();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('user identifier is invalid');
    expect(r.message).toContain('Nothing was sent');
    expect(f.calls).toHaveLength(1);
    expect(r.message).not.toContain(USER);
  });

  it('sendTest without keys explains what to enter', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const n = new PushoverNotifier(configWith('pushover'), new MemoryTokenStore(), f.fetch);
    expect((await n.sendTest()).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe('NullNotifier, key grammar, keychain accounts', () => {
  it('NullNotifier is simply off', async () => {
    const n = new NullNotifier();
    expect(await n.notify()).toEqual({ status: 'off' });
    expect(n.status()).toEqual({ method: 'none', when: 'remote_control', configured: false });
    expect((await n.sendTest()).ok).toBe(false);
  });

  it('PUSHOVER_KEY_RE: exactly 30 alphanumerics', () => {
    expect(PUSHOVER_KEY_RE.test(USER)).toBe(true);
    expect(PUSHOVER_KEY_RE.test(USER.slice(1))).toBe(false);
    expect(PUSHOVER_KEY_RE.test(`${USER.slice(1)}-`)).toBe(false);
  });

  it('generic secrets ride the TokenStore under notify: accounts that cannot be connection ids', () => {
    const s = new MemoryTokenStore();
    s.setSecret(NOTIFY_ACCOUNTS.pushoverUser, USER);
    expect(s.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER);
    expect(s.getRefreshToken(NOTIFY_ACCOUNTS.pushoverUser)).toBe(USER); // same namespace, by design
    s.deleteSecret(NOTIFY_ACCOUNTS.pushoverUser);
    expect(s.getSecret(NOTIFY_ACCOUNTS.pushoverUser)).toBeNull();
    expect(NOTIFY_ACCOUNTS.pushoverUser.startsWith('notify:')).toBe(true);
  });
});

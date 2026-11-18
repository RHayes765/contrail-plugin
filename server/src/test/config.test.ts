import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadPolicies,
  readConfigSection,
  saveConfigSection,
} from '../core/config.js';
import { DEFAULT_POLICIES } from '../core/policy.js';

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CONTRAIL_DATA_DIR',
  'CONTRAIL_SF_CLIENT_ID',
  'CONTRAIL_SF_API_VERSION',
  'CONTRAIL_OAUTH_CALLBACK_PORT',
  'CONTRAIL_OAUTH_CALLBACK_PATH',
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-cfg-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  delete process.env.CONTRAIL_SF_CLIENT_ID;
  delete process.env.CONTRAIL_SF_API_VERSION;
  delete process.env.CONTRAIL_OAUTH_CALLBACK_PORT;
  delete process.env.CONTRAIL_OAUTH_CALLBACK_PATH;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('config', () => {
  it('writes a discoverable default config.json on first load', () => {
    const cfg = loadConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    expect(onDisk.salesforce.clientId).toBe('PlatformCLI');
  });

  it('merges partial file config over defaults', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ salesforce: { clientId: 'MyApp' }, oauth: { callbackPort: 7717 } }),
    );
    const cfg = loadConfig();
    expect(cfg.salesforce.clientId).toBe('MyApp');
    expect(cfg.salesforce.apiVersion).toBe(DEFAULT_CONFIG.salesforce.apiVersion);
    expect(cfg.oauth.callbackPort).toBe(7717);
    expect(cfg.oauth.callbackPath).toBe(DEFAULT_CONFIG.oauth.callbackPath);
  });

  it('lets env vars override the file', () => {
    process.env.CONTRAIL_SF_CLIENT_ID = 'EnvClient';
    process.env.CONTRAIL_OAUTH_CALLBACK_PORT = '9999';
    const cfg = loadConfig();
    expect(cfg.salesforce.clientId).toBe('EnvClient');
    expect(cfg.oauth.callbackPort).toBe(9999);
  });

  it('ignores an invalid callback port env value', () => {
    process.env.CONTRAIL_OAUTH_CALLBACK_PORT = 'not-a-port';
    expect(loadConfig().oauth.callbackPort).toBe(DEFAULT_CONFIG.oauth.callbackPort);
  });

  it('survives a corrupt config file', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{not json');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('S45: deploy.preImageTimeoutMs / revertRetentionDays default and merge partially', () => {
    expect(DEFAULT_CONFIG.deploy.preImageTimeoutMs).toBe(120_000);
    expect(DEFAULT_CONFIG.deploy.revertRetentionDays).toBe(30);
    // The default file written on first load carries both knobs (discoverable).
    loadConfig();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    expect(onDisk.deploy.preImageTimeoutMs).toBe(120_000);
    expect(onDisk.deploy.revertRetentionDays).toBe(30);
    // A partial deploy section overrides one knob and keeps the rest.
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ deploy: { revertRetentionDays: 0 } }),
    );
    const cfg = loadConfig();
    expect(cfg.deploy.revertRetentionDays).toBe(0);
    expect(cfg.deploy.preImageTimeoutMs).toBe(120_000);
    expect(cfg.deploy.codeTtlMs).toBe(DEFAULT_CONFIG.deploy.codeTtlMs);
  });

  it('S46: snapshot.rebaselineAfterDeploy / rebaselineTimeoutMs default and merge partially', () => {
    expect(DEFAULT_CONFIG.snapshot.rebaselineAfterDeploy).toBe(true);
    expect(DEFAULT_CONFIG.snapshot.rebaselineTimeoutMs).toBe(60_000);
    loadConfig();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    expect(onDisk.snapshot.rebaselineAfterDeploy).toBe(true);
    expect(onDisk.snapshot.rebaselineTimeoutMs).toBe(60_000);
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ snapshot: { rebaselineAfterDeploy: false } }),
    );
    const cfg = loadConfig();
    expect(cfg.snapshot.rebaselineAfterDeploy).toBe(false);
    expect(cfg.snapshot.rebaselineTimeoutMs).toBe(60_000);
    expect(cfg.snapshot.types).toEqual(DEFAULT_CONFIG.snapshot.types);
  });
});

describe('S46: policies', () => {
  const file = () => path.join(tmp, 'config.json');
  /** readFileSync calls that read config.json (other reads are not counted). */
  function countConfigReads() {
    const spy = vi.spyOn(fs, 'readFileSync');
    return () => spy.mock.calls.filter((c) => c[0] === file()).length;
  }

  it('the default file carries the built-in rule, and loadPolicies then reads it from config', () => {
    loadConfig();
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(onDisk.policies.rules[0].name).toBe('default: production needs a justification');
    expect(DEFAULT_CONFIG.policies).toEqual(DEFAULT_POLICIES);
    expect(loadPolicies()).toEqual({ ok: true, policies: DEFAULT_POLICIES, source: 'config' });
  });

  it('a rules array on disk replaces the built-in rule', () => {
    fs.writeFileSync(file(), JSON.stringify({ policies: { rules: [] } }));
    expect(loadConfig().policies).toEqual({ rules: [] });
    expect(loadPolicies()).toEqual({ ok: true, policies: { rules: [] }, source: 'config' });
  });

  it('no file → the built-in rule with source default, and no file is written', () => {
    expect(loadPolicies()).toEqual({ ok: true, policies: DEFAULT_POLICIES, source: 'default' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a missing file is looked for again after the pause: one written meanwhile is read from config, and only a second miss is the default', () => {
    // An editor that saves by renaming the old file away and then writing
    // the new one leaves a brief gap with no config.json.
    const policies = { rules: [{ name: 'r', requireTicket: true }] };
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      fs.writeFileSync(file(), JSON.stringify({ policies }));
      return 'timed-out';
    });
    expect(loadPolicies()).toEqual({ ok: true, policies, source: 'config' });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]![3]).toBe(50);

    fs.rmSync(file());
    wait.mockImplementation(() => 'timed-out');
    expect(loadPolicies()).toEqual({ ok: true, policies: DEFAULT_POLICIES, source: 'default' });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a file without the section (an install upgraded from 0.39) → default; loadConfig leaves its bytes unchanged', () => {
    const text = JSON.stringify({ salesforce: { clientId: 'MyApp' } }, null, 2) + '\n';
    fs.writeFileSync(file(), text);
    const cfg = loadConfig();
    expect(cfg.policies).toEqual(DEFAULT_POLICIES);
    expect(fs.readFileSync(file(), 'utf8')).toBe(text);
    expect(loadPolicies()).toEqual({ ok: true, policies: DEFAULT_POLICIES, source: 'default' });
    expect(fs.readFileSync(file(), 'utf8')).toBe(text);
  });

  it('a valid section → source config', () => {
    const policies = {
      rules: [
        {
          name: 'acme',
          match: { connections: ['acme-*'] },
          requireTicket: true,
          ticketPattern: 'ACME-\\d+',
          freezeWindows: [{ name: 'Weekend', weekly: { from: 'fri 17:00', to: 'mon 08:00' }, timeZone: 'UTC' }],
        },
      ],
    };
    fs.writeFileSync(file(), JSON.stringify({ policies }));
    expect(loadPolicies()).toEqual({ ok: true, policies, source: 'config' });
  });

  it('{not json → ok:false naming JSON, only after a second read; loadConfig still falls back to defaults', () => {
    fs.writeFileSync(file(), '{not json');
    const reads = countConfigReads();
    const result = loadPolicies();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toMatch(/^config\.json is not valid JSON \(/);
    expect(reads()).toBe(2);
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('the pause before the second read is about 50 ms; a file completed during it is read normally', () => {
    fs.writeFileSync(file(), '');
    const complete = JSON.stringify({ policies: { rules: [{ name: 'r', requireTicket: true }] } });
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      fs.writeFileSync(file(), complete);
      return 'timed-out';
    });
    const reads = countConfigReads();
    expect(loadPolicies()).toEqual({
      ok: true,
      policies: { rules: [{ name: 'r', requireTicket: true }] },
      source: 'config',
    });
    expect(reads()).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]![3]).toBe(50);
  });

  it('a read that throws is retried once; two failed reads fail closed', () => {
    fs.writeFileSync(file(), JSON.stringify({ policies: { rules: [] } }));
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync');
    spy.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    expect(loadPolicies()).toEqual({ ok: true, policies: { rules: [] }, source: 'config' });
    spy.mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (p === file()) throw new Error('EBUSY: resource busy or locked');
      return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    expect(loadPolicies()).toEqual({
      ok: false,
      problem: 'config.json could not be read (EBUSY: resource busy or locked)',
    });
  });

  it('a section that does not parse fails closed at once, its problem prefixed with the path', () => {
    fs.writeFileSync(file(), JSON.stringify({ policies: { rules: [{ name: 'r', requireTickets: true }] } }));
    const reads = countConfigReads();
    const result = loadPolicies();
    expect(result).toEqual({
      ok: false,
      problem:
        'policies.rules[0]: unknown key "requireTickets" (known: name, match, requireJustification, requireTicket, ticketPattern, denyDestructiveMetadata, denyDataDeletes, denyAnonymousApex, minTestLevel, freezeWindows)',
    });
    expect(reads()).toBe(1);
    fs.writeFileSync(file(), JSON.stringify({ policies: [] }));
    expect(loadPolicies()).toEqual({ ok: false, problem: 'policies: expected {"rules": [ … ]}, got a list' });
    fs.writeFileSync(file(), JSON.stringify({ policies: null }));
    expect(loadPolicies()).toEqual({ ok: false, problem: 'policies: expected {"rules": [ … ]}, got null' });
  });

  it('a file that is JSON but not an object fails closed', () => {
    fs.writeFileSync(file(), '[]');
    expect(loadPolicies()).toEqual({ ok: false, problem: 'config.json is not a JSON object' });
  });

  it('a UTF-16 file is named by its encoding at once; loadConfig falls back to defaults and a save never overwrites it', () => {
    const body = JSON.stringify({ notifications: { method: 'pushover' }, policies: { rules: [] } }, null, 2);
    const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
    const big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body, 'utf16le').swap16()]);
    for (const bytes of [little, big]) {
      fs.writeFileSync(file(), bytes);
      const reads = countConfigReads();
      const wait = vi.spyOn(Atomics, 'wait');
      expect(loadPolicies()).toEqual({ ok: false, problem: 'config.json is saved as UTF-16; save it as UTF-8' });
      expect(reads()).toBe(1);
      expect(wait).not.toHaveBeenCalled();
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
      expect(readConfigSection('notifications')).toBeNull();
      expect(() => saveConfigSection('notifications', { summary: 'full' })).toThrow(
        `config.json is saved as UTF-16; save it as UTF-8 (${file()}), then save again — nothing was written.`,
      );
      expect(fs.readFileSync(file()).equals(bytes)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it('a UTF-8 byte-order mark is read past by every reader, and a save does not write it back', () => {
    const body = {
      salesforce: { clientId: 'MyApp' },
      notifications: { method: 'pushover' },
      policies: { rules: [{ name: 'r', requireJustification: true }] },
    };
    fs.writeFileSync(file(), '﻿' + JSON.stringify(body, null, 2));
    expect(loadPolicies()).toEqual({ ok: true, policies: body.policies, source: 'config' });
    const cfg = loadConfig();
    expect(cfg).not.toEqual(DEFAULT_CONFIG);
    expect(cfg.salesforce.clientId).toBe('MyApp');
    expect(cfg.notifications.method).toBe('pushover');
    expect(readConfigSection('notifications')).toEqual({ method: 'pushover' });

    saveConfigSection('notifications', { summary: 'full' });
    const raw = fs.readFileSync(file());
    expect(raw[0]).toBe(0x7b); // '{', no EF BB BF
    const saved = JSON.parse(raw.toString('utf8'));
    expect(saved.notifications).toEqual({ method: 'pushover', summary: 'full' });
    expect(saved.policies).toEqual(body.policies);
    expect(saved.salesforce).toEqual({ clientId: 'MyApp' });
  });
});

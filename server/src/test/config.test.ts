import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../core/config.js';

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
});

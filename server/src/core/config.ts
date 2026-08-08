import fs from 'node:fs';
import { configPath } from './paths.js';
import { log } from './log.js';

/**
 * Engine configuration. Stored as config.json in the data dir so humans can
 * edit it; environment variables override the file. A default file is written
 * on first run so the knobs are discoverable.
 *
 * The default OAuth client is the Salesforce CLI's well-known public client
 * ("PlatformCLI", callback http://localhost:1717/OauthRedirect), which lets
 * Phase 0 dogfooding start before the Contrail connected app exists (spec §8
 * open item). Swap in the Contrail connected app by editing salesforce.clientId
 * and oauth.callbackPort/callbackPath to match its registered callback URL.
 */
export interface ContrailConfig {
  salesforce: {
    /** OAuth client id of the connected app (public client, PKCE — no secret). */
    clientId: string;
    /** REST API version used for org info queries. */
    apiVersion: string;
    /** Scopes requested during authorization. */
    scopes: string[];
  };
  oauth: {
    /** Fixed callback port — must match the connected app's registered callback URL. */
    callbackPort: number;
    /** Callback path — must match the connected app's registered callback URL. */
    callbackPath: string;
    /** Hard limit for a human to complete the browser flow. */
    flowTimeoutMs: number;
    /**
     * How long connect_org waits inline before returning an "in progress"
     * result (kept short so MCP client tool timeouts are never hit; the flow
     * keeps running in the background either way).
     */
    toolWaitMs: number;
  };
  snapshot: {
    /** Metadata types in the default manifest (children like CustomField come along with their container). */
    types: string[];
    /** checkRetrieveStatus poll interval. */
    pollIntervalMs: number;
    /** Hard limit for one retrieve operation. */
    retrieveTimeoutMs: number;
    /** Inline wait before refresh_snapshot returns an in-progress result. */
    toolWaitMs: number;
  };
  deploy: {
    /** checkDeployStatus poll interval. */
    pollIntervalMs: number;
    /** Hard limit for one validation or deploy operation. */
    deployTimeoutMs: number;
    /** Confirmation code lifetime (spec §5: ~1h). */
    codeTtlMs: number;
    /** Inline wait before validate/execute return an in-progress result. */
    toolWaitMs: number;
    /** Wrong-code guesses that invalidate a pending code (brute-force guard). */
    maxFailedAttempts: number;
  };
}

export const DEFAULT_CONFIG: ContrailConfig = {
  salesforce: {
    clientId: 'PlatformCLI',
    apiVersion: 'v63.0',
    scopes: ['refresh_token', 'api', 'web'],
  },
  oauth: {
    callbackPort: 1717,
    callbackPath: '/OauthRedirect',
    flowTimeoutMs: 10 * 60 * 1000,
    toolWaitMs: 25 * 1000,
  },
  snapshot: {
    types: ['ApexClass', 'ApexTrigger', 'Flow', 'CustomObject', 'CustomLabels', 'PermissionSet'],
    pollIntervalMs: 2000,
    retrieveTimeoutMs: 10 * 60 * 1000,
    toolWaitMs: 25 * 1000,
  },
  deploy: {
    pollIntervalMs: 2000,
    deployTimeoutMs: 15 * 60 * 1000,
    codeTtlMs: 60 * 60 * 1000,
    toolWaitMs: 25 * 1000,
    maxFailedAttempts: 5,
  },
};

export function loadConfig(): ContrailConfig {
  const file = configPath();
  let fromDisk: Partial<ContrailConfig> = {};
  if (fs.existsSync(file)) {
    try {
      fromDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ContrailConfig>;
    } catch (err) {
      log('warn', `config.json is unreadable; using defaults`, { file, err: String(err) });
    }
  } else {
    try {
      fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    } catch (err) {
      log('warn', 'could not write default config.json', { file, err: String(err) });
    }
  }

  const merged: ContrailConfig = {
    salesforce: { ...DEFAULT_CONFIG.salesforce, ...fromDisk.salesforce },
    oauth: { ...DEFAULT_CONFIG.oauth, ...fromDisk.oauth },
    snapshot: { ...DEFAULT_CONFIG.snapshot, ...fromDisk.snapshot },
    deploy: { ...DEFAULT_CONFIG.deploy, ...fromDisk.deploy },
  };

  if (process.env.CONTRAIL_SF_CLIENT_ID) {
    merged.salesforce.clientId = process.env.CONTRAIL_SF_CLIENT_ID;
  }
  if (process.env.CONTRAIL_SF_API_VERSION) {
    merged.salesforce.apiVersion = process.env.CONTRAIL_SF_API_VERSION;
  }
  if (process.env.CONTRAIL_OAUTH_CALLBACK_PORT) {
    const port = Number(process.env.CONTRAIL_OAUTH_CALLBACK_PORT);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      merged.oauth.callbackPort = port;
    }
  }
  if (process.env.CONTRAIL_OAUTH_CALLBACK_PATH) {
    merged.oauth.callbackPath = process.env.CONTRAIL_OAUTH_CALLBACK_PATH;
  }
  return merged;
}

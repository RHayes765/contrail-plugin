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
  updates: {
    /**
     * Once a day, ask the GitHub Releases API whether a newer Contrail exists
     * (one anonymous GET — the product's only phone-home). Set false to
     * disable entirely; the check never blocks or delays any tool call.
     */
    checkEnabled: boolean;
  };
  localDiagnostics: {
    /**
     * check_apex / check_soql: local static diagnostics via the vendored
     * Salesforce language servers (server/vendor/ — fully offline, no org
     * traffic). Set false to disable both tools; they then report themselves
     * unavailable rather than pretending to have checked anything.
     */
    enabled: boolean;
    /** Hard budget for one check, including a cold server spawn. */
    timeoutMs: number;
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
    /**
     * Extra directories validate_deploy may read content_file from, on top of
     * Contrail's own staging/ and snapshots/. Absolute paths only. This is
     * deliberately config-file-only: widening what can be deployed is the
     * human's decision, and no tool call can do it.
     */
    allowedSourceRoots: string[];
  };
  bulkLoad: {
    /** Ingest job status poll interval (jobs are minutes-scale). */
    pollIntervalMs: number;
    /** Hard limit for ONE ingest job to reach a terminal state. */
    ingestTimeoutMs: number;
    /** Per-CSV size cap (Salesforce's own raw ceiling is ~100 MB per job). */
    maxFileBytes: number;
    /** Maximum steps (files) in one bulk plan. */
    maxFilesPerPlan: number;
    /** Inline wait before bulk_load_execute returns an in-progress result. */
    toolWaitMs: number;
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
    // Integration/eventing types (ConnectedApp, NamedCredential,
    // ExternalCredential, PlatformEventChannel[Member],
    // ManagedEventSubscription) are deployable and indexable but kept OUT of
    // the default manifest — retrieve them explicitly via refresh_snapshot
    // types, or add them here.
    types: [
      'ApexClass',
      'ApexTrigger',
      'Flow',
      'CustomObject',
      'CustomLabels',
      'PermissionSet',
      'CustomTab',
      'FlexiPage',
      'CustomApplication',
      'ReportType',
      'ApexPage',
      'GlobalValueSet',
      'Layout',
      'CustomMetadata',
    ],
    pollIntervalMs: 2000,
    retrieveTimeoutMs: 10 * 60 * 1000,
    toolWaitMs: 25 * 1000,
  },
  updates: {
    checkEnabled: true,
  },
  localDiagnostics: {
    enabled: true,
    timeoutMs: 30 * 1000,
  },
  deploy: {
    pollIntervalMs: 2000,
    deployTimeoutMs: 15 * 60 * 1000,
    codeTtlMs: 60 * 60 * 1000,
    toolWaitMs: 25 * 1000,
    maxFailedAttempts: 5,
    // Empty by default: staging/ and snapshots/ are always allowed, and
    // anything wider is an explicit decision the human writes down.
    allowedSourceRoots: [],
  },
  bulkLoad: {
    pollIntervalMs: 5000,
    ingestTimeoutMs: 30 * 60 * 1000,
    maxFileBytes: 100_000_000,
    maxFilesPerPlan: 20,
    toolWaitMs: 25 * 1000,
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
    updates: { ...DEFAULT_CONFIG.updates, ...fromDisk.updates },
    localDiagnostics: { ...DEFAULT_CONFIG.localDiagnostics, ...fromDisk.localDiagnostics },
    deploy: { ...DEFAULT_CONFIG.deploy, ...fromDisk.deploy },
    bulkLoad: { ...DEFAULT_CONFIG.bulkLoad, ...fromDisk.bulkLoad },
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

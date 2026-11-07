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
     * (one anonymous GET — the product's only UNPROMPTED phone-home; the other
     * outbound call, S42's approval notification, is opt-in and per-event).
     * Set false to disable entirely; the check never blocks or delays any
     * tool call.
     */
    checkEnabled: boolean;
  };
  notifications: {
    /**
     * S42: where a freshly minted confirmation code is ALSO delivered, beside
     * the human-only approval page — so the human can approve from a phone
     * (the localhost page is unreachable from one). 'pushover' sends one
     * HTTPS POST to api.pushover.net per approval, carrying the review
     * summary and the code; the user key and application token live in the
     * OS keychain (set on the Settings page, never here). 'none' sends
     * nothing. The agent never sees the code either way.
     */
    method: 'none' | 'pushover';
    /**
     * How much of the review travels in the message. 'minimal' = your
     * connection alias, the org type, change/deletion/warning COUNTS and the
     * code — no component names leave the machine. 'full' adds the component
     * labels and warning text (they transit Pushover's servers — a
     * confidentiality decision for client orgs); data changes are reduced to
     * operation + object, never record field values.
     */
    summary: 'minimal' | 'full';
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
    /** S40: failed/success result dirs older than this are swept at the next
     * bulk propose. 0 keeps them forever. */
    resultsRetentionDays: number;
    /** Inline wait before bulk_load_execute returns an in-progress result. */
    toolWaitMs: number;
  };
}

export const DEFAULT_CONFIG: ContrailConfig = {
  salesforce: {
    clientId: 'PlatformCLI',
    // S30: v66 is the floor for the Agentforce types (GenAiPlannerBundle
    // exists only at v64+, AiAuthoringBundle only at v66+, and it deploys
    // draft-stage since S34; the legacy GenAiPlanner type died at v64 —
    // probed live). S34: default raised to v67 (Summer '26) — probed healthy
    // for the whole old-model agent family on live orgs 2026-09-30; Winter
    // '27's v68 (AiAgentDefinition era) was not yet reachable and lands in a
    // later release. A config.json that pins an older version keeps it until
    // the human edits it.
    apiVersion: 'v67.0',
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
    // ExternalCredential, AuthProvider, PlatformEventChannel[Member],
    // ManagedEventSubscription) are deployable and indexable but kept OUT of
    // the default manifest — retrieve them explicitly via refresh_snapshot
    // types, or add them here. S29: analytics types (Report, Dashboard and
    // their folders) are likewise explicit-refresh-only — big orgs carry
    // thousands of reports and every folder costs a listMetadata query;
    // refresh_snapshot types:['Report'] pulls ReportFolder along
    // automatically (they share a snapshot directory). S30: Agentforce types
    // (Bot, GenAiPlugin, GenAiFunction, GenAiPlannerBundle,
    // AiAuthoringBundle, GenAiPromptTemplate[Actv], AiEvaluationDefinition,
    // BotTemplate, BotBlock) are explicit-refresh-only too — they are
    // licensing-gated (unlicensed orgs report them unsupported, degraded
    // per-type with a warning) and need salesforce.apiVersion v66+.
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
      // S31: the lead-conversion singleton — one small file, and lead
      // routing/conversion work reads it constantly. Absent-until-configured
      // orgs return nothing for it (harmless).
      'LeadConvertSettings',
      // S36: permissions & UI-action types — small core-config documents
      // plus LWC source (the ApexClass precedent: component code belongs in
      // the default index). Package-installed bundles (managed OR unlocked)
      // are excluded from wildcard retrieves by the platform and from
      // staleness noise by the isManaged guard.
      'CustomPermission',
      'PermissionSetGroup',
      'MutingPermissionSet',
      'QuickAction',
      'LightningComponentBundle',
      // S41: Aura bundles join LWC — same rationale, and cheap: orgs own few
      // namespace-free bundles (installed ones are platform-excluded from
      // wildcards; the named-member expansion still fetches the
      // namespace-free installedEditable ones).
      'AuraDefinitionBundle',
    ],
    pollIntervalMs: 2000,
    retrieveTimeoutMs: 10 * 60 * 1000,
    toolWaitMs: 25 * 1000,
  },
  updates: {
    checkEnabled: true,
  },
  notifications: {
    method: 'none',
    summary: 'minimal',
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
    resultsRetentionDays: 14,
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
    notifications: { ...DEFAULT_CONFIG.notifications, ...fromDisk.notifications },
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

/**
 * S42: persist a patch to ONE config section. Patches the on-disk partial —
 * never the merged, env-overridden object loadConfig returns, which would
 * freeze environment overrides (and every default) into the human's file.
 * Unknown sections on disk are preserved verbatim. An existing file that is
 * not valid JSON is NEVER overwritten (a hand-edit with a typo must stay
 * repairable) — the save throws and the Settings surface says so.
 */
export function saveConfigSection<K extends keyof ContrailConfig>(
  section: K,
  patch: Partial<ContrailConfig[K]>,
): void {
  const file = configPath();
  let onDisk: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(
        `config.json exists but is not valid JSON (${String(err instanceof Error ? err.message : err)}). ` +
          `Fix or remove ${file}, then save again — nothing was written.`,
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      onDisk = parsed as Record<string, unknown>;
    }
  }
  const current = onDisk[section];
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  onDisk[section] = { ...base, ...patch };
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
}

/**
 * S42: the on-disk value of ONE section (no defaults, no env) — null when the
 * file or the section is absent or unreadable. The notifier uses it to pick
 * up a change saved by the OTHER surface (plugin vs desktop app) without a
 * restart.
 */
export function readConfigSection<K extends keyof ContrailConfig>(
  section: K,
): Partial<ContrailConfig[K]> | null {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[section];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ContrailConfig[K]>)
      : null;
  } catch {
    return null;
  }
}

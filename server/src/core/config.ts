import fs from 'node:fs';
import { configPath } from './paths.js';
import { log } from './log.js';
import { DEFAULT_POLICIES, parsePolicies, type PolicyConfig } from './policy.js';

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
    /**
     * S46: after a successful deploy, re-read the deployed components into
     * the local snapshot (best-effort; the execute result's snapshot block
     * says what was updated). false restores the manual refresh_snapshot.
     */
    rebaselineAfterDeploy: boolean;
    /** S46: budget for that re-read inside the execute call. */
    rebaselineTimeoutMs: number;
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
    /**
     * S43: WHEN a push goes out (plugin / Claude Code sessions only — the
     * desktop app's code-free push ignores this). 'remote_control' (default)
     * pushes only while the Claude Code session has Remote Control connected,
     * because a code on a phone is useless when it cannot be typed from one;
     * the state comes from Contrail's PreToolUse hook (shipped with the plugin,
     * or installed into ~/.claude/settings.json from the Settings page). With
     * no hook report for a call the push is skipped and the tool result says
     * why. 'always' restores the S42 behaviour: every approval is pushed.
     */
    when: 'remote_control' | 'always';
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
    /**
     * S45: budget for the live pre-image retrieve validate_deploy runs
     * beside the checkOnly deploy — the org's current version of every
     * package member, which the approval page diffs against. Past it the
     * page falls back to the local snapshot and says the org was not re-read.
     */
    preImageTimeoutMs: number;
    /**
     * S45: days an executed (or outcome-unknown) deploy's revert package
     * under staging/_reverts/ is kept before a later validate sweeps it.
     * 0 = never.
     */
    revertRetentionDays: number;
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
  /**
   * S46: rules for client work, matched by org type and/or connection.
   * Deliberately config-file-only: no Contrail tool or page writes this
   * section, and loosening a rule is the human's decision. Re-read from disk
   * at every evaluation, so an edit applies without a restart.
   */
  policies: PolicyConfig;
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
    // BotTemplate, BotBlock — and, S44, AiTestingDefinition and
    // AiAgentScorerDefinition) are explicit-refresh-only too — they are
    // licensing-gated (unlicensed orgs report them unsupported, degraded
    // per-type with a warning) and need salesforce.apiVersion v66+. S47:
    // OmniDataTransform (Omnistudio Data Mappers) is explicit-refresh-only
    // too — refresh_snapshot types:['OmniDataTransform']. Salesforce's type
    // page requires an Omnistudio licence, and with the org's Omnistudio
    // Metadata setting off a probed org listed none of the Data Mappers it
    // held as records.
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
    rebaselineAfterDeploy: true,
    rebaselineTimeoutMs: 60_000,
  },
  updates: {
    checkEnabled: true,
  },
  notifications: {
    method: 'none',
    summary: 'minimal',
    when: 'remote_control',
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
    preImageTimeoutMs: 120_000,
    revertRetentionDays: 30,
  },
  bulkLoad: {
    pollIntervalMs: 5000,
    ingestTimeoutMs: 30 * 60 * 1000,
    maxFileBytes: 100_000_000,
    maxFilesPerPlan: 20,
    resultsRetentionDays: 14,
    toolWaitMs: 25 * 1000,
  },
  // Written into fresh config files only: an existing config.json is never
  // back-filled, so an install upgraded from 0.39 has no policies section and
  // loadPolicies() reports the built-in rule with source 'default'.
  policies: DEFAULT_POLICIES,
};

/**
 * S46: a config.json that starts with a UTF-16 byte-order mark (FF FE or
 * FE FF — bytes UTF-8 never contains). Windows PowerShell 5.1 writes UTF-16
 * by default for `>` and Out-File; Contrail reads config.json as UTF-8 only,
 * so such a file is reported by its encoding rather than as broken JSON.
 */
class ConfigEncodingError extends Error {}

const UTF16_PROBLEM = 'config.json is saved as UTF-16; save it as UTF-8';

/**
 * S46: the text of config.json, read as UTF-8 with a single leading UTF-8
 * byte-order mark removed. Every reader and writer of the file goes through
 * it, so they agree on what a readable file is (Windows PowerShell 5.1's
 * `-Encoding UTF8` and some editors write the mark; such a file used to fall
 * back to defaults silently). A UTF-16 file throws ConfigEncodingError.
 */
function readConfigText(file: string): string {
  const bytes = fs.readFileSync(file);
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    throw new ConfigEncodingError(UTF16_PROBLEM);
  }
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function loadConfig(): ContrailConfig {
  const file = configPath();
  let fromDisk: Partial<ContrailConfig> = {};
  if (fs.existsSync(file)) {
    try {
      fromDisk = JSON.parse(readConfigText(file)) as Partial<ContrailConfig>;
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
    // A rules array on disk replaces the built-in rule wholesale. Not
    // validated here: a wired engine reads policies through loadPolicies(),
    // which fails closed on a bad section; this copy is what an engine built
    // with an injected config evaluates (through parsePolicies).
    policies: { ...DEFAULT_CONFIG.policies, ...fromDisk.policies },
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
 * S46: a leading UTF-8 byte-order mark is read past and not written back;
 * the write stays in place (no temp file, no rename). A UTF-16 file is never
 * overwritten either: the save throws, naming the encoding.
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
      parsed = JSON.parse(readConfigText(file));
    } catch (err) {
      if (err instanceof ConfigEncodingError) {
        throw new Error(`${err.message} (${file}), then save again — nothing was written.`);
      }
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
    const parsed: unknown = JSON.parse(readConfigText(file));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[section];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ContrailConfig[K]>)
      : null;
  } catch {
    return null;
  }
}

/** S46: what loadPolicies() read — the policies and where they came from, or why they could not be read. */
export type PolicyLoad =
  | { ok: true; policies: PolicyConfig; source: 'default' | 'config' }
  | { ok: false; problem: string };

/** Private to loadPolicies' pause: Atomics.wait needs a shared array. */
const RETRY_PAUSE = new Int32Array(new SharedArrayBuffer(4));
const RETRY_PAUSE_MS = 50;

type PoliciesRead = { load: PolicyLoad; retry: boolean };

function readPoliciesOnce(file: string): PoliciesRead {
  if (!fs.existsSync(file)) {
    // loadConfig writes the file at first start, so after that a missing
    // file is most likely an editor's save in progress (rename the old file
    // away, then write the new one): read again before applying the default.
    return { load: { ok: true, policies: DEFAULT_POLICIES, source: 'default' }, retry: true };
  }
  let text: string;
  try {
    text = readConfigText(file);
  } catch (err) {
    // The bytes say UTF-16: no torn write produces that, so no second read.
    if (err instanceof ConfigEncodingError) {
      return { load: { ok: false, problem: err.message }, retry: false };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { load: { ok: false, problem: `config.json could not be read (${message})` }, retry: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { load: { ok: false, problem: `config.json is not valid JSON (${message})` }, retry: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { load: { ok: false, problem: 'config.json is not a JSON object' }, retry: false };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'policies')) {
    return { load: { ok: true, policies: DEFAULT_POLICIES, source: 'default' }, retry: false };
  }
  const result = parsePolicies((parsed as Record<string, unknown>).policies);
  if (!result.ok) {
    // parsePolicies' paths start inside the section ("rules[0]…"); a
    // problem with the section itself carries no path.
    const problem = result.problem.startsWith('rules')
      ? `policies.${result.problem}`
      : `policies: ${result.problem}`;
    return { load: { ok: false, problem }, retry: false };
  }
  return { load: { ok: true, policies: result.policies, source: 'config' }, retry: false };
}

/**
 * S46: the policies section, read from disk on every call (each policy
 * check calls it). No file, or a file without the section → the built-in
 * rule with source 'default' (an existing file is never back-filled).
 * Fails closed — every write proposal is then refused — on a section that
 * does not parse, and on a file that cannot be read, is saved as UTF-16 or
 * is not JSON. A read that may have landed inside a human-side save is
 * retried once, about 50 ms later, before its verdict: a file that cannot be
 * read or is not JSON (a save that rewrites the file in place), and a
 * missing file (an editor that saves by renaming the old file away and then
 * writing the new one leaves a brief gap) — so only a second miss yields the
 * built-in rule. The pause blocks the thread; it happens only on a broken or
 * missing file, or a torn read.
 */
export function loadPolicies(): PolicyLoad {
  const file = configPath();
  const first = readPoliciesOnce(file);
  if (!first.retry) return first.load;
  Atomics.wait(RETRY_PAUSE, 0, 0, RETRY_PAUSE_MS);
  return readPoliciesOnce(file).load;
}

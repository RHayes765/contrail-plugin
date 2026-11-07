import type { ContrailConfig } from './config.js';
import type { TokenStore } from './keychain.js';
import type { ApprovalPageOptions } from '../connect/pages.js';
import { log } from './log.js';

/**
 * S42: approval notifications — a freshly minted confirmation code (and the
 * review substance behind it) ALSO goes to the human's phone, because the
 * human-only localhost approval page is unreachable from one. Pushover is the
 * delivery service: one HTTPS POST per approval.
 *
 * MIRROR FILE — byte-identical in the plugin (server/src/core/notify.ts) and
 * the desktop engine (packages/engine/src/core/notify.ts).
 *
 * The contract that keeps the write-safety invariant intact:
 * - The send happens ENGINE-SIDE at mint time. The agent never sees the code,
 *   the user key, the application token, or any response body — tool results
 *   and audit rows carry outcome CATEGORIES only.
 * - The destination is human-owned: method/depth live in config.json, keys in
 *   the OS keychain, both set only on the human-only Settings surfaces.
 * - Never block, never fail a proposal: one bounded attempt, no retries (a 4xx
 *   is final per Pushover's API and repeated 4xx gets the IP blocked, so a bad
 *   key opens a circuit breaker instead of failing every proposal).
 * - The code is proof the human REVIEWED: the message carries the org, the
 *   counts and (with summary 'full') the labels — not a bare code. Labels for
 *   DATA changes are reduced to operation + object: record field values are
 *   someone's PII and never ride a push.
 */

export const NOTIFY_ACCOUNTS = {
  pushoverUser: 'notify:pushover:user',
  pushoverToken: 'notify:pushover:token',
} as const;

/** Pushover user keys and application tokens: 30 chars, [A-Za-z0-9]. */
export const PUSHOVER_KEY_RE = /^[A-Za-z0-9]{30}$/;

const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json';
const TIMEOUT_MS = 5000;
/** A 4xx means the stored keys are wrong — pause sends so a bad key cannot earn an IP block. */
const REJECTED_PAUSE_MS = 10 * 60 * 1000;
/** Monthly quota exhausted (429) — pause until Pushover's reset stamp, or an hour. */
const QUOTA_PAUSE_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 1024;
const TITLE_MAX = 250;
const FULL_LABELS_MAX = 10;
const FULL_WARNINGS_MAX = 3;

export type NotificationsConfig = ContrailConfig['notifications'];
export type NotifyMethod = NotificationsConfig['method'];
export type NotifySummary = NotificationsConfig['summary'];

export type NotifyFailure =
  | 'not_configured'
  | 'store_unavailable'
  | 'rejected'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'circuit_open';

export type NotifyOutcome =
  | { status: 'sent' }
  | { status: 'off' }
  | { status: 'failed'; reason: NotifyFailure };

export interface NotifierStatus {
  method: NotifyMethod;
  /** Both keys present in the keychain (does not prove they are valid). */
  configured: boolean;
  /** Set when the OS keychain itself could not be read — distinct from "no keys stored". */
  storeError?: string;
}

export interface ApprovalNotifier {
  notify(view: ApprovalPageOptions, opts: { includeCode: boolean }): Promise<NotifyOutcome>;
  /** Settings-page button: validate the stored keys, then send a test message. */
  sendTest(): Promise<{ ok: boolean; message: string }>;
  status(): NotifierStatus;
  /** Settings changed — forget any pause from an earlier rejection. */
  resetCircuit(): void;
}

/** What the agent is told about the phone delivery (never the code, never a key). */
export interface PhoneNotification {
  status: 'sent' | 'failed' | 'off';
  reason?: NotifyFailure;
  note?: string;
}

/**
 * Agent-facing wording, branched on the PRESENTATION the human actually got:
 * `includeCode` is true for the localhost approval page (the phone carries the
 * code; the plugin's open_settings tool exists) and false for the desktop
 * app's native Deploy Review (the push is code-free; settings live in the app).
 */
export function describePhoneOutcome(
  outcome: NotifyOutcome,
  opts: { includeCode: boolean },
): PhoneNotification {
  if (outcome.status === 'off') return { status: 'off' };
  const settings = opts.includeCode ? 'via open_settings' : "in the app's Settings → Notifications";
  if (outcome.status === 'sent') {
    return {
      status: 'sent',
      note: opts.includeCode
        ? "The approval summary and code were also pushed to the human's phone. The code " +
          'still only counts when the human types it into this chat.'
        : "A code-free summary was pushed to the human's phone; they approve in the app's " +
          'Deploy Review screen as usual.',
    };
  }
  const hint: Record<NotifyFailure, string> = {
    not_configured:
      'phone notifications are switched on but the Pushover keys are missing — the human can ' +
      `set them ${settings}`,
    store_unavailable:
      'the OS keychain could not be read on this machine, so the stored Pushover keys are ' +
      'unreachable',
    rejected: `Pushover rejected the stored keys — the human should re-check them ${settings}`,
    quota: "Pushover's monthly message quota is exhausted",
    timeout: 'Pushover did not answer in time from this machine',
    network: 'Pushover was unreachable from this machine',
    circuit_open:
      'notifications are paused after a recent rejection — the human can fix the keys ' +
      `${settings}`,
  };
  return {
    status: 'failed',
    reason: outcome.reason,
    note:
      `Phone notification failed (${hint[outcome.reason]}). ` +
      (opts.includeCode
        ? "The code is only on the approval page in the human's browser."
        : "The proposal is still waiting in the app's Deploy Review screen."),
  };
}

export function approvalKindNoun(kind: ApprovalPageOptions['kind']): string {
  return kind === 'deploy'
    ? 'deploy'
    : kind === 'apex'
      ? 'Apex script'
      : kind === 'bulk'
        ? 'bulk data load'
        : kind === 'activation'
          ? 'agent activation'
          : 'data change';
}

export interface PushoverMessage {
  title: string;
  message: string;
  /** Seconds until Pushover deletes it from the devices — the code's own remaining life. */
  ttl: number;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function expiryClock(expiresAt: string): string {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 'soon';
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function remainingSeconds(expiresAt: string): number {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 3600;
  return Math.max(60, Math.ceil((t - Date.now()) / 1000));
}

/**
 * A row label fit for a phone. Data-change labels carry the record's field
 * values after the colon (`INSERT Contact: Email = "…"`) — that is PII, and it
 * stays on the machine: 'full' sends operation + object only for DML.
 */
function phoneLabel(kind: ApprovalPageOptions['kind'], label: string): string {
  const flat = squash(label);
  if (kind !== 'dml') return flat;
  const colon = flat.indexOf(':');
  return colon === -1 ? flat : flat.slice(0, colon).trim();
}

/**
 * The message itself. 'minimal' carries the connection alias, org type and
 * counts — no component names leave the machine. 'full' adds labels and
 * warnings. The code lines are composed LAST and protected from truncation: a
 * clipped code would be worse than no message at all.
 */
export function composePushover(
  view: ApprovalPageOptions,
  opts: { includeCode: boolean; summary: NotifySummary },
): PushoverMessage {
  const title = truncate(
    `Contrail: approve ${approvalKindNoun(view.kind)} → ${view.org.alias} (${view.org.orgType})`,
    TITLE_MAX,
  );
  const rowWarnings = [...view.destructive, ...view.changes].flatMap((r) => r.warnings);
  const warningCount = (view.warnings ?? []).length + rowWarnings.length;

  const head: string[] = [
    [
      plural(view.changes.length, 'change'),
      plural(view.destructive.length, 'deletion'),
      plural(warningCount, 'warning'),
    ].join(' · '),
  ];
  if (view.org.orgType === 'production') head.push('PRODUCTION org.');
  if (view.destructive.length > 0) head.push('Includes DELETIONS.');
  if (opts.summary === 'full') {
    const labels = [...view.destructive, ...view.changes].map((r) => phoneLabel(view.kind, r.label));
    head.push(...labels.slice(0, FULL_LABELS_MAX).map((l) => `• ${l}`));
    if (labels.length > FULL_LABELS_MAX) head.push(`• … ${labels.length - FULL_LABELS_MAX} more`);
    const warns = [...(view.warnings ?? []), ...rowWarnings].slice(0, FULL_WARNINGS_MAX);
    head.push(...warns.map((w) => `⚠ ${truncate(squash(w), 140)}`));
  }

  const tail: string[] = opts.includeCode
    ? [
        `Code: ${view.code} — expires ${expiryClock(view.expiresAt)}`,
        'Approve by typing the code into your Contrail session. Full details are on the ' +
          'approval page on your desktop.',
      ]
    : ['Waiting in Deploy Review — open the Contrail desktop app to approve.'];
  const tailText = tail.join('\n');
  const headText = truncate(head.join('\n'), Math.max(0, MESSAGE_MAX - tailText.length - 1));
  return {
    title,
    message: `${headText}\n${tailText}`,
    ttl: remainingSeconds(view.expiresAt),
  };
}

type HttpResult =
  | { kind: 'transport'; reason: 'timeout' | 'network' }
  | {
      kind: 'http';
      ok: boolean;
      status: number;
      errors: string[];
      json: Record<string, unknown> | null;
      resetAt: number | null;
    };

/**
 * Pushover's error strings are human-facing ("user identifier is invalid")
 * and today never echo a key — but both stored keys are exactly 30
 * alphanumerics, so any such run is redacted before the text can reach a log
 * line or a page.
 */
function sanitizeErrors(json: Record<string, unknown> | null): string[] {
  const raw = json?.errors;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string')
    .map((e) =>
      e
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/[A-Za-z0-9]{30,}/g, '[redacted]')
        .slice(0, 160),
    );
}

type Credentials =
  | { kind: 'ok'; user: string; token: string }
  | { kind: 'missing' }
  | { kind: 'unavailable'; error: string };

export class PushoverNotifier implements ApprovalNotifier {
  private pausedUntil = 0;

  /**
   * @param syncFromDisk the plugin and the desktop app share config.json but
   *   each holds its own loaded copy; before every send/status the notifier
   *   folds the on-disk `notifications` section into the live object so a
   *   change saved on either surface reaches the other without a restart.
   *   Production wiring passes a disk reader; tests (which inject their config
   *   object) leave the default, which syncs nothing.
   */
  constructor(
    private readonly config: ContrailConfig,
    private readonly secrets: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly syncFromDisk: () => Partial<NotificationsConfig> | null = () => null,
  ) {}

  private sync(): void {
    let disk: Partial<NotificationsConfig> | null = null;
    try {
      disk = this.syncFromDisk();
    } catch {
      disk = null;
    }
    if (disk && typeof disk === 'object') {
      if (disk.method === 'none' || disk.method === 'pushover') {
        this.config.notifications.method = disk.method;
      }
      if (disk.summary === 'minimal' || disk.summary === 'full') {
        this.config.notifications.summary = disk.summary;
      }
    }
  }

  status(): NotifierStatus {
    this.sync();
    const creds = this.credentials();
    return {
      method: this.config.notifications.method,
      configured: creds.kind === 'ok',
      ...(creds.kind === 'unavailable' ? { storeError: creds.error } : {}),
    };
  }

  resetCircuit(): void {
    this.pausedUntil = 0;
  }

  private credentials(): Credentials {
    try {
      const user = this.secrets.getSecret(NOTIFY_ACCOUNTS.pushoverUser);
      const token = this.secrets.getSecret(NOTIFY_ACCOUNTS.pushoverToken);
      return user && token ? { kind: 'ok', user, token } : { kind: 'missing' };
    } catch (err) {
      return { kind: 'unavailable', error: String(err instanceof Error ? err.message : err).slice(0, 200) };
    }
  }

  async notify(
    view: ApprovalPageOptions,
    opts: { includeCode: boolean },
  ): Promise<NotifyOutcome> {
    this.sync();
    if (this.config.notifications.method !== 'pushover') return { status: 'off' };
    const creds = this.credentials();
    if (creds.kind === 'unavailable') {
      log('warn', 'approval notification skipped: OS keychain unreadable', { reason: creds.error });
      return { status: 'failed', reason: 'store_unavailable' };
    }
    if (creds.kind === 'missing') return { status: 'failed', reason: 'not_configured' };
    if (Date.now() < this.pausedUntil) return { status: 'failed', reason: 'circuit_open' };

    const msg = composePushover(view, {
      includeCode: opts.includeCode,
      summary: this.config.notifications.summary,
    });
    const result = await this.call(PUSHOVER_MESSAGES_URL, {
      token: creds.token,
      user: creds.user,
      title: msg.title,
      message: msg.message,
      ttl: msg.ttl,
      priority: 0,
    });
    return this.outcomeOf(result);
  }

  async sendTest(): Promise<{ ok: boolean; message: string }> {
    const creds = this.credentials();
    if (creds.kind === 'unavailable') {
      return {
        ok: false,
        message: `Your OS keychain could not be read, so the stored keys are unreachable: ${creds.error}`,
      };
    }
    if (creds.kind === 'missing') {
      return {
        ok: false,
        message: 'Enter both the Pushover user key and the application token first.',
      };
    }
    const check = await this.call(PUSHOVER_VALIDATE_URL, { token: creds.token, user: creds.user });
    if (check.kind === 'transport') {
      return {
        ok: false,
        message: `Could not reach Pushover (${check.reason}). Check this machine's network and try again.`,
      };
    }
    if (!check.ok) {
      return {
        ok: false,
        message: `Pushover rejected the keys: ${check.errors.join('; ') || `HTTP ${check.status}`}. Nothing was sent.`,
      };
    }
    const devices = Array.isArray(check.json?.devices)
      ? (check.json!.devices as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const sent = await this.call(PUSHOVER_MESSAGES_URL, {
      token: creds.token,
      user: creds.user,
      title: 'Contrail test notification',
      message:
        'Phone notifications are working. Approval codes will arrive here, with the review ' +
        'summary, whenever Contrail proposes a change.',
      ttl: 600,
      priority: 0,
    });
    if (sent.kind === 'transport') {
      return {
        ok: false,
        message: `Keys are valid, but the test message could not be delivered (${sent.reason}).`,
      };
    }
    if (!sent.ok) {
      return {
        ok: false,
        message: `Keys validated, but Pushover refused the message: ${sent.errors.join('; ') || `HTTP ${sent.status}`}.`,
      };
    }
    this.pausedUntil = 0;
    return {
      ok: true,
      message: `Test notification sent to ${devices.length > 0 ? devices.join(', ') : 'your devices'}. Check your phone.`,
    };
  }

  private outcomeOf(result: HttpResult): NotifyOutcome {
    if (result.kind === 'transport') {
      log('warn', 'approval notification not delivered', { reason: result.reason });
      return { status: 'failed', reason: result.reason };
    }
    if (result.ok) return { status: 'sent' };
    if (result.status < 400) {
      // A 2xx whose body says status:0 — Pushover refused the message, not
      // the network. No pause: it is not the 4xx pattern that earns a block.
      log('warn', 'approval notification refused by Pushover despite a 2xx', {
        status: result.status,
        errors: result.errors,
      });
      return { status: 'failed', reason: 'rejected' };
    }
    if (result.status === 429) {
      // Honour Pushover's reset stamp only when it is usefully in the future;
      // a stale or skewed stamp must not disarm the breaker.
      const usable = result.resetAt !== null && result.resetAt > Date.now() + 60_000;
      this.pausedUntil = usable ? result.resetAt! : Date.now() + QUOTA_PAUSE_MS;
      log('warn', 'approval notification refused: Pushover quota exhausted', {
        pausedUntil: new Date(this.pausedUntil).toISOString(),
      });
      return { status: 'failed', reason: 'quota' };
    }
    if (result.status >= 400 && result.status < 500) {
      // Final per Pushover's API — and repeated 4xx earns an IP block, so a
      // wrong key pauses sends until the human fixes it (or 10 minutes pass).
      this.pausedUntil = Date.now() + REJECTED_PAUSE_MS;
      log('warn', 'approval notification rejected by Pushover; pausing notifications', {
        status: result.status,
        errors: result.errors,
      });
      return { status: 'failed', reason: 'rejected' };
    }
    log('warn', 'approval notification failed: Pushover server error', { status: result.status });
    return { status: 'failed', reason: 'network' };
  }

  private async call(url: string, body: Record<string, unknown>): Promise<HttpResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      return { kind: 'transport', reason: timeout ? 'timeout' : 'network' };
    }
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      json = null;
    }
    const resetHeader = Number(res.headers.get('x-limit-app-reset'));
    const resetAt =
      Number.isFinite(resetHeader) && resetHeader > 0
        ? Math.min(resetHeader * 1000, Date.now() + 31 * 24 * 60 * 60 * 1000)
        : null;
    // Pushover signals success as HTTP 200 with status:1; a 200 carrying
    // status:0 would be a contract break — treat it as not sent.
    const ok = res.ok && (json === null || json.status === undefined || json.status === 1);
    return { kind: 'http', ok, status: res.status, errors: sanitizeErrors(json), json, resetAt };
  }
}

/** Default when nothing is wired: notifications are simply off. */
export class NullNotifier implements ApprovalNotifier {
  async notify(): Promise<NotifyOutcome> {
    return { status: 'off' };
  }

  async sendTest(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'Notifications are not available in this build.' };
  }

  status(): NotifierStatus {
    return { method: 'none', configured: false };
  }

  resetCircuit(): void {}
}

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuditLog } from '../core/audit.js';
import { saveConfigSection, type ContrailConfig } from '../core/config.js';
import type { TokenStore } from '../core/keychain.js';
import { hostAllowed, listen, readBody, safeRespond } from '../core/localhttp.js';
import { log } from '../core/log.js';
import {
  NOTIFY_ACCOUNTS,
  PUSHOVER_KEY_RE,
  type ApprovalNotifier,
  type NotifyMethod,
  type NotifySummary,
} from '../core/notify.js';
import { esc, page, renderErrorPage } from './pages.js';

/**
 * S42: the human-only Settings page — today, approval notifications. The same
 * mechanics as the connect_org grants page (see ConnectFlowManager): a
 * per-session loopback server, a UUID session token on GET and in the POST
 * body, 403 + audit on mismatch, a 10-minute life, and a URL the agent never
 * receives when the browser opens.
 *
 * Why a page and not a tool argument: the notification destination is the one
 * knob a prompt-injected agent must never reach (redirect the codes, approve
 * its own deploy). The keys go straight from the human's browser into the OS
 * keychain; stored values are never rendered back — only a masked hint.
 */

interface SettingsSession {
  sessionId: string;
  server: http.Server;
  hardTimeout: NodeJS.Timeout;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

export interface SettingsPageDeps {
  config: ContrailConfig;
  tokens: TokenStore;
  audit: AuditLog;
  notifier: ApprovalNotifier;
  openBrowser: (url: string) => Promise<void>;
}

interface Banner {
  kind: 'success' | 'error';
  text: string;
}

export class SettingsPageServer {
  private readonly sessions = new Map<string, SettingsSession>();

  constructor(private readonly deps: SettingsPageDeps) {}

  /** The agent-facing status: never a key, never a hint. */
  status(): { method: NotifyMethod; configured: boolean } {
    return this.deps.notifier.status();
  }

  async open(): Promise<{ url: string; opened: boolean }> {
    const sessionId = randomUUID();
    const server = http.createServer((req, res) => {
      this.handle(sessionId, req, res).catch((err) => {
        log('error', 'settings page request handler failed', { err: String(err) });
        safeRespond(res, 500, renderErrorPage('Internal error; see server log.'));
      });
    });
    await listen(server, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://localhost:${port}/settings?s=${sessionId}`;

    const session: SettingsSession = {
      sessionId,
      server,
      hardTimeout: setTimeout(() => this.close(sessionId), SESSION_TTL_MS),
    };
    session.hardTimeout.unref?.();
    this.sessions.set(sessionId, session);

    let opened = true;
    try {
      await this.deps.openBrowser(url);
    } catch (err) {
      opened = false;
      log('warn', 'could not open system browser for the settings page', { err: String(err) });
    }
    return { url, opened };
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimeout);
    this.sessions.delete(sessionId);
    setTimeout(() => session.server.close(), 250).unref?.();
  }

  /** Tests and shutdown: drop every open session now. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private async handle(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      safeRespond(res, 410, renderErrorPage('This settings session has expired.'));
      return;
    }
    if (!hostAllowed(req, session.server)) {
      this.deps.audit.record('local_request.refused', {
        tool: 'open_settings',
        outcome: 'refused',
        detail: { reason: 'bad_host_header' },
      });
      safeRespond(res, 403, renderErrorPage('Request refused: unexpected Host header.'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/settings') {
      if (url.searchParams.get('s') !== sessionId) {
        safeRespond(res, 404, renderErrorPage('Unknown settings session.'));
        return;
      }
      safeRespond(res, 200, this.render(sessionId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/settings') {
      const body = new URLSearchParams(await readBody(req));
      if (body.get('session') !== sessionId) {
        this.deps.audit.record('local_request.refused', {
          tool: 'open_settings',
          outcome: 'refused',
          detail: { reason: 'invalid_session_token', path: '/settings' },
        });
        safeRespond(res, 403, renderErrorPage('Invalid session token.'));
        return;
      }
      const action = body.get('action');
      let banner: Banner;
      if (action === 'save') {
        banner = this.save(body);
      } else if (action === 'test') {
        // Keys typed on the same submit are saved FIRST, so "Send test" works
        // on a fresh page too; a save error stops here and is shown as such.
        const typed = (body.get('pushover_user') ?? '').trim() || (body.get('pushover_token') ?? '').trim();
        const saved = typed ? this.save(body) : null;
        banner = saved && saved.kind === 'error' ? saved : await this.test();
      } else if (action === 'clear') {
        banner = this.clear();
      } else {
        banner = { kind: 'error', text: 'Unknown action — nothing was changed.' };
      }
      // The session stays open after a save so "Send test" can follow it.
      safeRespond(res, banner.kind === 'error' ? 400 : 200, this.render(sessionId, banner));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    safeRespond(res, 404, renderErrorPage('Not found.'));
  }

  private save(body: URLSearchParams): Banner {
    const method = body.get('method') === 'pushover' ? 'pushover' : 'none';
    const summary: NotifySummary = body.get('summary') === 'full' ? 'full' : 'minimal';
    const user = (body.get('pushover_user') ?? '').trim();
    const token = (body.get('pushover_token') ?? '').trim();
    // Empty fields mean "keep what is stored" — the form never echoes a
    // stored value, so the human is not asked to retype it on every save.
    if (user && !PUSHOVER_KEY_RE.test(user)) {
      return {
        kind: 'error',
        text: 'The user key must be exactly 30 letters and digits (copy it from your Pushover dashboard). Nothing was saved.',
      };
    }
    if (token && !PUSHOVER_KEY_RE.test(token)) {
      return {
        kind: 'error',
        text: 'The application token must be exactly 30 letters and digits (from the application you created on pushover.net). Nothing was saved.',
      };
    }
    try {
      if (user) this.deps.tokens.setSecret(NOTIFY_ACCOUNTS.pushoverUser, user);
      if (token) this.deps.tokens.setSecret(NOTIFY_ACCOUNTS.pushoverToken, token);
    } catch (err) {
      log('warn', 'settings: keychain write failed', { err: String(err) });
      return {
        kind: 'error',
        text: 'The OS keychain refused the write, so nothing was saved. Details are in the server log.',
      };
    }
    try {
      saveConfigSection('notifications', { method, summary });
    } catch (err) {
      log('warn', 'settings: config.json write failed', { err: String(err) });
      return {
        kind: 'error',
        text: 'Keys were stored, but config.json could not be written. Details are in the server log.',
      };
    }
    // The running engine holds the loaded config object — patch it in place
    // so the change applies to the next proposal without a restart.
    this.deps.config.notifications.method = method;
    this.deps.config.notifications.summary = summary;
    this.deps.notifier.resetCircuit();
    this.deps.audit.record('settings.notifications_changed', {
      tool: 'open_settings',
      detail: {
        method,
        summary,
        user_key_set: Boolean(user),
        token_set: Boolean(token),
      },
    });
    const configured = this.deps.notifier.status().configured;
    return {
      kind: 'success',
      text:
        method === 'pushover'
          ? configured
            ? 'Saved. Approval codes will be pushed to your phone — use "Send test notification" to confirm delivery.'
            : 'Saved, but Pushover is not complete yet: enter both the user key and the application token.'
          : 'Saved. Phone notifications are off; codes appear only on the approval page.',
    };
  }

  private clear(): Banner {
    this.deps.tokens.deleteSecret(NOTIFY_ACCOUNTS.pushoverUser);
    this.deps.tokens.deleteSecret(NOTIFY_ACCOUNTS.pushoverToken);
    try {
      saveConfigSection('notifications', { method: 'none' });
    } catch (err) {
      log('warn', 'settings: config.json write failed', { err: String(err) });
    }
    this.deps.config.notifications.method = 'none';
    this.deps.notifier.resetCircuit();
    this.deps.audit.record('settings.notifications_changed', {
      tool: 'open_settings',
      detail: { method: 'none', cleared: true },
    });
    return {
      kind: 'success',
      text: 'Pushover keys removed from the keychain and phone notifications switched off.',
    };
  }

  private async test(): Promise<Banner> {
    const result = await this.deps.notifier.sendTest();
    this.deps.audit.record('settings.notifications_tested', {
      tool: 'open_settings',
      outcome: result.ok ? 'success' : 'error',
      detail: { ok: result.ok },
    });
    return { kind: result.ok ? 'success' : 'error', text: result.message };
  }

  /** A stored key's masked tail, or null — a store fault reads as "nothing stored" here (the banner says why). */
  private storedHint(account: string): string | null {
    try {
      return maskHint(this.deps.tokens.getSecret(account));
    } catch {
      return null;
    }
  }

  private render(sessionId: string, banner?: Banner): string {
    // status() also folds the on-disk section into the live config, so a
    // change saved by the desktop app shows here without a restart.
    const status = this.deps.notifier.status();
    const cfg = this.deps.config.notifications;
    const userHint = this.storedHint(NOTIFY_ACCOUNTS.pushoverUser);
    const tokenHint = this.storedHint(NOTIFY_ACCOUNTS.pushoverToken);
    return page(
      'Contrail settings',
      `
    <h1>Settings</h1>
    ${banner ? `<div class="${banner.kind}">${esc(banner.text)}</div>` : ''}
    ${
      status.storeError
        ? `<div class="error">Your OS keychain could not be read, so Contrail cannot tell whether keys are stored: ${esc(status.storeError)}</div>`
        : ''
    }
    <form method="post" action="/settings" class="card">
      <input type="hidden" name="session" value="${esc(sessionId)}">
      <h2>Approval codes on your phone</h2>
      <p class="note" style="margin:0 0 1rem">Every proposed change still shows its confirmation
        code on the approval page in this browser. Switch this on and Contrail ALSO sends the
        review summary and the code to your phone through
        <a href="https://pushover.net" target="_blank" rel="noreferrer">Pushover</a> — one message
        per proposal, so you can approve from anywhere by typing the code into your Contrail
        session. The message deletes itself from your phone when the code expires. Claude never
        sees the code or these keys. (The Contrail desktop app shares these keys.)</p>
      <div class="field">
        <label for="method">Delivery</label>
        <select id="method" name="method">
          <option value="none"${cfg.method === 'none' ? ' selected' : ''}>Off — approval page only</option>
          <option value="pushover"${cfg.method === 'pushover' ? ' selected' : ''}>Pushover (phone push)</option>
        </select>
      </div>
      <div class="field">
        <label for="summary">What the message carries</label>
        <select id="summary" name="summary">
          <option value="minimal"${cfg.summary === 'minimal' ? ' selected' : ''}>Minimal — your connection alias, org type, counts and the code (no component names leave this machine)</option>
          <option value="full"${cfg.summary === 'full' ? ' selected' : ''}>Full — also component names and warnings, never record field values (they travel through Pushover's servers)</option>
        </select>
      </div>
      <div class="field">
        <label for="pushover_user">Pushover user key</label>
        <input type="password" id="pushover_user" name="pushover_user" autocomplete="off"
               placeholder="${userHint ? 'leave blank to keep the stored key' : '30 characters, from your Pushover dashboard'}">
        <div class="hint">${userHint ? `Stored in your OS keychain (${esc(userHint)}).` : 'Shown on pushover.net after you log in.'} This must be YOUR key: whoever owns the user key entered here receives your approval codes. Never paste a user key that Claude, a document, or a colleague gave you.</div>
      </div>
      <div class="field">
        <label for="pushover_token">Application token</label>
        <input type="password" id="pushover_token" name="pushover_token" autocomplete="off"
               placeholder="${tokenHint ? 'leave blank to keep the stored token' : '30 characters, from the application you created'}">
        <div class="hint">${tokenHint ? `Stored in your OS keychain (${esc(tokenHint)}).` : 'On pushover.net choose "Create an Application/API Token" (name it Contrail) — or use the token your team shares (the token may be shared; the user key never).'}</div>
      </div>
      <div class="warn">Keys are written to your OS keychain only — never to config.json, never to
        chat. If Pushover rejects the stored keys, sends pause for 10 minutes; saving here clears
        the pause.</div>
      <div class="actions">
        <button type="submit" name="action" value="save">Save</button>
        <button type="submit" name="action" value="test" class="secondary">Send test notification</button>
        <button type="submit" name="action" value="clear" class="secondary">Remove keys</button>
      </div>
      <p class="note">"Send test notification" saves any keys typed above first, validates them with
        Pushover, then sends one test message. This page expires after 10 minutes (ask Claude to
        open Contrail settings again for a fresh one). Close the tab when you are done.</p>
    </form>`,
    );
  }
}

/** Never the value: only enough of the tail to recognise which key is stored. */
function maskHint(value: string | null): string | null {
  if (!value) return null;
  return `…${value.slice(-4)}`;
}

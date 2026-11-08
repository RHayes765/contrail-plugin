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
  type NotifierStatus,
  type NotifySummary,
  type NotifyWhen,
} from '../core/notify.js';
import type { RcStatus, RemoteControlProbe } from '../core/remoteControl.js';
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
 *
 * S43 adds the "when" choice (push only while Remote Control is on, or
 * always) and the Remote Control hook block: a button that installs the
 * PreToolUse hook into Claude Code's user settings.json (see
 * core/remoteControl.ts) — a write to a file outside Contrail's own data dir,
 * which is why it is a human's click on this page and nothing an agent can
 * reach.
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
  /** S43: Remote Control state + the user-hook installer. */
  remoteControl: RemoteControlProbe;
  openBrowser: (url: string) => Promise<void>;
}

/** The agent-facing status: never a key, never a hint, never a path. */
export type SettingsStatus = NotifierStatus & { remote_control: RcStatus };

interface Banner {
  kind: 'success' | 'error';
  text: string;
}

export class SettingsPageServer {
  private readonly sessions = new Map<string, SettingsSession>();

  constructor(private readonly deps: SettingsPageDeps) {}

  status(): SettingsStatus {
    return { ...this.deps.notifier.status(), remote_control: this.deps.remoteControl.status() };
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
      } else if (action === 'install_hook' || action === 'remove_hook') {
        // The hook buttons sit in the same form as the keys and selects:
        // anything typed or changed above is saved FIRST (the "Send test"
        // precedent), and a save error stops here — nothing is silently dropped.
        const saved = this.saveIfDirty(body);
        if (saved && saved.kind === 'error') {
          banner = saved;
        } else {
          const hook = action === 'install_hook' ? this.installHook() : this.removeHook();
          banner = saved ? { kind: hook.kind, text: `${saved.text} ${hook.text}` } : hook;
        }
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
    const when: NotifyWhen = body.get('when') === 'always' ? 'always' : 'remote_control';
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
      saveConfigSection('notifications', { method, summary, when });
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
    this.deps.config.notifications.when = when;
    this.deps.notifier.resetCircuit();
    this.deps.audit.record('settings.notifications_changed', {
      tool: 'open_settings',
      detail: {
        method,
        summary,
        when,
        user_key_set: Boolean(user),
        token_set: Boolean(token),
      },
    });
    const configured = this.deps.notifier.status().configured;
    const hook = this.deps.remoteControl.hookState();
    const whenNote =
      when === 'remote_control'
        ? hook === 'installed'
          ? ' Codes are pushed only while your Claude Code session has Remote Control on.'
          : ' Codes are pushed only while your Claude Code session has Remote Control on — install ' +
            'the hook below so Contrail can tell (skip this if you installed Contrail as a Claude ' +
            'Code plugin, which ships it). Until a hook reports, every proposal says the push was ' +
            'skipped.'
        : ' Every approval is pushed, whether or not you can act on it from your phone.';
    return {
      kind: 'success',
      text:
        method === 'pushover'
          ? configured
            ? `Saved. Use "Send test notification" to confirm delivery.${whenNote}`
            : 'Saved, but Pushover is not complete yet: enter both the user key and the application token.'
          : 'Saved. Phone notifications are off; codes appear only on the approval page.',
    };
  }

  /** Save when the form carries typed keys or a select that differs from the live config; null when there is nothing to save. */
  private saveIfDirty(body: URLSearchParams): Banner | null {
    const typed = (body.get('pushover_user') ?? '').trim() || (body.get('pushover_token') ?? '').trim();
    const cfg = this.deps.config.notifications;
    const method = body.get('method') === 'pushover' ? 'pushover' : 'none';
    const summary = body.get('summary') === 'full' ? 'full' : 'minimal';
    const when = body.get('when') === 'always' ? 'always' : 'remote_control';
    const differs = method !== cfg.method || summary !== cfg.summary || when !== cfg.when;
    return typed || differs ? this.save(body) : null;
  }

  private installHook(): Banner {
    try {
      const { changed, file, backup } = this.deps.remoteControl.installUserHook();
      this.deps.audit.record('settings.remote_control_hook', {
        tool: 'open_settings',
        detail: { action: 'install', changed },
      });
      return {
        kind: 'success',
        text: changed
          ? `Hook installed in ${file}` +
            (backup
              ? ` (the file as it was before Contrail touched it is kept at ${backup}).`
              : ' (the file did not exist and was created).') +
            ' Claude Code watches its settings files, so running sessions pick it up within ' +
            'moments; the next proposal reports whether Remote Control is on. If a proposal ' +
            'still says no hook reported, start a new Claude Code session.'
          : `The hook is already installed in ${file}. Nothing changed.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'settings: hook install failed', { err: message });
      this.deps.audit.record('settings.remote_control_hook', {
        tool: 'open_settings',
        outcome: 'error',
        detail: { action: 'install', changed: false },
      });
      return { kind: 'error', text: `Could not install the hook: ${message}` };
    }
  }

  private removeHook(): Banner {
    try {
      const { changed, file } = this.deps.remoteControl.removeUserHook();
      this.deps.audit.record('settings.remote_control_hook', {
        tool: 'open_settings',
        detail: { action: 'remove', changed },
      });
      return {
        kind: 'success',
        text: changed
          ? `Hook removed from ${file}. With "Only while Remote Control is on" still selected, ` +
            'nothing is pushed from the next proposal on (where Contrail cannot pair a call with ' +
            'its report, a same-tool report may stand in for up to 30 minutes) — choose "Always" ' +
            'to push every approval. If Contrail runs as a Claude Code plugin, its bundled hook ' +
            'keeps reporting.'
          : `No Contrail hook was present in ${file}. Nothing changed.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'settings: hook removal failed', { err: message });
      this.deps.audit.record('settings.remote_control_hook', {
        tool: 'open_settings',
        outcome: 'error',
        detail: { action: 'remove', changed: false },
      });
      return { kind: 'error', text: `Could not remove the hook: ${message}` };
    }
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
    const rc = this.deps.remoteControl.status();
    const hookLine =
      rc.user_hook === 'installed'
        ? "installed in Claude Code's user settings"
        : rc.user_hook === 'unreadable'
          ? "Claude Code's settings file is not valid JSON — fix it before installing"
          : 'not installed (unless Contrail runs as a Claude Code plugin, which ships its own)';
    const lastReport = rc.at
      ? `Remote Control ${rc.state === 'unknown' ? 'state older than 30 minutes' : rc.state.toUpperCase()} at ${new Date(rc.at).toLocaleString()}`
      : 'none yet — no Contrail tool call has reported';
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
        per pushed proposal, so you can approve from anywhere by typing the code into your Contrail
        session (the code is the last line of the message, on its own, for easy copying). The
        message deletes itself from your phone when the code expires. Claude never sees the code
        or these keys. (The Contrail desktop app shares these keys.)</p>
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
        <label for="when">When to send</label>
        <select id="when" name="when">
          <option value="remote_control"${cfg.when === 'remote_control' ? ' selected' : ''}>Only while Remote Control is on — push the code only when you could type it from your phone (Claude Code sessions; needs the hook below)</option>
          <option value="always"${cfg.when === 'always' ? ' selected' : ''}>Always — every approval, whether or not you can act on it from your phone</option>
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
      <h2 style="margin-top:1.5rem">Remote Control hook</h2>
      <p class="note" style="margin:0 0 .5rem">"Only while Remote Control is on" works through a
        tiny hook that Claude Code runs right before a Contrail tool mints a code. It records a
        yes/no, a timestamp, the Contrail tool's name and Claude Code's id for that call under
        Contrail's data directory — never your session link, never the tool's arguments — and
        never blocks a tool call. It reads Claude Code's own signals (the Remote Control variable
        Claude Code ≥ 2.1.199 gives hooks, or the session record the Claude Desktop app keeps); on a
        version that exposes neither it always reports off (upgrade, or choose "Always").
        Hook: <strong>${esc(hookLine)}</strong>.
        Last report: <strong>${esc(lastReport)}</strong>.</p>
      <div class="actions">
        <button type="submit" name="action" value="install_hook" class="secondary">Install hook into Claude Code</button>
        <button type="submit" name="action" value="remove_hook" class="secondary">Remove hook</button>
      </div>
      <p class="note">"Install" adds one PreToolUse entry — the hook's few lines of script inline,
        nothing executable on disk — to <code>${esc(this.deps.remoteControl.claudeSettingsFile)}</code>
        (everything else in the file is preserved; if the file already existed, a copy of it as it
        was before Contrail touched it is kept beside it). Settings typed above are saved with
        the same click. Claude Code watches its settings files, so running sessions
        pick it up within moments. If Claude Code on this machine reads a different settings file
        (its own CLAUDE_CONFIG_DIR), it will not see this entry and "Last report" above stays
        empty — set the same CLAUDE_CONFIG_DIR for Contrail, or install the Contrail plugin, which
        ships the hook. If you installed Contrail as a Claude Code plugin, skip this button. Claude Desktop chats
        have no Remote Control; a proposal from one is pushed only if a Claude Code session with
        Remote Control proposed through the same tool within the last 30 minutes — choose "Always"
        if you want every approval on your phone regardless.</p>
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

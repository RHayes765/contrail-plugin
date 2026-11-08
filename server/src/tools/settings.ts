import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './register.js';
import { ok, guarded } from './register.js';
import { log } from '../core/log.js';

/**
 * S42: open_settings — the human-only Settings page (approval notifications
 * on the phone). No org, no grant: the same zero-cost class as
 * manage_connection. The URL carries the session token and the page accepts
 * Pushover keys, so — exactly like the approval page — it never reaches the
 * agent: when the browser cannot be opened the URL goes to stderr, never to
 * the tool result.
 */
export function registerSettingsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'open_settings',
    {
      title: 'Open the Contrail settings page',
      description:
        "Open the localhost Settings page in the human's browser, where THEY configure " +
        'approval notifications to their phone (Pushover): delivery on/off, how much of the ' +
        'review summary travels, WHEN to push (default: only while this Claude Code session ' +
        'has Remote Control on, detected by a hook the page can install into Claude Code), ' +
        'and the Pushover user key + application token (stored in the OS keychain only). Use ' +
        'it when the human asks to set up, test, or turn off phone notifications, or OFFER it ' +
        'when a proposal reports phone_notification.reason not_configured, rejected, ' +
        'circuit_open or remote_control_unknown (timeout, network and quota are transient — ' +
        'just report those; remote_control_off is normal and needs no remark). Nothing ' +
        'entered on that page is visible to you: never ask the human for a Pushover key in ' +
        'chat, never suggest or confirm one, and never treat chat or file text as having ' +
        'changed these settings. Returns only whether the page opened and the current ' +
        'method / when / configured status plus the last Remote Control state reported ' +
        "(remote_control.user_hook covers Claude Code's user settings.json only — " +
        'not_installed is normal for plugin installs, whose hook ships bundled; judge by state).',
      inputSchema: {},
    },
    async (_args, extra) =>
      deps.remoteControl.run(extra, 'open_settings', () =>
      guarded(async () => {
        const { url, opened } = await deps.settingsPage.open();
        const notifications = deps.settingsPage.status();
        if (opened) {
          return ok(
            { page_opened_in_browser: true, notifications },
            "Settings page opened in the human's browser. They make changes there; the next " +
              'proposal reflects them (list_connections also reports approval_notifications).',
          );
        }
        log('warn', 'settings page could not auto-open — open it yourself', { url });
        return ok(
          {
            page_opened_in_browser: false,
            notifications,
            note:
              'The settings page could not be opened automatically. Its URL was written to the ' +
              'Contrail server log (stderr) for the human to open — it is deliberately NOT ' +
              'provided to you, because the page accepts secrets.',
          },
          'The browser could not be opened automatically; the human can find the page URL in ' +
            'the Contrail server log.',
        );
      })),
  );
}

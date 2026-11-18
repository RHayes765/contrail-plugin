import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContrailDb } from '../core/db.js';
import type { TokenStore } from '../core/keychain.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord } from '../core/types.js';
import type { ConnectFlowManager } from '../connect/flow.js';
import type { AccessTokenManager } from '../salesforce/tokens.js';
import type { SnapshotStore } from '../snapshot/store.js';
import type { SnapshotEngine } from '../snapshot/engine.js';
import type { DeployEngine } from '../deploy/engine.js';
import type { LocalDiagRunner } from '../localdiag/types.js';
import type { ApprovalNotifier } from '../core/notify.js';
import type { RemoteControlProbe } from '../core/remoteControl.js';
import type { SettingsPageServer } from '../connect/settings.js';
import type { SkillPack } from '../skillpack/pack.js';
import { skillsAnnouncement } from '../skillpack/instructions.js';
import { ContrailError } from '../core/errors.js';
import { grantedList, notGrantedList } from '../core/grants.js';
import { getUpdateNotice } from '../core/updateCheck.js';
import { stagingDir } from '../core/paths.js';
import { ENGINE_VERSION } from '../core/version.js';
import { log } from '../core/log.js';

/** Release feed for the in-band update notice. */
const UPDATE_REPO = 'RHayes765/contrail-plugin';

export interface ToolDeps {
  db: ContrailDb;
  tokens: TokenStore;
  audit: AuditLog;
  config: ContrailConfig;
  flows: ConnectFlowManager;
  tokenMgr: AccessTokenManager;
  store: SnapshotStore;
  engine: SnapshotEngine;
  deploys: DeployEngine;
  localDiag: LocalDiagRunner;
  /** S42: phone delivery of approval codes (shared with the engine so the circuit state is one). */
  notifier: ApprovalNotifier;
  /** S43: Remote Control state sampled per tool call (the phone push gate) + the user-hook installer. */
  remoteControl: RemoteControlProbe;
  /** S42: the human-only Settings page server behind open_settings. */
  settingsPage: SettingsPageServer;
  /** S46: the skill pack that ships inside this install, and the MCP server instructions built from it (once, at startup). */
  skills: { pack: SkillPack; instructions: string };
  /** S46: asks this computer to open a file or URL in its default app (tests record the call through flowOps.openBrowser). */
  openExternal: (target: string) => Promise<void>;
}

const PERMISSION_NOTES = [
  'Every metadata deploy and every DML write requires explicit human approval via a confirmation code — in every environment, without exception.',
  'Grants are set by a human on the localhost management page only (manage_connection); they can never be changed through the agent or tool arguments.',
] as const;

/** Public, token-free view of a connection. */
function connectionSummary(rec: ConnectionRecord) {
  return {
    alias: rec.alias,
    id: rec.id,
    org_id: rec.orgId,
    org_name: rec.orgName,
    org_type: rec.orgType,
    is_sandbox: rec.isSandbox,
    instance_url: rec.instanceUrl,
    username: rec.username,
    grants: rec.grants,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    last_used_at: rec.lastUsedAt,
  };
}

function permissionsView(rec: ConnectionRecord) {
  return {
    connection: rec.alias,
    org_type: rec.orgType,
    granted: grantedList(rec.grants),
    not_granted: notGrantedList(rec.grants),
  };
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function ok(payload: unknown, prefix?: string): ToolResult {
  const json = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text: prefix ? `${prefix}\n${json}` : json }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function guarded(handler: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  return Promise.resolve()
    .then(handler)
    .catch((err) => {
      if (err instanceof ContrailError) return fail(err.message);
      log('error', 'tool handler failed', { err: String(err) });
      return fail(`Unexpected engine error: ${String(err)}`);
    });
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { db, audit, flows } = deps;

  server.registerTool(
    'connect_org',
    {
      title: 'Connect a Salesforce org',
      description:
        'Start the browser OAuth flow to connect a Salesforce org. The human logs in as ' +
        'themselves and sets the five capability grants on a local completion page — grants ' +
        'can never be chosen here. Re-running with an existing connection label re-authorizes ' +
        'that connection (the recovery path after a sandbox refresh).',
      inputSchema: {
        login: z
          .string()
          .optional()
          .describe(
            'Which Salesforce login endpoint to open. Pass this explicitly — it defaults to ' +
              '"production" (login.salesforce.com), and sandbox credentials do NOT work there, ' +
              'so guessing wrong wastes the human\'s login attempt. Use "sandbox" for any ' +
              'sandbox (UAT/QA/staging/full copy) to open test.salesforce.com; "production" for ' +
              'production, developer edition, scratch, and trial orgs; or a My Domain host such ' +
              'as acme--uat.sandbox.my.salesforce.com when the user names one (preferred — ' +
              'unambiguous). Ignored in favor of the stored login host when re-authorizing an ' +
              'existing label.',
          ),
        label: z
          .string()
          .optional()
          .describe(
            'Suggested connection label. If it matches an existing connection, the flow ' +
              're-authorizes that connection. The human can change the label on the page.',
          ),
      },
    },
    async (args: { login?: string; label?: string }) =>
      guarded(async () => {
        const outcome = await flows.connectOrg({ login: args.login, label: args.label });
        switch (outcome.status) {
          case 'connected':
            return ok(
              connectionSummary(outcome.connection),
              `Connected. The human saved this connection with the grants below.`,
            );
          case 'pending':
            return ok({ authorize_url: outcome.authorizeUrl }, outcome.message);
          case 'timeout':
          case 'superseded':
          case 'error':
            return fail(outcome.message);
        }
      }),
  );

  server.registerTool(
    'disconnect_org',
    {
      title: 'Disconnect a Salesforce org',
      description:
        'Revoke the stored refresh token and remove a connection. Confirm with the human ' +
        'before calling this — it cannot be undone without re-running the OAuth flow.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id) to remove.'),
      },
    },
    async (args: { connection: string }) =>
      guarded(async () => {
        const result = await flows.disconnectOrg(args.connection);
        deps.tokenMgr.invalidate(result.connectionId);
        deps.store.removeConnection(result.connectionId);
        return ok({
          removed: result.alias,
          token_revoked: result.revoked,
          detail: result.detail ?? null,
        });
      }),
  );

  server.registerTool(
    'manage_connection',
    {
      title: 'Open the connection management page',
      description:
        'Open the localhost page where the human can change a connection\'s grants. Grants ' +
        'are only ever set there. The page opens directly in the human\'s browser; its URL ' +
        'is never returned to you — if the browser cannot be opened, the URL goes to ' +
        'Contrail\'s server log for the human. After the human saves, call get_permissions ' +
        'to see the updated grants.',
      inputSchema: {
        connection: z.string().describe('Connection alias (or id) to manage.'),
      },
    },
    async (args: { connection: string }) =>
      guarded(async () => {
        const { url, opened, connection } = await flows.manageConnection(args.connection);
        // The URL carries the session token that authorizes the grants save,
        // so — exactly like the approval and settings pages — it never
        // reaches model context on any path. The human already has the page
        // open, or finds its URL in the server log (stderr).
        if (opened) {
          return ok(
            { connection: connection.alias, page_opened_in_browser: true },
            'Management page opened in the human\'s browser. They set grants there; call ' +
              'get_permissions afterwards to see the result.',
          );
        }
        log(
          'warn',
          'connection management page could not auto-open — open it yourself to change grants',
          { url },
        );
        return ok(
          {
            connection: connection.alias,
            page_opened_in_browser: false,
            note:
              'The management page could not be opened automatically. Its URL was written to the ' +
              'Contrail server log (stderr) for the human to open — it is deliberately NOT ' +
              'provided to you, because the page saves grants. Ask the human to open the page ' +
              'from the Contrail log, and call get_permissions after they save.',
          },
          'The browser could not be opened automatically; the human can find the page URL in ' +
            'the Contrail server log.',
        );
      }),
  );

  server.registerTool(
    'list_connections',
    {
      title: 'List connected orgs',
      description:
        'List every connected org with its alias, org identity, type, and grants. Zero-cost ' +
        'local read — call this instead of guessing which orgs exist. Also returns ' +
        'staging_dir: the directory to author content_file/csv_file sources into, and ' +
        'approval_notifications: whether approval codes are also pushed to the human\'s phone ' +
        '(configured by the human via open_settings; never by you), including when — by ' +
        'default only while this Claude Code session has Remote Control connected — and the ' +
        'last Remote Control state Contrail\'s hook reported (remote_control.user_hook covers ' +
        "Claude Code's user settings.json only: not_installed is normal for plugin installs, " +
        'whose hook ships bundled — judge by state). ' +
        'Also reports, per connection, policy: the rules that apply to it — from the ' +
        "human's config.json, or Contrail's built-in default when that file has no policies " +
        'section (policies_status.source says which) — whether a justification or ticket is ' +
        'required (and the ticket pattern), what is denied, the minimum test_level, its ' +
        'freeze windows and whether one is in effect right now — so a proposal can comply ' +
        'the first time; policies_status.unmatched_rules names rules whose label or org id ' +
        'matches no connection on this machine — tell the human, a re-created connection may ' +
        'have left a rule behind; policies_status also says whether the rules could be read, ' +
        'and when they could not, every write proposal is refused until the human fixes the ' +
        'file. Also returns skills: how many skills this install bundles and the read_skill ' +
        'call that loads the house rules.',
      inputSchema: {},
    },
    async (_args, extra) =>
      deps.remoteControl.run(extra, 'list_connections', () =>
      guarded(() => {
        // S46 (B): each connection carries the policy that applies to it now
        // (null when the policies cannot be read — policies_status says why),
        // all from ONE read of the policies over ONE listing of connections.
        const conns = db.listConnections();
        const policy = deps.deploys.policyListing(conns);
        const list = conns.map((rec, i) => ({
          ...connectionSummary(rec),
          policy: policy.reports[i] ?? null,
        }));
        // Cached-only read (never the network): when a newer release exists,
        // say so on the session-start tool so the human hears about it.
        const update = getUpdateNotice(
          ENGINE_VERSION,
          UPDATE_REPO,
          deps.config.updates.checkEnabled,
        );
        return ok({
          connections: list,
          count: list.length,
          // The session-start surface names the staging dir PROACTIVELY, so an
          // agent authoring a large component learns where deploy bytes live
          // before its first validate_deploy refusal, not from it.
          staging_dir: stagingDir(),
          // S42: status only — method and whether both keys exist. Never the
          // keys, never a hint of them. S43: plus when pushes go out and the
          // last Remote Control state the hook reported (this call's, when the
          // hook fired for it).
          approval_notifications: {
            ...deps.notifier.status(),
            remote_control: deps.remoteControl.status(),
          },
          // S46 (B): whether the policies could be read, where they came
          // from, and any rule that matches no connection on this machine.
          policies_status: policy.status,
          // S46: the second announcement of the skill pack. It is not verified
          // that every client shows MCP server instructions to the model, so
          // the session-start tool repeats the pointer.
          skills: skillsAnnouncement(deps.skills.pack),
          ...(update
            ? {
                update_available: update,
                update_note:
                  `Contrail ${update.latest} is available (you are on ${update.installed}). ` +
                  `Tell the human: download it at ${update.download_url} — a Claude Desktop ` +
                  `extension updates by installing the new .mcpb over the old one.`,
              }
            : {}),
        });
      }),
      ),
  );

  server.registerTool(
    'get_permissions',
    {
      title: 'Get the grants matrix',
      description:
        'Full permission matrix for one or all connections, including what is NOT granted, ' +
        'so capabilities are never discovered by trial and error. Zero-cost local read.',
      inputSchema: {
        connection: z
          .string()
          .optional()
          .describe('Connection alias (or id). Omit for all connections.'),
      },
    },
    async (args: { connection?: string }) =>
      guarded(() => {
        if (args.connection) {
          const rec = db.resolveConnection(args.connection);
          if (!rec) {
            return fail(
              `No connection matches "${args.connection}". Call list_connections to see what exists.`,
            );
          }
          return ok({ ...permissionsView(rec), notes: PERMISSION_NOTES });
        }
        return ok({
          connections: db.listConnections().map(permissionsView),
          notes: PERMISSION_NOTES,
        });
      }),
  );

  server.registerTool(
    'get_audit_log',
    {
      title: 'Read the local audit log',
      description:
        'Query the local audit log: connection lifecycle, OAuth flows, grant and policy ' +
        'refusals, freeze overrides, and every deploy, data, Apex, bulk and agent-activation ' +
        'decision. Local; export_change_evidence writes a per-request dossier from it.',
      inputSchema: {
        connection: z
          .string()
          .optional()
          .describe('Filter to one connection by alias (or id).'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp; only events at or after this instant.'),
        // S46 (B): the rows that name one request, one event type or family, and an end bound.
        request_id: z
          .string()
          .optional()
          .describe(
            'Only events that name this request id (the request_id a validate or propose result ' +
              'returned) — among them its proposal, phone push, refusals (an execute refused by a ' +
              'policy included), freeze override, justification edits, execution, and the sweep ' +
              'that expired it. Supersession by a newer validation is recorded per connection and ' +
              'is not included; a policy check that passes is recorded on the request, not in the log.',
          ),
        event_type: z
          .string()
          .optional()
          .describe(
            'Only this event type (for example policy.refused), or every type under a prefix ' +
              'ending in a dot (for example policy.).',
          ),
        until: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp; only events at or before this instant.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max events (default 100).'),
      },
    },
    async (args: {
      connection?: string;
      since?: string;
      request_id?: string;
      event_type?: string;
      until?: string;
      limit?: number;
    }) =>
      guarded(() => {
        let connectionId: string | undefined;
        if (args.connection) {
          const rec = db.resolveConnection(args.connection);
          if (!rec) {
            return fail(
              `No connection matches "${args.connection}". Call list_connections to see what exists.`,
            );
          }
          connectionId = rec.id;
        }
        // A request_id that is not a request id, or a malformed event_type, is
        // refused by the query itself — never matched loosely.
        const events = audit.query({
          connectionId,
          since: args.since,
          until: args.until,
          requestId: args.request_id,
          eventType: args.event_type,
          limit: args.limit,
        });
        // Snake_case for model consistency with every other tool's output.
        return ok({
          events: events.map((e) => ({
            id: e.id,
            ts: e.ts,
            event_type: e.eventType,
            connection_id: e.connectionId,
            tool: e.tool,
            outcome: e.outcome,
            detail: e.detail,
          })),
          count: events.length,
        });
      }),
  );
}

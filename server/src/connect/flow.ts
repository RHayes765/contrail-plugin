import http from 'node:http';
import { randomUUID } from 'node:crypto';
import openBrowserDefault from 'open';
import type { ContrailDb } from '../core/db.js';
import type { TokenStore } from '../core/keychain.js';
import type { AuditLog } from '../core/audit.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord, OrgType } from '../core/types.js';
import {
  grantDependencyViolations,
  normalizeGrants,
  emptyGrantSet,
  type GrantSet,
} from '../core/grants.js';
import { ConnectionNotFoundError, FlowInProgressError, OAuthFlowError } from '../core/errors.js';
import { generateState, generateVerifier, challengeFromVerifier } from '../salesforce/pkce.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  resolveLoginBase,
  revokeToken,
  type TokenResponse,
} from '../salesforce/oauth.js';
import {
  classifyOrgType,
  fetchIdentity,
  fetchOrgInfo,
  type IdentityInfo,
  type OrgInfo,
} from '../salesforce/client.js';
import { renderErrorPage, renderGrantsPage, renderSuccessPage } from './pages.js';
import {
  closeServerNow,
  hostAllowed,
  listen,
  readBody,
  redirect,
  safeRespond,
} from '../core/localhttp.js';
import { log } from '../core/log.js';

/** Injectable externals so the whole flow is testable without Salesforce. */
export interface FlowOps {
  exchangeCode: typeof exchangeCode;
  fetchOrgInfo: typeof fetchOrgInfo;
  fetchIdentity: typeof fetchIdentity;
  revokeToken: typeof revokeToken;
  openBrowser: (url: string) => Promise<void>;
}

const defaultOps: FlowOps = {
  exchangeCode,
  fetchOrgInfo,
  fetchIdentity,
  revokeToken,
  openBrowser: async (url) => {
    await openBrowserDefault(url);
  },
};

export type ConnectOutcome =
  | { status: 'connected'; connection: ConnectionRecord }
  | { status: 'pending'; authorizeUrl: string; message: string }
  | { status: 'timeout'; message: string }
  | { status: 'superseded'; message: string }
  | { status: 'error'; message: string };

interface ActiveConnectFlow {
  sessionId: string;
  state: string;
  verifier: string;
  loginBase: string;
  redirectUri: string;
  authorizeUrl: string;
  labelSuggestion: string | null;
  /** Set when re-running the flow on an existing alias (sandbox refresh etc.). */
  reauth: ConnectionRecord | null;
  server: http.Server;
  hardTimeout: NodeJS.Timeout;
  completed: boolean;
  resolve: (outcome: ConnectOutcome) => void;
  outcome: Promise<ConnectOutcome>;
  // populated after the OAuth callback:
  tokens?: TokenResponse;
  orgInfo?: OrgInfo;
  identity?: IdentityInfo;
  orgType?: OrgType;
}

interface ActiveManageSession {
  sessionId: string;
  connectionId: string;
  server: http.Server;
  hardTimeout: NodeJS.Timeout;
}

export class ConnectFlowManager {
  private activeConnect: ActiveConnectFlow | null = null;
  private readonly manageSessions = new Map<string, ActiveManageSession>();

  constructor(
    private readonly db: ContrailDb,
    private readonly tokens: TokenStore,
    private readonly audit: AuditLog,
    private readonly config: ContrailConfig,
    private readonly ops: FlowOps = defaultOps,
  ) {}

  /** Bound port of the active connect flow's callback listener (diagnostics/tests). */
  activeConnectPort(): number | null {
    const addr = this.activeConnect?.server.address();
    return typeof addr === 'object' && addr ? addr.port : null;
  }

  // ── connect_org ────────────────────────────────────────────────────────

  async connectOrg(opts: { login?: string; label?: string }): Promise<ConnectOutcome> {
    // Re-running with an existing alias is a re-auth on that connection
    // (the documented recovery for sandbox refreshes). The stored login host
    // always wins on re-auth — the tool contract promises the login argument
    // is ignored there, and honoring an override would let a habitual
    // login:"production" send a sandbox re-auth to the wrong org.
    const existing = opts.label ? this.db.resolveConnection(opts.label) : null;
    const loginBase = existing ? existing.loginUrl : resolveLoginBase(opts.login);
    if (existing && opts.login && resolveLoginBase(opts.login) !== existing.loginUrl) {
      log('warn', 'login argument ignored on re-auth; the stored login host wins', {
        alias: existing.alias,
        stored: existing.loginUrl,
      });
    }

    if (this.activeConnect) {
      const old = this.activeConnect;
      this.failConnectFlow(old, 'superseded', 'A newer connect_org call replaced this flow.');
      // The old listener holds the fixed callback port; it must be fully
      // closed before the new flow can bind, or listen() fails EADDRINUSE.
      await closeServerNow(old.server);
      this.audit.record('oauth.flow_superseded', { tool: 'connect_org', outcome: 'success' });
    }

    const sessionId = randomUUID();
    const state = generateState();
    const verifier = generateVerifier();
    const port = this.config.oauth.callbackPort;
    const callbackPath = this.config.oauth.callbackPath;
    const redirectUri = `http://localhost:${port}${callbackPath}`;
    const authorizeUrl = buildAuthorizeUrl({
      loginBase,
      clientId: this.config.salesforce.clientId,
      redirectUri,
      challenge: challengeFromVerifier(verifier),
      state,
      scopes: this.config.salesforce.scopes,
    });

    let resolveOutcome!: (o: ConnectOutcome) => void;
    const outcome = new Promise<ConnectOutcome>((res) => {
      resolveOutcome = res;
    });

    const server = http.createServer((req, res) => {
      this.handleConnectRequest(req, res).catch((err) => {
        log('error', 'connect flow request handler failed', { err: String(err) });
        safeRespond(res, 500, renderErrorPage('Internal error; see server log.'));
      });
    });

    const flow: ActiveConnectFlow = {
      sessionId,
      state,
      verifier,
      loginBase,
      redirectUri,
      authorizeUrl,
      labelSuggestion: opts.label ?? null,
      reauth: existing,
      server,
      completed: false,
      resolve: resolveOutcome,
      outcome,
      hardTimeout: setTimeout(() => {
        this.failConnectFlow(
          flow,
          'timeout',
          `The browser flow was not completed within ${Math.round(
            this.config.oauth.flowTimeoutMs / 60000,
          )} minutes.`,
        );
        this.audit.record('oauth.flow_failed', {
          tool: 'connect_org',
          outcome: 'error',
          detail: { reason: 'timeout' },
        });
      }, this.config.oauth.flowTimeoutMs),
    };
    flow.hardTimeout.unref?.();
    this.activeConnect = flow;

    try {
      await listen(server, port);
    } catch (err) {
      clearTimeout(flow.hardTimeout);
      this.activeConnect = null;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        throw new FlowInProgressError(
          `Port ${port} is busy (another OAuth flow — possibly the sf CLI — is using it). ` +
            `Finish or abort that flow and retry, or change oauth.callbackPort in config.json ` +
            `(it must match the connected app's registered callback URL).`,
        );
      }
      throw new OAuthFlowError(`Could not start the local callback listener: ${String(err)}`);
    }

    this.audit.record('oauth.flow_started', {
      tool: 'connect_org',
      outcome: 'success',
      detail: { loginBase, reauth: existing ? existing.alias : null },
    });

    try {
      await this.ops.openBrowser(authorizeUrl);
    } catch (err) {
      log('warn', 'could not open system browser; user must open the URL manually', {
        err: String(err),
      });
    }

    // Wait briefly for fast completions, then hand back a pending result so
    // MCP client timeouts are never hit; the flow keeps running either way.
    const pending: ConnectOutcome = {
      status: 'pending',
      authorizeUrl,
      message:
        'Browser opened for Salesforce login. Ask the user to finish logging in, confirm the ' +
        'org, and set grants on the Contrail page. Then call list_connections to confirm the ' +
        'new connection.',
    };
    const winner = await Promise.race([
      outcome,
      delay(this.config.oauth.toolWaitMs).then(() => pending),
    ]);
    return winner;
  }

  private async handleConnectRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const flow = this.activeConnect;
    if (!flow) {
      safeRespond(res, 410, renderErrorPage('This connection flow is no longer active.'));
      return;
    }
    if (!hostAllowed(req, flow.server)) {
      this.audit.record('local_request.refused', {
        tool: 'connect_org',
        outcome: 'refused',
        detail: { reason: 'bad_host_header' },
      });
      safeRespond(res, 403, renderErrorPage('Request refused: unexpected Host header.'));
      return;
    }
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.oauth.callbackPort}`);

    if (req.method === 'GET' && url.pathname === this.config.oauth.callbackPath) {
      await this.handleOAuthCallback(flow, url, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/setup') {
      if (url.searchParams.get('s') !== flow.sessionId || !flow.tokens || !flow.orgInfo) {
        safeRespond(res, 404, renderErrorPage('Unknown or expired setup session.'));
        return;
      }
      safeRespond(res, 200, this.renderConnectForm(flow));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/setup') {
      await this.handleConnectSave(flow, req, res);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    safeRespond(res, 404, renderErrorPage('Not found.'));
  }

  private async handleOAuthCallback(
    flow: ActiveConnectFlow,
    url: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    // Refreshing the callback URL after a successful exchange lands back on
    // the setup form instead of erroring out.
    if (flow.tokens) {
      redirect(res, `/setup?s=${flow.sessionId}`);
      return;
    }
    // Any request that does not carry this flow's state nonce is refused
    // without touching the flow — a forged localhost hit (e.g. a drive-by
    // <img> tag) must not be able to cancel a login in progress.
    const state = url.searchParams.get('state');
    if (state !== flow.state) {
      log('warn', 'callback request with missing/invalid state refused');
      this.audit.record('oauth.callback_refused', {
        tool: 'connect_org',
        outcome: 'refused',
        detail: { reason: 'state_mismatch' },
      });
      safeRespond(
        res,
        400,
        renderErrorPage('This request did not come from the flow Contrail started. The login in progress is unaffected.'),
      );
      return;
    }
    const errParam = url.searchParams.get('error');
    if (errParam) {
      const desc = url.searchParams.get('error_description') ?? '';
      const message = `Salesforce returned "${errParam}"${desc ? `: ${desc}` : ''}.`;
      safeRespond(res, 400, renderErrorPage(message));
      this.audit.record('oauth.flow_failed', {
        tool: 'connect_org',
        outcome: 'error',
        detail: { reason: errParam },
      });
      this.failConnectFlow(flow, 'error', message);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      safeRespond(res, 400, renderErrorPage('Missing authorization code.'));
      return;
    }
    // The state is single-use: a second hit on the callback is refused.
    flow.state = `used:${randomUUID()}`;

    try {
      const tokens = await this.ops.exchangeCode({
        loginBase: flow.loginBase,
        clientId: this.config.salesforce.clientId,
        redirectUri: flow.redirectUri,
        code,
        verifier: flow.verifier,
      });
      const orgInfo = await this.ops.fetchOrgInfo(
        tokens.instance_url,
        tokens.access_token,
        this.config.salesforce.apiVersion,
      );
      const identity = await this.ops.fetchIdentity(tokens.id, tokens.access_token);
      flow.tokens = tokens;
      flow.orgInfo = orgInfo;
      flow.identity = identity;
      flow.orgType = classifyOrgType(orgInfo);
      redirect(res, `/setup?s=${flow.sessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeRespond(res, 502, renderErrorPage(message));
      this.audit.record('oauth.flow_failed', {
        tool: 'connect_org',
        outcome: 'error',
        detail: { reason: 'token_exchange', message },
      });
      this.failConnectFlow(flow, 'error', message);
    }
  }

  private renderConnectForm(flow: ActiveConnectFlow, error?: string): string {
    const orgInfo = flow.orgInfo!;
    return renderGrantsPage({
      mode: 'connect',
      sessionId: flow.sessionId,
      actionPath: '/setup',
      org: {
        orgName: orgInfo.orgName,
        orgId: orgInfo.orgId,
        orgType: flow.orgType ?? 'unknown',
        instanceUrl: flow.tokens!.instance_url,
        username: flow.identity?.username ?? null,
      },
      label: flow.reauth?.alias ?? flow.labelSuggestion ?? orgInfo.orgName ?? '',
      labelLocked: flow.reauth !== null,
      grants: flow.reauth?.grants ?? emptyGrantSet(),
      error,
    });
  }

  private async handleConnectSave(
    flow: ActiveConnectFlow,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!flow.tokens || !flow.orgInfo) {
      safeRespond(res, 400, renderErrorPage('The OAuth exchange has not completed for this session.'));
      return;
    }
    const body = new URLSearchParams(await readBody(req));
    if (body.get('session') !== flow.sessionId) {
      this.audit.record('local_request.refused', {
        tool: 'connect_org',
        outcome: 'refused',
        detail: { reason: 'invalid_session_token', path: '/setup' },
      });
      safeRespond(res, 403, renderErrorPage('Invalid session token.'));
      return;
    }
    const label = (body.get('label') ?? '').trim();
    const labelError = validateLabel(label);
    if (labelError) {
      safeRespond(res, 400, this.renderConnectForm(flow, labelError));
      return;
    }
    const grants = normalizeGrants(Object.fromEntries(body.entries()));
    const violations = grantDependencyViolations(grants);
    if (violations.length > 0) {
      safeRespond(res, 400, this.renderConnectForm(flow, `Invalid grants: ${violations.join('; ')}.`));
      return;
    }

    const authFields = {
      instanceUrl: flow.tokens.instance_url,
      loginUrl: flow.loginBase,
      orgId: flow.orgInfo.orgId,
      orgName: flow.orgInfo.orgName,
      orgType: flow.orgType ?? 'unknown',
      isSandbox: flow.orgInfo.isSandbox,
      username: flow.identity?.username ?? null,
      userId: flow.identity?.userId ?? null,
      grants,
    } as const;

    let record: ConnectionRecord;
    let eventType: 'connection.created' | 'connection.reauthorized';
    try {
      const collision = this.db.getConnectionByAlias(label);
      const target = flow.reauth ?? collision;
      if (target) {
        // Same alias, different org, and the user was not deliberately
        // re-authing → make them pick a new label instead of silently
        // repointing an existing alias at another org.
        if (!flow.reauth && target.orgId !== flow.orgInfo.orgId) {
          safeRespond(
            res,
            400,
            this.renderConnectForm(
              flow,
              `The label "${label}" already points at a different org (${target.orgId}). Choose another label.`,
            ),
          );
          return;
        }
        this.tokens.setRefreshToken(target.id, flow.tokens.refresh_token!);
        record = this.db.updateConnectionAuth(target.id, authFields);
        eventType = 'connection.reauthorized';
      } else {
        record = this.db.insertConnection({ alias: label, ...authFields });
        try {
          this.tokens.setRefreshToken(record.id, flow.tokens.refresh_token!);
        } catch (err) {
          this.db.deleteConnection(record.id);
          throw err;
        }
        eventType = 'connection.created';
      }
    } catch (err) {
      const message = `Could not save the connection: ${String(err)}`;
      safeRespond(res, 500, renderErrorPage(message));
      this.audit.record('oauth.flow_failed', {
        tool: 'connect_org',
        outcome: 'error',
        detail: { reason: 'persist', message },
      });
      this.failConnectFlow(flow, 'error', message);
      return;
    }

    this.audit.record(eventType, {
      connectionId: record.id,
      tool: 'connect_org',
      outcome: 'success',
      detail: { alias: record.alias, orgId: record.orgId, orgType: record.orgType, grants },
    });
    this.audit.record('oauth.flow_completed', { connectionId: record.id, tool: 'connect_org' });

    safeRespond(res, 200, renderSuccessPage({ mode: 'connect', alias: record.alias, grants }));
    flow.completed = true;
    clearTimeout(flow.hardTimeout);
    flow.resolve({ status: 'connected', connection: record });
    this.activeConnect = null;
    // Let the success response flush before tearing the listener down.
    setTimeout(() => flow.server.close(), 250).unref?.();
  }

  private failConnectFlow(
    flow: ActiveConnectFlow,
    status: 'timeout' | 'superseded' | 'error',
    message: string,
  ): void {
    if (flow.completed) return;
    flow.completed = true;
    clearTimeout(flow.hardTimeout);
    flow.resolve({ status, message } as ConnectOutcome);
    if (this.activeConnect === flow) this.activeConnect = null;
    setTimeout(() => flow.server.close(), 250).unref?.();
  }

  // ── manage_connection ──────────────────────────────────────────────────

  async manageConnection(
    ref: string,
  ): Promise<{ url: string; opened: boolean; connection: ConnectionRecord }> {
    const connection = this.db.resolveConnection(ref);
    if (!connection) throw new ConnectionNotFoundError(ref);

    const sessionId = randomUUID();
    const server = http.createServer((req, res) => {
      this.handleManageRequest(sessionId, req, res).catch((err) => {
        log('error', 'manage session request handler failed', { err: String(err) });
        safeRespond(res, 500, renderErrorPage('Internal error; see server log.'));
      });
    });
    await listen(server, 0); // ephemeral port — no OAuth callback constraint here
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://localhost:${port}/manage?s=${sessionId}`;

    const session: ActiveManageSession = {
      sessionId,
      connectionId: connection.id,
      server,
      hardTimeout: setTimeout(() => this.closeManageSession(sessionId), 10 * 60 * 1000),
    };
    session.hardTimeout.unref?.();
    this.manageSessions.set(sessionId, session);

    let opened = true;
    try {
      await this.ops.openBrowser(url);
    } catch (err) {
      opened = false;
      log('warn', 'could not open system browser for manage page', { err: String(err) });
    }
    return { url, opened, connection };
  }

  private async handleManageRequest(
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const session = this.manageSessions.get(sessionId);
    if (!session) {
      safeRespond(res, 410, renderErrorPage('This management session has expired.'));
      return;
    }
    if (!hostAllowed(req, session.server)) {
      this.audit.record('local_request.refused', {
        connectionId: session.connectionId,
        tool: 'manage_connection',
        outcome: 'refused',
        detail: { reason: 'bad_host_header' },
      });
      safeRespond(res, 403, renderErrorPage('Request refused: unexpected Host header.'));
      return;
    }
    const connection = this.db.getConnection(session.connectionId);
    if (!connection) {
      safeRespond(res, 410, renderErrorPage('This connection no longer exists.'));
      this.closeManageSession(sessionId);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/manage') {
      if (url.searchParams.get('s') !== sessionId) {
        safeRespond(res, 404, renderErrorPage('Unknown management session.'));
        return;
      }
      safeRespond(res, 200, this.renderManageForm(sessionId, connection));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/manage') {
      const body = new URLSearchParams(await readBody(req));
      if (body.get('session') !== sessionId) {
        this.audit.record('local_request.refused', {
          connectionId: session.connectionId,
          tool: 'manage_connection',
          outcome: 'refused',
          detail: { reason: 'invalid_session_token', path: '/manage' },
        });
        safeRespond(res, 403, renderErrorPage('Invalid session token.'));
        return;
      }
      const grants = normalizeGrants(Object.fromEntries(body.entries()));
      const violations = grantDependencyViolations(grants);
      if (violations.length > 0) {
        safeRespond(
          res,
          400,
          this.renderManageForm(sessionId, connection, `Invalid grants: ${violations.join('; ')}.`),
        );
        return;
      }
      const before = connection.grants;
      this.db.updateGrants(connection.id, grants);
      this.audit.record('connection.grants_changed', {
        connectionId: connection.id,
        tool: 'manage_connection',
        outcome: 'success',
        detail: { before, after: grants },
      });
      safeRespond(res, 200, renderSuccessPage({ mode: 'manage', alias: connection.alias, grants }));
      this.closeManageSession(sessionId);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    safeRespond(res, 404, renderErrorPage('Not found.'));
  }

  private renderManageForm(
    sessionId: string,
    connection: ConnectionRecord,
    error?: string,
  ): string {
    return renderGrantsPage({
      mode: 'manage',
      sessionId,
      actionPath: '/manage',
      org: {
        orgName: connection.orgName,
        orgId: connection.orgId,
        orgType: connection.orgType,
        instanceUrl: connection.instanceUrl,
        username: connection.username,
      },
      label: connection.alias,
      labelLocked: true,
      grants: connection.grants,
      error,
    });
  }

  private closeManageSession(sessionId: string): void {
    const session = this.manageSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimeout);
    this.manageSessions.delete(sessionId);
    setTimeout(() => session.server.close(), 250).unref?.();
  }

  // ── disconnect_org ─────────────────────────────────────────────────────

  async disconnectOrg(
    ref: string,
  ): Promise<{ alias: string; connectionId: string; revoked: boolean; detail?: string }> {
    const connection = this.db.resolveConnection(ref);
    if (!connection) throw new ConnectionNotFoundError(ref);

    let revoked = false;
    let detail: string | undefined;
    const refreshToken = this.tokens.getRefreshToken(connection.id);
    if (refreshToken) {
      const result = await this.ops.revokeToken({
        loginBase: connection.loginUrl,
        token: refreshToken,
      });
      revoked = result.ok;
      detail = result.detail;
    } else {
      detail = 'no refresh token was stored for this connection';
    }
    this.tokens.deleteRefreshToken(connection.id);
    this.db.deleteConnection(connection.id);
    this.audit.record('connection.removed', {
      connectionId: connection.id,
      tool: 'disconnect_org',
      outcome: 'success',
      detail: { alias: connection.alias, orgId: connection.orgId, tokenRevoked: revoked },
    });
    return { alias: connection.alias, connectionId: connection.id, revoked, detail };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function validateLabel(label: string): string | null {
  if (label.length === 0) return 'A connection label is required.';
  if (label.length > 64) return 'Labels are limited to 64 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(label)) {
    return 'Labels may contain letters, numbers, spaces, dots, dashes, and underscores.';
  }
  return null;
}

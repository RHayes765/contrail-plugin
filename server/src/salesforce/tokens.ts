import type { ContrailDb } from '../core/db.js';
import type { TokenStore } from '../core/keychain.js';
import type { ContrailConfig } from '../core/config.js';
import type { ConnectionRecord } from '../core/types.js';
import { ContrailError } from '../core/errors.js';
import { refreshAccessToken } from './oauth.js';
import { log } from '../core/log.js';

/**
 * Turns a stored refresh token into a short-lived access token on demand.
 * Access tokens are cached in memory only, per connection, and invalidated
 * on 401 so callers can retry once with a fresh token.
 */
export class AccessTokenManager {
  private readonly cache = new Map<string, { accessToken: string; fetchedAt: number }>();

  /** Conservative reuse window well inside a default org session timeout. */
  private static readonly CACHE_MS = 25 * 60 * 1000;

  constructor(
    private readonly db: ContrailDb,
    private readonly tokens: TokenStore,
    private readonly config: ContrailConfig,
  ) {}

  async getAccessToken(conn: ConnectionRecord): Promise<string> {
    const cached = this.cache.get(conn.id);
    if (cached && Date.now() - cached.fetchedAt < AccessTokenManager.CACHE_MS) {
      return cached.accessToken;
    }
    const refreshToken = this.tokens.getRefreshToken(conn.id);
    if (!refreshToken) {
      throw new ContrailError(
        `No stored token for "${conn.alias}" — the keychain entry is missing. Re-run ` +
          `connect_org with label "${conn.alias}" to re-authorize.`,
        'token_missing',
      );
    }
    let accessToken: string;
    try {
      const res = await refreshAccessToken({
        loginBase: conn.loginUrl,
        clientId: this.config.salesforce.clientId,
        refreshToken,
      });
      accessToken = res.access_token;
      // The refresh response is authoritative for the instance URL — a
      // renamed My Domain or migrated org changes it out from under us.
      if (res.instance_url && res.instance_url !== conn.instanceUrl) {
        log('info', 'instance URL changed; updating connection', {
          alias: conn.alias,
          from: conn.instanceUrl,
          to: res.instance_url,
        });
        this.db.updateInstanceUrl(conn.id, res.instance_url);
        conn.instanceUrl = res.instance_url;
      }
    } catch (err) {
      throw new ContrailError(
        `Could not refresh the session for "${conn.alias}": ${String(
          err instanceof Error ? err.message : err,
        )}. If the token was revoked (password change, sandbox refresh, admin action), ` +
          `re-run connect_org with label "${conn.alias}".`,
        'token_refresh_failed',
      );
    }
    this.cache.set(conn.id, { accessToken, fetchedAt: Date.now() });
    try {
      this.db.touchLastUsed(conn.id);
    } catch (err) {
      log('warn', 'could not update last_used_at', { err: String(err) });
    }
    return accessToken;
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }
}

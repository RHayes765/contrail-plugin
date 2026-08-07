import { OAuthFlowError } from '../core/errors.js';

/**
 * Salesforce OAuth 2.0 endpoints for a public client (authorization-code +
 * PKCE, no secret). All requests go over the login host the flow was started
 * against; refresh and revoke reuse the stored login_url.
 */

export const PRODUCTION_LOGIN = 'https://login.salesforce.com';
export const SANDBOX_LOGIN = 'https://test.salesforce.com';

/**
 * Hosts we are willing to send an OAuth flow to. My Domain endpoints all live
 * under salesforce.com / salesforce.mil (enhanced domains); anything else is
 * refused so a prompt-injected "login URL" cannot point the browser at an
 * attacker-controlled page.
 */
const ALLOWED_LOGIN_SUFFIXES = ['.salesforce.com', '.salesforce.mil'];

/**
 * Resolve the user's login target: 'production' | 'sandbox' | a My Domain
 * URL. Returns a normalized https origin.
 */
export function resolveLoginBase(login?: string): string {
  const value = (login ?? 'production').trim();
  if (value === '' || value.toLowerCase() === 'production' || value.toLowerCase() === 'prod') {
    return PRODUCTION_LOGIN;
  }
  if (value.toLowerCase() === 'sandbox' || value.toLowerCase() === 'test') {
    return SANDBOX_LOGIN;
  }
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new OAuthFlowError(
      `"${value}" is not a valid login target. Use "production", "sandbox", or a My Domain URL ` +
        `like https://acme.my.salesforce.com.`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new OAuthFlowError(`Login URL must be https (got ${url.protocol}//).`);
  }
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_LOGIN_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new OAuthFlowError(
      `Login host "${host}" is not a Salesforce domain. Only *.salesforce.com and ` +
        `*.salesforce.mil login endpoints are accepted.`,
    );
  }
  return `https://${host}`;
}

export function buildAuthorizeUrl(params: {
  loginBase: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL('/services/oauth2/authorize', params.loginBase);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  /** Identity URL: https://login.../id/{orgId}/{userId} */
  id: string;
  token_type: string;
  issued_at?: string;
  scope?: string;
}

export async function exchangeCode(params: {
  loginBase: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.verifier,
  });
  const res = await postToken(params.loginBase, body);
  const token = res as TokenResponse;
  if (!token.refresh_token) {
    throw new OAuthFlowError(
      'Salesforce did not return a refresh token. The connected app must have the ' +
        '"Perform requests at any time (refresh_token, offline_access)" scope enabled.',
    );
  }
  return token;
}

export interface RefreshResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at?: string;
}

export async function refreshAccessToken(params: {
  loginBase: string;
  clientId: string;
  refreshToken: string;
}): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });
  return (await postToken(params.loginBase, body)) as RefreshResponse;
}

/** Best-effort: revoke errors are reported, not thrown past the caller's control. */
export async function revokeToken(params: {
  loginBase: string;
  token: string;
}): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(new URL('/services/oauth2/revoke', params.loginBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: params.token }),
    });
    if (!res.ok) {
      return { ok: false, detail: `revoke endpoint returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function postToken(loginBase: string, body: URLSearchParams): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(new URL('/services/oauth2/token', loginBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new OAuthFlowError(`Could not reach ${loginBase}: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = [parsed.error, parsed.error_description].filter(Boolean).join(': ') || text;
    } catch {
      // keep raw text
    }
    throw new OAuthFlowError(`Token request failed (${res.status}): ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OAuthFlowError('Token endpoint returned a non-JSON response.');
  }
}

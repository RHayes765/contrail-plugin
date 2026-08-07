import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, resolveLoginBase, PRODUCTION_LOGIN, SANDBOX_LOGIN } from '../salesforce/oauth.js';
import { OAuthFlowError } from '../core/errors.js';

describe('resolveLoginBase', () => {
  it('maps the keywords', () => {
    expect(resolveLoginBase(undefined)).toBe(PRODUCTION_LOGIN);
    expect(resolveLoginBase('production')).toBe(PRODUCTION_LOGIN);
    expect(resolveLoginBase('Prod')).toBe(PRODUCTION_LOGIN);
    expect(resolveLoginBase('sandbox')).toBe(SANDBOX_LOGIN);
    expect(resolveLoginBase('test')).toBe(SANDBOX_LOGIN);
  });

  it('accepts My Domain URLs, normalizing to origin', () => {
    expect(resolveLoginBase('https://acme.my.salesforce.com/some/path')).toBe(
      'https://acme.my.salesforce.com',
    );
    expect(resolveLoginBase('acme--uat.sandbox.my.salesforce.com')).toBe(
      'https://acme--uat.sandbox.my.salesforce.com',
    );
  });

  it('refuses non-Salesforce hosts — a prompt-injected login URL cannot redirect the browser', () => {
    expect(() => resolveLoginBase('https://evil.example.com')).toThrow(OAuthFlowError);
    expect(() => resolveLoginBase('https://salesforce.com.evil.example')).toThrow(OAuthFlowError);
    expect(() => resolveLoginBase('https://notsalesforce.com')).toThrow(OAuthFlowError);
  });

  it('refuses plain http', () => {
    expect(() => resolveLoginBase('http://login.salesforce.com')).toThrow(OAuthFlowError);
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the PKCE challenge, state, and scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({
        loginBase: PRODUCTION_LOGIN,
        clientId: 'TestClient',
        redirectUri: 'http://localhost:1717/OauthRedirect',
        challenge: 'abc123',
        state: 'state-nonce',
        scopes: ['refresh_token', 'api'],
      }),
    );
    expect(url.origin).toBe(PRODUCTION_LOGIN);
    expect(url.pathname).toBe('/services/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('TestClient');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1717/OauthRedirect');
    expect(url.searchParams.get('code_challenge')).toBe('abc123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-nonce');
    expect(url.searchParams.get('scope')).toBe('refresh_token api');
  });
});

import { describe, expect, it } from 'vitest';
import { base64url, challengeFromVerifier, generateState, generateVerifier } from '../salesforce/pkce.js';

describe('pkce', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    expect(challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates url-safe verifiers of RFC-valid length', () => {
    for (let i = 0; i < 20; i++) {
      const v = generateVerifier();
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
    }
  });

  it('generates unique states', () => {
    const states = new Set(Array.from({ length: 100 }, () => generateState()));
    expect(states.size).toBe(100);
  });

  it('base64url output never contains padding or unsafe chars', () => {
    expect(base64url(Buffer.from([251, 255, 254, 0, 1]))).not.toMatch(/[+/=]/);
  });
});

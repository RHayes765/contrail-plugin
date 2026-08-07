import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 (S256) helpers for the authorization-code + PKCE flow. */

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

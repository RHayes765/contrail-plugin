import { createRequire } from 'node:module';
import { log } from './log.js';

/**
 * Refresh tokens live in the OS keychain only (Windows Credential Manager /
 * macOS Keychain / libsecret), keyed by connection id. Nothing token-shaped
 * ever touches the SQLite database, config file, or an MCP response.
 */
export interface TokenStore {
  setRefreshToken(connectionId: string, token: string): void;
  getRefreshToken(connectionId: string): string | null;
  deleteRefreshToken(connectionId: string): void;
}

const SERVICE = 'contrail-engine';

export class KeychainTokenStore implements TokenStore {
  private entryFor(connectionId: string) {
    const { Entry } = loadKeyring();
    return new Entry(SERVICE, connectionId);
  }

  setRefreshToken(connectionId: string, token: string): void {
    this.entryFor(connectionId).setPassword(token);
  }

  getRefreshToken(connectionId: string): string | null {
    try {
      return this.entryFor(connectionId).getPassword();
    } catch {
      return null;
    }
  }

  deleteRefreshToken(connectionId: string): void {
    try {
      this.entryFor(connectionId).deletePassword();
    } catch (err) {
      log('warn', 'keychain delete failed (entry may not exist)', {
        connectionId,
        err: String(err),
      });
    }
  }
}

/** Test double; also useful for headless CI where no keychain exists. */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, string>();

  setRefreshToken(connectionId: string, token: string): void {
    this.tokens.set(connectionId, token);
  }

  getRefreshToken(connectionId: string): string | null {
    return this.tokens.get(connectionId) ?? null;
  }

  deleteRefreshToken(connectionId: string): void {
    this.tokens.delete(connectionId);
  }
}

type KeyringModule = typeof import('@napi-rs/keyring');

const nativeRequire = createRequire(import.meta.url);
let keyringModule: KeyringModule | null = null;

/**
 * Loaded lazily so a broken native module surfaces as a per-operation error
 * with guidance, not a crash before the MCP handshake.
 */
function loadKeyring(): KeyringModule {
  if (!keyringModule) {
    try {
      keyringModule = nativeRequire('@napi-rs/keyring') as KeyringModule;
    } catch (err) {
      throw new Error(
        `OS keychain unavailable (${String(err)}). Contrail stores refresh tokens in the OS ` +
          `keychain only; without it, orgs cannot be connected on this machine.`,
      );
    }
  }
  return keyringModule;
}

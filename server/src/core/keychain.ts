import { createRequire } from 'node:module';
import { log } from './log.js';

/**
 * Refresh tokens live in the OS keychain only (Windows Credential Manager /
 * macOS Keychain / libsecret), keyed by connection id. Nothing token-shaped
 * ever touches the SQLite database, config file, or an MCP response.
 *
 * S42: the same store also holds the few NON-connection secrets the engine
 * owns (the Pushover user key and application token behind approval
 * notifications), under `notify:`-prefixed accounts that can never collide
 * with a connection UUID. One keychain entry serves the plugin AND the desktop
 * app — they share the data dir and the service name.
 */
export interface TokenStore {
  setRefreshToken(connectionId: string, token: string): void;
  getRefreshToken(connectionId: string): string | null;
  deleteRefreshToken(connectionId: string): void;
  /** Generic secret under an engine-owned account name (never a connection id). */
  setSecret(account: string, value: string): void;
  getSecret(account: string): string | null;
  deleteSecret(account: string): void;
}

const SERVICE = 'contrail-engine';

export class KeychainTokenStore implements TokenStore {
  private entryFor(account: string) {
    const { Entry } = loadKeyring();
    return new Entry(SERVICE, account);
  }

  setRefreshToken(connectionId: string, token: string): void {
    this.setSecret(connectionId, token);
  }

  getRefreshToken(connectionId: string): string | null {
    // Token reads keep their original any-failure-is-absence contract: the
    // caller's next step is a re-auth prompt either way.
    try {
      return this.getSecret(connectionId);
    } catch {
      return null;
    }
  }

  deleteRefreshToken(connectionId: string): void {
    this.deleteSecret(connectionId);
  }

  setSecret(account: string, value: string): void {
    this.entryFor(account).setPassword(value);
  }

  /**
   * null ONLY when no entry exists. A locked, policy-blocked, or absent
   * keychain THROWS — so a status surface can say "the store could not be
   * read" instead of the false "no key stored" (the napi-rs keyring reports
   * absence with a NoEntry-style message; everything else is a store fault).
   */
  getSecret(account: string): string | null {
    try {
      return this.entryFor(account).getPassword();
    } catch (err) {
      if (/no matching entry|not found|no such/i.test(String(err))) return null;
      throw err;
    }
  }

  deleteSecret(account: string): void {
    try {
      this.entryFor(account).deletePassword();
    } catch (err) {
      log('warn', 'keychain delete failed (entry may not exist)', {
        account,
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

  setSecret(account: string, value: string): void {
    this.tokens.set(account, value);
  }

  getSecret(account: string): string | null {
    return this.tokens.get(account) ?? null;
  }

  deleteSecret(account: string): void {
    this.tokens.delete(account);
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

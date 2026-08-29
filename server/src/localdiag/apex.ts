import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient } from './lspClient.js';
import type { LocalDiagnostic, SpawnLsp } from './types.js';

/**
 * One-shot Apex diagnostics against the vendored apex-ls server.
 * MIRROR UNIT (desktop counterpart: packages/engine/src/localdiag/apex.ts).
 *
 * The protocol here is transcribed from sf-skills' working lsp-precheck
 * driver (their pre-deploy gate against the SAME vendored bundle), including
 * its two non-obvious load-bearing details:
 *   - initializationOptions.apex.environment.serverMode MUST be
 *     "development" — production mode disables diagnostics entirely and
 *     textDocument/diagnostic answers "Unhandled method" forever;
 *   - the didOpen URI's file EXTENSION selects the parser (.cls compilation
 *     unit, .trigger trigger unit, .apex anonymous-block wrap) — languageId
 *     is always "apex".
 */

const INIT_TIMEOUT_MS = 8_000;
const PULL_TIMEOUT_MS = 5_000;
const PULL_INTERVAL_MS = 250;
/**
 * Calibrated: the semantic validator runs AHEAD of its symbol loading and
 * emits transient false positives (System.debug flagged, Account.Name
 * flagged) that hold STABLE for up to ~3s before clearing. A semantic result
 * is only believed once it has held longer than any observed wave. Parser
 * results (source 'apex-parser') are deterministic and believed immediately.
 */
const SEMANTIC_STABLE_MS = 4_000;
const CLEAN_STREAK = 6;

function severityOf(n: unknown): LocalDiagnostic['severity'] {
  switch (n) {
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'error';
  }
}

export interface LspDiagnostic {
  severity?: number;
  range?: { start?: { line?: number; character?: number } };
  message?: string;
  code?: unknown;
  source?: string;
}

export function mapDiagnostics(items: LspDiagnostic[]): LocalDiagnostic[] {
  return items.map((d) => ({
    severity: severityOf(d.severity),
    line: (d.range?.start?.line ?? 0) + 1,
    column: (d.range?.start?.character ?? 0) + 1,
    message: String(d.message ?? ''),
    ...(d.code !== undefined && d.code !== null ? { code: String(d.code) } : {}),
  }));
}

/**
 * Answer the server→client requests apex-ls sends — unanswered, it stalls;
 * answered with a JSON-RPC ERROR, it throws uncaught and exits 1 (the
 * workspace/diagnostic/refresh it fires on file events proved that). The
 * client also nulls unknown methods as a backstop.
 */
function registerServerRequestAnswers(client: LspClient): void {
  client.onRequest('client/registerCapability', () => null);
  client.onRequest('client/unregisterCapability', () => null);
  client.onRequest('workspace/configuration', (params) => {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
    return items.map(() => null);
  });
  client.onRequest('window/workDoneProgress/create', () => null);
  client.onRequest('workspace/diagnostic/refresh', () => null);
}

export async function startApexServer(
  spawnLsp: SpawnLsp,
  serverScript: string,
  workspaceRoot: string,
): Promise<LspClient> {
  const child = spawnLsp(serverScript, ['--stdio'], workspaceRoot);
  const client = new LspClient(child, 'apex');
  registerServerRequestAnswers(client);
  await client.request(
    'initialize',
    {
      processId: process.pid,
      rootUri: pathToFileURL(workspaceRoot).toString(),
      workspaceFolders: [
        { uri: pathToFileURL(workspaceRoot).toString(), name: path.basename(workspaceRoot) },
      ],
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          publishDiagnostics: { relatedInformation: true },
          synchronization: { didSave: true, dynamicRegistration: false },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          diagnostics: { refreshSupport: true },
        },
      },
      initializationOptions: {
        apex: { environment: { serverMode: 'development' }, detailLevel: 'public-api' },
      },
    },
    INIT_TIMEOUT_MS,
  );
  client.notify('initialized', {});
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * didOpen the file and PULL diagnostics until a TRUSTWORTHY answer exists:
 *   - a result containing parser diagnostics (source 'apex-parser') is
 *     deterministic — accepted immediately;
 *   - a purely SEMANTIC result must hold unchanged for SEMANTIC_STABLE_MS
 *     (the transient false-positive waves hold shorter than that, then clear);
 *   - a CLEAN_STREAK of consecutive empty pulls means clean.
 * Retries "Unhandled method" (capabilities settle asynchronously). Unlike
 * upstream, errors and deadline overruns PROPAGATE — the caller reports
 * "couldn't check", never a fabricated clean. This function assumes a FRESH
 * server per check (the runner's one-shot lifecycle): calibration showed a
 * long-lived apex-ls silently stops analyzing new documents — an empty pull
 * from a stale server is indistinguishable from clean, so no server survives
 * past one answer.
 */
export async function checkApexOnce(
  client: LspClient,
  fileUri: string,
  text: string,
  version: number,
  deadline: number,
): Promise<LocalDiagnostic[]> {
  client.notify('textDocument/didOpen', {
    textDocument: { uri: fileUri, languageId: 'apex', version, text },
  });
  try {
    let emptyStreak = 0;
    let lastSignature = '';
    let stableSince = Date.now();
    for (;;) {
      if (Date.now() > deadline) throw new DeadlineError();
      let items: LspDiagnostic[] | undefined;
      try {
        const result = (await client.request(
          'textDocument/diagnostic',
          { textDocument: { uri: fileUri } },
          Math.max(250, Math.min(PULL_TIMEOUT_MS, deadline - Date.now())),
        )) as { items?: LspDiagnostic[] } | undefined;
        items = result?.items;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Unhandled method')) {
          await delay(PULL_INTERVAL_MS);
          continue;
        }
        throw err;
      }
      const list = Array.isArray(items) ? items : [];
      if (list.length > 0 && list.some((d) => d.source === 'apex-parser')) {
        return mapDiagnostics(list);
      }
      const signature = JSON.stringify(list);
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }
      if (list.length === 0) {
        if (++emptyStreak >= CLEAN_STREAK) return [];
      } else {
        emptyStreak = 0;
        if (Date.now() - stableSince >= SEMANTIC_STABLE_MS) return mapDiagnostics(list);
      }
      await delay(PULL_INTERVAL_MS);
    }
  } finally {
    try {
      client.notify('textDocument/didClose', { textDocument: { uri: fileUri } });
    } catch {
      /* server may be gone; the runner handles that */
    }
  }
}

/** Thrown when a check outruns its budget — mapped to check_timeout, never to clean. */
export class DeadlineError extends Error {
  constructor() {
    super('local diagnostics check outran its budget');
  }
}


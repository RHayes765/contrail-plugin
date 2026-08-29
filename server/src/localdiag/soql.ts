import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient } from './lspClient.js';
import { mapDiagnostics, DeadlineError } from './apex.js';
import type { LocalDiagnostic, SpawnLsp } from './types.js';

/**
 * One-shot SOQL syntax diagnostics against the vendored soql-lsp bundle.
 * MIRROR UNIT (desktop counterpart: packages/engine/src/localdiag/soql.ts).
 *
 * Different mechanism than Apex, transcribed from sf-skills' host: the SOQL
 * server PUSHES textDocument/publishDiagnostics on every didOpen (even an
 * empty list), so the client subscribes BEFORE opening and awaits the push.
 * The didOpen URI is synthetic — no file ever touches disk. The initialize
 * capabilities are deliberately minimal, and capabilities.soql.runQuery is
 * NEVER set: that flag would enable the org-connected LIMIT-0 probe, and
 * check_soql's whole promise is offline parser-only.
 */

const INIT_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 5_000;

export async function startSoqlServer(
  spawnLsp: SpawnLsp,
  serverScript: string,
  workspaceRoot: string,
): Promise<LspClient> {
  const child = spawnLsp(serverScript, ['--stdio'], workspaceRoot);
  const client = new LspClient(child, 'soql');
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
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { dynamicRegistration: false },
        },
      },
    },
    INIT_TIMEOUT_MS,
  );
  client.notify('initialized', {});
  return client;
}

export async function checkSoqlOnce(
  client: LspClient,
  workspaceRoot: string,
  query: string,
  version: number,
  deadline: number,
): Promise<LocalDiagnostic[]> {
  // Version-unique URI: the server pushes an EMPTY diagnostics clear on
  // didClose, and a shared URI lets a previous check's late clear race in as
  // this check's answer — a wrong "clean" on a broken query.
  const uri = pathToFileURL(path.join(workspaceRoot, `__validate__${version}.soql`)).toString();

  let unsubscribe: () => void = () => undefined;
  const push = new Promise<LocalDiagnostic[]>((resolve) => {
    unsubscribe = client.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri?: string; diagnostics?: unknown[] } | undefined;
      if (p?.uri !== uri) return;
      resolve(mapDiagnostics(Array.isArray(p.diagnostics) ? (p.diagnostics as never[]) : []));
    });
  });

  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'soql', version, text: query },
  });
  try {
    const budget = Math.max(250, Math.min(PUSH_TIMEOUT_MS, deadline - Date.now()));
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new DeadlineError()), budget).unref?.();
    });
    // The server always pushes on didOpen (even an empty list) — the timeout
    // is belt-and-braces, and it surfaces as check_timeout, never as clean.
    return await Promise.race([push, timeout]);
  } finally {
    unsubscribe();
    try {
      client.notify('textDocument/didClose', { textDocument: { uri } });
    } catch {
      /* server may be gone; the runner handles that */
    }
  }
}

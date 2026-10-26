import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ENGINE_VERSION, SERVER_NAME } from './core/version.js';

/**
 * Degraded-mode server, built only when real startup throws: the failure
 * reaches the human THROUGH the MCP connection instead of a pre-handshake
 * process exit. Some hosts (the .mcpb channel) show no server stderr, so a
 * startup crash there is an unexplained "Server disconnected" retry loop —
 * this server completes the handshake and serves one tool that reports what
 * broke and what to do about it.
 *
 * Import discipline: startup failures include the native better-sqlite3
 * binding failing to load, so nothing here may transitively import it — that
 * rules out core/paths.ts and everything behind server.ts. SDK, node builtins,
 * and core/version.ts only; index.ts defers its engine imports for the same
 * reason.
 */

/** Best-effort mirror of core/paths.ts dataDir() (unimportable here — see above). */
function describeDataDir(): string {
  if (process.env.CONTRAIL_DATA_DIR) return process.env.CONTRAIL_DATA_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(home, '.contrail');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Contrail');
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
        'contrail',
      );
  }
}

export function createStartupErrorServer(err: unknown): McpServer {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const stack = err instanceof Error && err.stack ? err.stack : null;

  const server = new McpServer(
    { name: SERVER_NAME, version: ENGINE_VERSION },
    {
      instructions:
        `Contrail Engine ${ENGINE_VERSION} FAILED TO START: ${message} — no engine ` +
        'functionality is available this session. Call engine_status for the full error and ' +
        'remediation steps, report the failure to the human, and do not retry other operations.',
    },
  );

  server.registerTool(
    'engine_status',
    {
      title: 'Engine startup status',
      description:
        'Contrail failed to start; this degraded session exists only to carry the error. ' +
        'Returns the startup failure and remediation steps for the human.',
      inputSchema: {},
    },
    async () => ({
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              status: 'startup_failed',
              version: ENGINE_VERSION,
              error: message,
              ...(typeof code === 'string' ? { error_code: code } : {}),
              data_dir: describeDataDir(),
              remediation: [
                'The error above is the root cause — fix it and restart the MCP server (toggle the extension or restart the client app).',
                `Contrail's local state lives in the data directory; check that it exists, is writable, and that contrail.db was not replaced or restored behind the engine's back.`,
                'To reproduce outside the host app, run the installed server entry (server/index.mjs in the extension folder, or server/dist-plugin/index.mjs in the plugin) with `node` and read stderr.',
                'If the error names a fix (for example a contrail.db.adopt marker), apply it only when the condition it describes was a deliberate change.',
              ],
              ...(stack ? { stack } : {}),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

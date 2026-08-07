/**
 * Stderr-only logger. The MCP stdio transport owns stdout — writing anything
 * else to it corrupts the JSON-RPC stream, so all logging goes to stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function activeLevel(): LogLevel {
  const env = (process.env.CONTRAIL_LOG_LEVEL ?? 'info').toLowerCase();
  return (env in LEVEL_ORDER ? env : 'info') as LogLevel;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;
  process.stderr.write(
    `[contrail ${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}\n`,
  );
}

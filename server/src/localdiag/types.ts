import type { ChildProcess } from 'node:child_process';

/**
 * Local static diagnostics (check_apex / check_soql) — shared shapes.
 * MIRROR UNIT: this module is byte-identical in the desktop engine
 * (packages/engine/src/localdiag/) apart from nothing at all — keep it so.
 */

/** Why a check could not run. NEVER conflated with "checked and clean". */
export type UnavailableCode =
  | 'disabled' // the human turned localDiagnostics.enabled off
  | 'not_installed' // this install carries no vendored language servers
  | 'spawn_timeout' // the server did not come up in time
  | 'check_timeout' // the server came up but the check outran its budget
  | 'server_error'; // the server misbehaved (or is in breaker cooldown)

export interface LocalDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  /** 1-based, like every compiler on earth (LSP's 0-based ranges are converted). */
  line: number;
  column: number;
  message: string;
  code?: string;
}

/**
 * The honesty contract: a result either CHECKED the input (diagnostics may be
 * empty = clean) or says exactly why it could not. A failure path must never
 * surface as an empty diagnostics list — that is upstream's fail-open
 * behavior, and the one part of their design Contrail deliberately rejects.
 */
export type LocalDiagResult =
  | { checked: true; diagnostics: LocalDiagnostic[] }
  | { checked: false; unavailable: UnavailableCode; detail: string };

export type ApexSourceKind = 'class' | 'trigger' | 'anonymous';

export interface LocalDiagRunner {
  checkApex(source: string, kind: ApexSourceKind): Promise<LocalDiagResult>;
  checkSoql(query: string): Promise<LocalDiagResult>;
  /** Kill any live language servers (desktop wires this to app quit). */
  shutdown(): Promise<void>;
}

/**
 * How to start a language-server script under Node. Injected because the two
 * hosts differ: the plugin runs under plain node (process.execPath IS node);
 * the desktop app runs under Electron and must add ELECTRON_RUN_AS_NODE.
 * stdio must be three pipes — stdout is the LSP channel and stderr must be
 * drained (an undrained pipe wedges the child once the buffer fills).
 */
export type SpawnLsp = (scriptPath: string, args: string[], cwd: string) => ChildProcess;

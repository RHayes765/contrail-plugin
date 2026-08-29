import type { ChildProcess } from 'node:child_process';
import { log } from '../core/log.js';

/**
 * Minimal LSP-flavored JSON-RPC client over a child process's stdio.
 * MIRROR UNIT (desktop counterpart: packages/engine/src/localdiag/lspClient.ts).
 *
 * Standard Content-Length framing. Tolerates unknown notifications (the SOQL
 * server sends an unsolicited `soql/validate` at startup), answers registered
 * server→client requests (the Apex server stalls if `workspace/configuration`
 * and friends go unanswered), and fails every pending request the moment the
 * child dies — a hung promise here would wedge a tool call forever.
 */

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HEADER_SEP = Buffer.from('\r\n\r\n', 'ascii');
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

export class LspClient {
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private dead: Error | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drain stderr unconditionally — an undrained pipe wedges the child.
    child.stderr?.on('data', (chunk: Buffer) => {
      log('debug', `[lsp:${label}] ${chunk.toString('utf8').trimEnd()}`);
    });
    // A dying child races our writes: without an error handler, stdin's
    // async EPIPE is an UNHANDLED 'error' event that would kill the HOST
    // process. The child's death is already handled via 'exit'.
    child.stdin?.on('error', (err) => {
      log('debug', `[lsp:${label}] stdin: ${String(err)}`);
    });
    child.on('exit', (code) =>
      this.failAll(new Error(`${label} language server exited (code ${code})`)),
    );
    child.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  /** Register the answer for a server→client request (e.g. workspace/configuration). */
  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  /** Subscribe to a server notification; returns the unsubscribe. */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set();
    set.add(handler);
    this.notificationHandlers.set(method, set);
    return () => set.delete(handler);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /** Polite shutdown then a hard kill — one-shot semantics, never lingers. */
  dispose(): void {
    if (!this.dead) {
      try {
        this.notify('shutdown', undefined);
        this.notify('exit', undefined);
      } catch {
        /* dying anyway */
      }
    }
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.failAll(new Error(`${this.label} language server disposed`));
  }

  private send(msg: RpcMessage): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    try {
      this.child.stdin?.write(Buffer.concat([header, body]));
    } catch (err) {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf(HEADER_SEP);
      if (sep === -1) return;
      const header = this.buffer.subarray(0, sep).toString('ascii');
      const match = CONTENT_LENGTH_RE.exec(header);
      if (!match) {
        // Unframeable garbage — resync by dropping the bogus header.
        this.buffer = this.buffer.subarray(sep + HEADER_SEP.length);
        continue;
      }
      const length = Number(match[1]);
      const start = sep + HEADER_SEP.length;
      if (this.buffer.length < start + length) return; // body not fully arrived
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(body) as RpcMessage;
      } catch {
        continue; // a malformed frame must not kill the stream
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server→client request: answer it or the server stalls.
      const handler = this.requestHandlers.get(msg.method);
      let result: unknown = null;
      if (handler) {
        try {
          result = handler(msg.params);
        } catch {
          /* a handler failure still gets a response below */
        }
      }
      // Unknown methods get a null RESULT, never a -32601 error: apex-ls
      // throws error responses UNCAUGHT and exits 1 (calibrated fact — its
      // own workspace/diagnostic/refresh killed it that way).
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return; // late response after timeout — drop
      this.pending.delete(Number(msg.id));
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'language server error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined) {
      // Notification. Unknown methods are dropped silently by design.
      for (const handler of this.notificationHandlers.get(msg.method) ?? []) {
        try {
          handler(msg.params);
        } catch {
          /* a subscriber failure must not poison the stream */
        }
      }
    }
  }

  private failAll(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

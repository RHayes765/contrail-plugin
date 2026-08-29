import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { LspClient } from '../localdiag/lspClient.js';

/**
 * Framing + dispatch tests for the LSP client over fake stdio streams. The
 * pins here are the calibrated survival rules: unknown server→client
 * requests get a NULL RESULT (an error response crashes apex-ls), unknown
 * notifications are dropped, chunk-split frames reassemble, and a dead child
 * fails every pending request instead of hanging a tool call forever.
 */

interface FakeChild {
  child: ChildProcess;
  stdinData: Buffer[];
  emitStdout: (buf: Buffer) => void;
  exit: (code: number) => void;
}

function fakeChild(): FakeChild {
  const proc = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinData: Buffer[] = [];
  const stdin = new PassThrough();
  stdin.on('data', (c: Buffer) => stdinData.push(c));
  Object.assign(proc, {
    stdout,
    stderr,
    stdin,
    kill: () => true,
  });
  return {
    child: proc,
    stdinData,
    emitStdout: (buf) => stdout.write(buf),
    exit: (code) => proc.emit('exit', code),
  };
}

function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function sentMessages(stdinData: Buffer[]): Array<Record<string, unknown>> {
  const all = Buffer.concat(stdinData).toString('utf8');
  const out: Array<Record<string, unknown>> = [];
  const re = /Content-Length: (\d+)\r\n\r\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all))) {
    out.push(JSON.parse(all.slice(re.lastIndex, re.lastIndex + Number(m[1]))) as Record<string, unknown>);
  }
  return out;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('LspClient', () => {
  it('resolves requests whose responses arrive split across arbitrary chunks', async () => {
    const f = fakeChild();
    const client = new LspClient(f.child, 'test');
    const pending = client.request('initialize', { a: 1 }, 2000);
    await tick();
    const [sent] = sentMessages(f.stdinData);
    expect(sent?.method).toBe('initialize');

    const response = frame({ jsonrpc: '2.0', id: sent!.id, result: { ok: true } });
    // Feed it byte-dribbled: header split mid-word, body split mid-JSON.
    f.emitStdout(response.subarray(0, 7));
    f.emitStdout(response.subarray(7, 25));
    await tick();
    f.emitStdout(response.subarray(25));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('answers registered server requests, and UNKNOWN ones with a null RESULT (never an error)', async () => {
    const f = fakeChild();
    const client = new LspClient(f.child, 'test');
    client.onRequest('workspace/configuration', (params) =>
      ((params as { items?: unknown[] })?.items ?? []).map(() => null),
    );

    f.emitStdout(
      frame({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [1, 2] } }),
    );
    f.emitStdout(frame({ jsonrpc: '2.0', id: 8, method: 'workspace/diagnostic/refresh' }));
    await tick();

    const replies = sentMessages(f.stdinData);
    const configReply = replies.find((r) => r.id === 7);
    const refreshReply = replies.find((r) => r.id === 8);
    expect(configReply?.result).toEqual([null, null]);
    // apex-ls throws error responses UNCAUGHT and exits 1 — this pin is load-bearing.
    expect(refreshReply?.result).toBeNull();
    expect(refreshReply?.error).toBeUndefined();
  });

  it('dispatches notifications to subscribers and silently drops unknown ones', async () => {
    const f = fakeChild();
    const client = new LspClient(f.child, 'test');
    const seen: unknown[] = [];
    client.onNotification('textDocument/publishDiagnostics', (p) => seen.push(p));

    f.emitStdout(frame({ jsonrpc: '2.0', method: 'soql/validate', params: 'createConnection' }));
    f.emitStdout(
      frame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'u', diagnostics: [] } }),
    );
    await tick();
    expect(seen).toEqual([{ uri: 'u', diagnostics: [] }]);
  });

  it('fails every pending request when the child dies — a tool call must never hang', async () => {
    const f = fakeChild();
    const client = new LspClient(f.child, 'test');
    const pending = client.request('textDocument/diagnostic', {}, 60_000);
    await tick();
    f.exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    expect(client.alive).toBe(false);
    // And post-mortem requests reject immediately instead of queueing.
    await expect(client.request('x', {}, 1000)).rejects.toThrow();
  });
});

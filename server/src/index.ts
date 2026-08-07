#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createDeps, createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { log } from './core/log.js';

/**
 * Entry point. stdio transport by default (the Phase 0 plugin path);
 * streamable HTTP behind --http for the future self-hosted Docker step —
 * same codebase, different flag (spec §2).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const httpFlagIndex = args.indexOf('--http');

  if (httpFlagIndex === -1) {
    const deps = createDeps();
    const server = createServer(deps);
    await server.connect(new StdioServerTransport());
    log('info', `${SERVER_NAME} ${SERVER_VERSION} listening on stdio`);
    return;
  }

  const portArg = args[httpFlagIndex + 1];
  const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 7373;
  const host = process.env.CONTRAIL_HTTP_HOST ?? '127.0.0.1';
  await startHttpServer(port, host);
}

async function startHttpServer(port: number, host: string): Promise<void> {
  const deps = createDeps();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => {
      log('error', 'HTTP request failed', { err: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  });

  const loopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  /**
   * DNS-rebinding/CSRF defense (required by the MCP streamable-HTTP spec for
   * locally bound servers): refuse browser-originated cross-site requests via
   * the Origin header, and — when bound to loopback — any Host header that is
   * not the loopback endpoint itself. Non-loopback binds (the deliberate
   * Docker/self-hosted case) own their network controls per the README.
   */
  function requestAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      try {
        const o = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(o.hostname)) return false;
      } catch {
        return false;
      }
    }
    if (loopbackBind) {
      const h = (req.headers.host ?? '').toLowerCase();
      const hostname = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : (h.split(':')[0] ?? '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
    }
    return true;
  }

  async function handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!requestAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: unexpected Host or Origin header' }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing =
      typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = createServer(deps);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Initialize first.' },
        id: null,
      }),
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  log('info', `${SERVER_NAME} ${SERVER_VERSION} listening on http://${host}:${port}/mcp`);
}

const MAX_HTTP_BODY = 4 * 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

main().catch((err) => {
  log('error', 'fatal startup error', { err: String(err) });
  process.exit(1);
});

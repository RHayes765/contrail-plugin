import http from 'node:http';

/**
 * Shared primitives for Contrail's localhost pages (grants, management,
 * deploy approval). Bind to loopback, refuse foreign Host headers, send
 * anti-framing headers — the browser page is a trust boundary.
 */

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // frame-ancestors 'none' blocks clickjacking overlays; the inline
  // style/script allowances are what the pages actually use.
  'Content-Security-Policy':
    "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
} as const;

export function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/** Close immediately, destroying keep-alive sockets, and wait until the port is released. */
export function closeServerNow(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * Localhost listeners refuse requests whose Host header is not the loopback
 * host:port they are bound to — the standard DNS-rebinding defense for local
 * servers (an attacker page's rebound hostname arrives in Host).
 */
export function hostAllowed(req: http.IncomingMessage, server: http.Server): boolean {
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) return false;
  const host = (req.headers.host ?? '').toLowerCase();
  return (
    host === `localhost:${addr.port}` ||
    host === `127.0.0.1:${addr.port}` ||
    host === `[::1]:${addr.port}`
  );
}

export function safeRespond(res: http.ServerResponse, status: number, html: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  res.end(html);
}

export function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, ...SECURITY_HEADERS }).end();
}

const MAX_BODY_BYTES = 64 * 1024;

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

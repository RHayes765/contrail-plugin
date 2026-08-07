import http from 'node:http';
import { randomUUID } from 'node:crypto';
import openBrowserDefault from 'open';
import { hostAllowed, listen, safeRespond } from '../core/localhttp.js';
import { renderErrorPage } from '../connect/pages.js';
import { log } from '../core/log.js';

/**
 * Serves a write-approval page on an ephemeral loopback port. The page is
 * the only channel carrying the confirmation code to the human; the tool
 * result deliberately never includes it, so a prompt-injected agent cannot
 * approve its own write. Read-only page — no POST; approval happens by the
 * human speaking the code back in chat.
 */

interface ApprovalSession {
  server: http.Server;
  html: string;
  hardTimeout: NodeJS.Timeout;
}

const SESSION_TTL_MS = 20 * 60 * 1000;

export class ApprovalPageServer {
  private readonly sessions = new Map<string, ApprovalSession>();

  constructor(
    private readonly openBrowser: (url: string) => Promise<void> = async (url) => {
      await openBrowserDefault(url);
    },
  ) {}

  /** Render `html` at a fresh session URL and open the human's browser at it. */
  async present(html: string): Promise<{ url: string; opened: boolean }> {
    const sessionId = randomUUID();
    const server = http.createServer((req, res) => {
      this.handle(sessionId, req, res);
    });
    await listen(server, 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://localhost:${port}/approve?s=${sessionId}`;

    const session: ApprovalSession = {
      server,
      html,
      hardTimeout: setTimeout(() => this.close(sessionId), SESSION_TTL_MS),
    };
    session.hardTimeout.unref?.();
    this.sessions.set(sessionId, session);

    let opened = true;
    try {
      await this.openBrowser(url);
    } catch (err) {
      opened = false;
      log('warn', 'could not open browser for approval page', { err: String(err) });
    }
    return { url, opened };
  }

  private handle(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      safeRespond(res, 410, renderErrorPage('This approval page has expired.'));
      return;
    }
    if (!hostAllowed(req, session.server)) {
      safeRespond(res, 403, renderErrorPage('Request refused: unexpected Host header.'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/approve' && url.searchParams.get('s') === sessionId) {
      safeRespond(res, 200, session.html);
      return;
    }
    safeRespond(res, 404, renderErrorPage('Not found.'));
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimeout);
    this.sessions.delete(sessionId);
    setTimeout(() => session.server.close(), 250).unref?.();
  }
}

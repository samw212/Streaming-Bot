import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StreamingBot } from './bot.ts';
import { executeCommand } from './commands.ts';
import { errorMessage, type Logger } from './logger.ts';

export interface ServerOptions {
  host: string;
  port: number;
  /** If set, every /api request needs `Authorization: Bearer <token>`. */
  token?: string;
  logger: Logger;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * REST API + web remote.
 *
 *   GET  /                 web remote
 *   GET  /api/status       what's playing, the queue, settings
 *   GET  /api/search?q=    search results (doesn't affect playback)
 *   POST /api/command      {"command": "add daft punk"}: any REPL command
 *
 * Bound to localhost by default. Because any web page you visit can send requests to
 * localhost, POSTs must be JSON (which browsers can't send cross-site without permission)
 * and the Host and Origin headers are checked.
 */
export async function startServer(bot: StreamingBot, options: ServerOptions): Promise<RunningServer> {
  const page = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
  const log = options.logger;
  const loopbackOnly = LOOPBACK.has(options.host);

  if (!loopbackOnly && !options.token) {
    log.warn(`The API is listening on ${options.host} without a token: anyone who can reach this machine can control playback. Consider --api-token.`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error(`API error on ${req.method} ${req.url}: ${errorMessage(error)}`);
      sendJson(res, status, { ok: false, message: errorMessage(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    checkHost(req, loopbackOnly);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(page);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    checkToken(req, options.token);

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, { ok: true, data: await bot.snapshot() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim();
      if (!query) throw new HttpError(400, 'Missing ?q= search query.');
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      sendJson(res, 200, { ok: true, data: await bot.search(query, limit) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      checkOrigin(req);
      const body = await readJson(req);
      const command = typeof body === 'object' && body !== null ? (body as { command?: unknown }).command : undefined;
      if (typeof command !== 'string' || !command.trim()) {
        throw new HttpError(400, 'Body must be JSON like {"command": "play daft punk"}.');
      }
      const result = await executeCommand(bot, command);
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    throw new HttpError(url.pathname === '/api/command' ? 405 : 404, 'Not found.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Blocks DNS-rebinding: a hostile site can point its own name at 127.0.0.1, but can't fake the Host header. */
function checkHost(req: IncomingMessage, loopbackOnly: boolean): void {
  if (!loopbackOnly) return;
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(host)) throw new HttpError(403, 'Unexpected Host header.');
}

function checkOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Bad Origin header.');
    }
    if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
}

function checkToken(req: IncomingMessage, token: string | undefined): void {
  if (!token) return;
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'Missing or wrong API token.');
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

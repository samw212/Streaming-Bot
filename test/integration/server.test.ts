import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { StreamingBot } from '../../src/bot.ts';
import { silentLogger } from '../../src/logger.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { eventually, startHarness, type Harness } from './helpers.ts';

interface Reply {
  status: number;
  body: { ok?: boolean; message?: string; data?: any };
}

/** Raw HTTP so tests can send the headers browsers would (Origin, odd Host, ...). */
function call(base: string, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let body: Reply['body'] = {};
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text };
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('HTTP API and web remote', () => {
  let h: Harness;
  let bot: StreamingBot;
  let server: RunningServer;
  let secured: RunningServer;

  before(async () => {
    h = await startHarness();
    ({ bot } = await h.newBot());
    server = await startServer(bot, { host: '127.0.0.1', port: 0, logger: silentLogger });
    secured = await startServer(bot, { host: '127.0.0.1', port: 0, token: 's3cret-token', logger: silentLogger });
  });
  after(async () => {
    await server.close();
    await secured.close();
    await h.close();
  });

  it('runs commands and reports status', async () => {
    const played = await call(server.url, 'POST', '/api/command', { body: { command: 'play id:trackRAD001' } });
    assert.equal(played.status, 200);
    assert.equal(played.body.ok, true);
    assert.equal(played.body.data.videoId, 'trackRAD001');

    const status = await call(server.url, 'GET', '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.current.videoId, 'trackRAD001');
    assert.ok(['playing', 'loading'].includes(status.body.data.status));
  });

  it('searches', async () => {
    const reply = await call(server.url, 'GET', '/api/search?q=charlie');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data[0].title, 'Charlie Song');
    assert.equal((await call(server.url, 'GET', '/api/search')).status, 400);
  });

  it('turns command failures into 422 with a readable message', async () => {
    const reply = await call(server.url, 'POST', '/api/command', { body: { command: 'remove 99' } });
    assert.equal(reply.status, 422);
    assert.equal(reply.body.ok, false);
    assert.match(reply.body.message ?? '', /queue is empty|No track at position/);
    assert.equal((await call(server.url, 'POST', '/api/command', { body: { nope: 1 } })).status, 400);
  });

  it('refuses requests a hostile web page could forge', async () => {
    // Cross-site "simple" request: text/plain needs no CORS preflight, so it must be refused.
    const plain = await call(server.url, 'POST', '/api/command', { headers: { 'Content-Type': 'text/plain' }, body: undefined });
    assert.equal(plain.status, 415);

    const crossOrigin = await call(server.url, 'POST', '/api/command', {
      body: { command: 'pause' },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossOrigin.status, 403);

    // DNS rebinding: the request reaches 127.0.0.1 but names another host.
    const rebound = await call(server.url, 'GET', '/api/status', { headers: { Host: 'evil.example:8765' } });
    assert.equal(rebound.status, 403);
  });

  it('requires the token when one is configured', async () => {
    assert.equal((await call(secured.url, 'GET', '/api/status')).status, 401);
    assert.equal((await call(secured.url, 'GET', '/api/status', { headers: { Authorization: 'Bearer wrong-token!' } })).status, 401);
    assert.equal((await call(secured.url, 'GET', '/api/status', { headers: { Authorization: 'Bearer s3cret-token' } })).status, 200);
    // The page itself isn't secret; it asks for the token.
    assert.equal((await call(secured.url, 'GET', '/')).status, 200);
  });

  it('serves a web remote that searches, queues and shows what is playing', async () => {
    await bot.play('id:trackRAD001');
    const page = await h.session.context.newPage();
    try {
      await page.goto(server.url);
      await page.getByText('Radio Pick One').waitFor();
      await page.getByRole('searchbox', { name: 'Search query' }).fill('charlie');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Add Charlie Song to queue' }).click();
      await page.locator('#queue').getByText('Charlie Song').waitFor();
      assert.deepEqual(bot.queue.map((t) => t.videoId), ['trackCCCC03']);

      await page.getByRole('button', { name: 'Next' }).click();
      await eventually(async () => bot.current?.videoId, (id) => id === 'trackCCCC03');
      await page.locator('#title').getByText('Charlie Song').waitFor();
    } finally {
      await page.close();
    }
  });
});

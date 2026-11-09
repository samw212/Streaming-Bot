/**
 * Checks that browser settings really reach Chromium: the command-line switches, the context
 * overrides, and each WebGL mode, observed from inside a page.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { launchBrowser } from '../../src/browser.ts';
import { startBot } from '../../src/index.ts';
import { silentLogger } from '../../src/logger.ts';
import type { BrowserSettings } from '../../src/settings.ts';
import { startFakeYTMusic, type FakeYTMusic } from './fake-ytmusic.ts';
import { eventually, testBrowserSettings } from './helpers.ts';

/** What WebGL looks like from a page: null when unavailable, else the renderer string. */
function probeWebGL(): { webgl: string | null; webgl2: string | null } {
  const renderer = (kind: 'webgl' | 'webgl2') => {
    const gl = document.createElement('canvas').getContext(kind) as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  };
  return { webgl: renderer('webgl'), webgl2: renderer('webgl2') };
}

describe('browser settings reach the browser', () => {
  let dir: string;
  let fake: FakeYTMusic;
  let n = 0;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytm-bot-browser-'));
    fake = await startFakeYTMusic();
  });
  after(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function withBrowser<T>(extra: BrowserSettings, check: (page: import('playwright').Page, args: string[]) => Promise<T>): Promise<T> {
    const session = await launchBrowser(testBrowserSettings(join(dir, `p${n++}`), extra), { muted: true });
    try {
      await session.page.goto(`${fake.url}/`);
      return await check(session.page, session.args);
    } finally {
      await session.close();
    }
  }

  it('applies context overrides', async () => {
    await withBrowser({ context: { locale: 'de-DE', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 } }, async (page) => {
      const seen = await page.evaluate(() => ({
        language: navigator.language,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      assert.deepEqual(seen, { language: 'de-DE', dark: true, reducedMotion: true, width: 900, height: 700, dpr: 2 });
    });
  });

  it('passes extra command-line switches to Chromium', async () => {
    // --disable-3d-apis has an effect a page can see: no WebGL.
    await withBrowser({ args: ['--disable-3d-apis'] }, async (page, args) => {
      assert.ok(args.includes('--disable-3d-apis'));
      assert.deepEqual(await page.evaluate(probeWebGL), { webgl: null, webgl2: null });
    });
  });

  it('webgl: disabled turns WebGL off', async () => {
    await withBrowser({ webgl: 'disabled' }, async (page) => {
      assert.deepEqual(await page.evaluate(probeWebGL), { webgl: null, webgl2: null });
    });
  });

  it('webgl: software renders with SwiftShader', async () => {
    await withBrowser({ webgl: 'software' }, async (page) => {
      const { webgl, webgl2 } = await page.evaluate(probeWebGL);
      assert.match(webgl ?? '', /SwiftShader/);
      assert.match(webgl2 ?? '', /SwiftShader/);
    });
  });

  it('webgl: auto and hardware keep WebGL available', async () => {
    for (const webgl of ['auto', 'hardware'] as const) {
      await withBrowser({ webgl }, async (page) => {
        assert.notEqual((await page.evaluate(probeWebGL)).webgl, null, webgl);
      });
    }
  });

  it('startBot takes a settings dictionary and runs the bot with it', async () => {
    const running = await startBot({
      browser: { ...testBrowserSettings(join(dir, 'startbot')), context: { locale: 'fr-FR' }, webgl: 'disabled' },
      baseUrl: fake.url,
      server: { port: 0 },
      logger: silentLogger,
      launch: { muted: true },
    });
    try {
      assert.equal(running.settings.webgl, 'disabled');
      assert.equal(await running.session.page.evaluate(() => navigator.language), 'fr-FR');
      await running.bot.play('id:trackRAD001');
      const status = await eventually(() => running.bot.snapshot(), (s) => s.status === 'playing');
      assert.equal(status.current?.title, 'Radio Pick One');
      const reply = await fetch(`${running.server!.url}/api/status`);
      assert.equal(reply.status, 200);
    } finally {
      await running.stop();
    }
  });

  it('startBot refuses a disguising dictionary before launching anything', async () => {
    await assert.rejects(
      startBot({ browser: { context: { userAgent: 'Mozilla/5.0' } } as BrowserSettings, logger: silentLogger }),
      /context\.userAgent isn't supported/,
    );
  });
});

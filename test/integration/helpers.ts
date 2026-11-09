import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingBot } from '../../src/bot.ts';
import { launchBrowser, type BrowserSession } from '../../src/browser.ts';
import { silentLogger } from '../../src/logger.ts';
import { resolveBrowserSettings, type BrowserSettings, type ResolvedBrowserSettings } from '../../src/settings.ts';
import { YTMusicDriver } from '../../src/ytmusic/driver.ts';
import type { Track } from '../../src/ytmusic/types.ts';
import { startFakeYTMusic, type FakeYTMusic } from './fake-ytmusic.ts';

/** Headless settings for tests; CHROMIUM_PATH picks a specific browser binary. */
export function testBrowserSettings(userDataDir: string, extra: BrowserSettings = {}): ResolvedBrowserSettings {
  return resolveBrowserSettings({
    userDataDir,
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...extra,
  });
}

export interface Harness {
  fake: FakeYTMusic;
  session: BrowserSession;
  /** A bot on a fresh tab. Closed automatically by `close()`. */
  newBot(options?: { autoplay?: boolean; interactive?: boolean; gateTimeoutMs?: number }): Promise<{ bot: StreamingBot; driver: YTMusicDriver }>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const fake = await startFakeYTMusic();
  const profileDir = await mkdtemp(join(tmpdir(), 'ytm-bot-test-'));
  const session = await launchBrowser(testBrowserSettings(profileDir), { muted: true });
  const bots: StreamingBot[] = [];

  return {
    fake,
    session,
    async newBot(options = {}) {
      const page = await session.context.newPage();
      const driver = new YTMusicDriver(session.context, page, {
        baseUrl: fake.url,
        interactive: options.interactive ?? false,
        gateTimeoutMs: options.gateTimeoutMs ?? 5_000,
        navigationTimeoutMs: 10_000,
        logger: silentLogger,
      });
      const bot = new StreamingBot(driver, { autoplay: options.autoplay ?? true, logger: silentLogger, pollIntervalMs: 250 });
      await bot.start();
      bots.push(bot);
      return { bot, driver };
    },
    async close() {
      for (const bot of bots) bot.stop();
      await session.close();
      await fake.close();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

/** Resolves with the next track the bot switches to that matches `predicate`. */
export function nextTrack(bot: StreamingBot, predicate: (t: Track) => boolean, timeoutMs = 10_000): Promise<Track> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.off('trackchange', onChange);
      reject(new Error(`No matching track change within ${timeoutMs} ms (current: ${bot.current?.videoId ?? 'none'})`));
    }, timeoutMs);
    const onChange = (track: Track) => {
      if (!predicate(track)) return;
      clearTimeout(timer);
      bot.off('trackchange', onChange);
      resolve(track);
    };
    bot.on('trackchange', onChange);
  });
}

export function nextEvent(bot: StreamingBot, event: 'idle', timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No "${event}" event within ${timeoutMs} ms`)), timeoutMs);
    bot.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value)) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

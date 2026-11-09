import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { errorMessage } from './logger.ts';

export interface BrowserOptions {
  /** Persistent profile directory: keeps your sign-in, cookie choices and YouTube Music settings. */
  profileDir: string;
  /**
   * Headless mode is mostly for tests against a local page. YouTube Music itself serves a
   * "browser not supported" page to headless Chromium, and you can't hear it anyway; on a
   * machine without a display, run the bot under Xvfb instead (see README).
   */
  headless: boolean;
  /** Use an installed browser instead of Playwright's Chromium, e.g. "chrome" or "msedge". */
  channel?: string;
  executablePath?: string;
  /** Keep Chromium muted (Playwright's default). Tests use this; the bot unmutes so you can listen. */
  muted?: boolean;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launchBrowser(options: BrowserOptions): Promise<BrowserSession> {
  await mkdir(options.profileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      // A visible window sizes itself; a headless one needs a viewport.
      viewport: options.headless ? { width: 1280, height: 800 } : null,
      // Music should start when the bot asks for it, not wait for a click.
      args: ['--autoplay-policy=no-user-gesture-required'],
      // Playwright launches Chromium muted by default.
      ...(options.muted ? {} : { ignoreDefaultArgs: ['--mute-audio'] }),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(message)) {
      throw new Error(`The browser profile at ${options.profileDir} is already in use. Close the other bot or browser using it, or pass --profile <dir>.`);
    }
    if (/Executable doesn't exist|browserType\.launch.*install/i.test(message)) {
      throw new Error(`Playwright's browser isn't installed. Run "npx playwright install chromium" (or use --channel chrome).\n${message}`);
    }
    throw error;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

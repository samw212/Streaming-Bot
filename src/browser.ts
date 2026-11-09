import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { errorMessage } from './logger.ts';
import { buildArgs, buildContextOptions, type ResolvedBrowserSettings } from './settings.ts';

export interface LaunchOptions {
  /** Keep Chromium muted (Playwright's default). Tests use this; the bot unmutes so you can listen. */
  muted?: boolean;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** The Chromium switches the browser was started with, after merging. */
  args: string[];
  close(): Promise<void>;
}

/**
 * Starts a persistent browser from resolved settings: the browser-level command line from
 * `buildArgs`, and the context-level overrides from `buildContextOptions`.
 *
 * Headless mode is mostly for tests against a local page. YouTube Music itself serves a
 * "browser not supported" page to headless Chromium, and you can't hear it anyway; on a
 * machine without a display, run the bot under Xvfb instead (see README).
 */
export async function launchBrowser(settings: ResolvedBrowserSettings, options: LaunchOptions = {}): Promise<BrowserSession> {
  await mkdir(settings.userDataDir, { recursive: true });
  const args = buildArgs(settings);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(settings.userDataDir, {
      headless: settings.headless,
      ...(settings.channel ? { channel: settings.channel } : {}),
      ...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
      args,
      ...buildContextOptions(settings),
      // Playwright launches Chromium muted by default.
      ...(options.muted ? {} : { ignoreDefaultArgs: ['--mute-audio'] }),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(message)) {
      throw new Error(`The browser data directory ${settings.userDataDir} is already in use. Close the other bot or browser using it, or choose another profile.`);
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
    args,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

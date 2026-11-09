/**
 * Programmatic entry point: start the bot from code with a settings dictionary.
 *
 *   import { startBot } from './src/index.ts';
 *
 *   const { bot, stop } = await startBot({
 *     browser: { webgl: 'disabled', args: ['--alsa-output-device=hw:1,0'], context: { locale: 'de-DE' } },
 *     server: { port: 8765 },
 *   });
 *   await bot.play('daft punk get lucky');
 */
import { StreamingBot } from './bot.ts';
import { launchBrowser, type BrowserSession, type LaunchOptions } from './browser.ts';
import { createLogger, type Logger } from './logger.ts';
import { startServer, type RunningServer } from './server.ts';
import { loadBrowserSettings, type BrowserSettings, type ResolvedBrowserSettings } from './settings.ts';
import { YTMusicDriver } from './ytmusic/driver.ts';
import { DEFAULT_BASE_URL } from './ytmusic/selectors.ts';

export interface StartBotOptions {
  /** Browser settings dictionary. Applied over the profile, if one is used. */
  browser?: BrowserSettings;
  /** Named profile from the config file. */
  profile?: string;
  /** Config file with profiles. If a profile is named without one, ~/.ytm-bot/config.json is used. */
  configPath?: string;
  baseUrl?: string;
  autoplay?: boolean;
  /** Volume (0-100) to play at; YouTube Music's own setting otherwise. */
  volume?: number;
  /** REST API and web remote; off unless given. */
  server?: { host?: string; port?: number; token?: string };
  /** How long to wait for a person to clear a CAPTCHA or consent page in the window. */
  gateTimeoutMs?: number;
  logger?: Logger;
  /** Low-level launch options (tests use `muted`). */
  launch?: LaunchOptions;
}

export interface RunningBot {
  bot: StreamingBot;
  session: BrowserSession;
  server: RunningServer | null;
  settings: ResolvedBrowserSettings;
  /** Name of the profile in use, if any. */
  profile?: string;
  stop(): Promise<void>;
}

export async function startBot(options: StartBotOptions = {}): Promise<RunningBot> {
  const log = options.logger ?? createLogger('info');
  const loaded = await loadBrowserSettings({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.browser ? { overrides: options.browser } : {}),
  });
  const { settings } = loaded;
  if (loaded.profile) log.info(`Browser profile "${loaded.profile}" from ${loaded.configPath}`);

  const session = await launchBrowser(settings, options.launch);
  log.debug(`Browser data: ${settings.userDataDir}`);
  log.debug(`Browser switches: ${session.args.join(' ')}`);

  let server: RunningServer | null = null;
  const bot = new StreamingBot(
    new YTMusicDriver(session.context, session.page, {
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      interactive: !settings.headless,
      gateTimeoutMs: options.gateTimeoutMs ?? 300_000,
      navigationTimeoutMs: 30_000,
      logger: log,
    }),
    {
      autoplay: options.autoplay ?? true,
      logger: log,
      ...(options.volume !== undefined ? { initialVolume: options.volume } : {}),
    },
  );

  const stop = async () => {
    bot.stop();
    await server?.close();
    await session.close();
  };

  try {
    await bot.start();
    if (options.server) {
      server = await startServer(bot, {
        host: options.server.host ?? '127.0.0.1',
        port: options.server.port ?? 8765,
        logger: log,
        ...(options.server.token ? { token: options.server.token } : {}),
      });
    }
  } catch (error) {
    await stop();
    throw error;
  }

  const running: RunningBot = { bot, session, server, settings, stop };
  if (loaded.profile) running.profile = loaded.profile;
  return running;
}

export { StreamingBot } from './bot.ts';
export type { BotSnapshot, BotStatus } from './bot.ts';
export { executeCommand } from './commands.ts';
export {
  loadBrowserSettings,
  loadConfigFile,
  validateBrowserSettings,
  WEBGL_MODES,
  type BrowserSettings,
  type ConfigFile,
  type ContextOverrides,
  type ResolvedBrowserSettings,
  type WebGLMode,
} from './settings.ts';
export type { Track, PlayerState } from './ytmusic/types.ts';

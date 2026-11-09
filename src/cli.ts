#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { launchBrowser, type BrowserSession } from './browser.ts';
import { formatTrack } from './commands.ts';
import { HELP, resolveConfig, type Config } from './config.ts';
import { startBot } from './index.ts';
import { createLogger, errorMessage, type Logger } from './logger.ts';
import { startRepl } from './repl.ts';
import { defaultConfigPathIfPresent, loadBrowserSettings } from './settings.ts';
import { YTMusicDriver } from './ytmusic/driver.ts';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = resolveConfig(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\nRun "ytm-bot --help" for usage.\n`);
    process.exitCode = 2;
    return;
  }

  if (config.mode === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (config.mode === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const log = createLogger(config.logLevel);
  const configPath = config.configPath ?? defaultConfigPathIfPresent();
  if (config.mode === 'start') {
    await run(config, configPath, log);
    return;
  }

  const { settings, profile } = await loadBrowserSettings({
    ...(configPath ? { configPath } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
    overrides: config.browser,
  });
  if (config.mode === 'login' && settings.headless) {
    throw new Error(`Signing in needs a visible browser window, but profile "${profile}" is headless.`);
  }
  const session = await launchBrowser(settings);
  try {
    if (config.mode === 'login') await login(session, settings.userDataDir, config, log);
    else await searchOnce(session, config, log);
  } finally {
    await session.close();
  }
}

async function login(session: BrowserSession, userDataDir: string, config: Config, log: Logger): Promise<void> {
  await session.page.goto(config.baseUrl);
  log.info('Sign in with the "Sign in" button in the YouTube Music window, then close the window.');
  log.info(`Your session is saved in ${userDataDir} for next time.`);
  log.info('If Google says the browser may not be secure, try "--channel chrome", or just use the bot signed out.');
  await new Promise<void>((resolve) => session.context.on('close', () => resolve()));
}

async function searchOnce(session: BrowserSession, config: Config, log: Logger): Promise<void> {
  const driver = new YTMusicDriver(session.context, session.page, {
    baseUrl: config.baseUrl,
    interactive: false,
    gateTimeoutMs: config.gateTimeoutMs,
    navigationTimeoutMs: 30_000,
    logger: log,
  });
  const results = await driver.search(config.items[0]!, 10);
  if (results.length === 0) process.stdout.write('No playable results.\n');
  results.forEach((t, i) => {
    const kind = t.kind ? `  [${t.kind}]` : '';
    process.stdout.write(`${String(i + 1).padStart(2)}. ${formatTrack(t)}${kind}\n    ${config.baseUrl}/watch?v=${t.videoId}\n`);
  });
}

async function run(config: Config, configPath: string | undefined, log: Logger): Promise<void> {
  const running = await startBot({
    browser: config.browser,
    ...(configPath ? { configPath } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
    baseUrl: config.baseUrl,
    autoplay: config.autoplay,
    ...(config.volume !== undefined ? { volume: config.volume } : {}),
    ...(config.server
      ? { server: { host: config.host, port: config.port, ...(config.apiToken ? { token: config.apiToken } : {}) } }
      : {}),
    gateTimeoutMs: config.gateTimeoutMs,
    logger: log,
  });
  const { bot, server, session } = running;

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${reason}).`);
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('interrupted'));
  process.on('SIGTERM', () => void shutdown('terminated'));
  session.context.on('close', () => void shutdown('browser closed'));

  log.info('YouTube Music is open.');
  if (server) {
    const tokenHint = config.apiToken ? '#token=<your token>' : '';
    log.info(`Web remote: ${server.url}/${tokenHint}  ·  API: ${server.url}/api/status`);
  }

  const interactive = config.repl && process.stdin.isTTY;
  if (!interactive) bot.on('trackchange', (track) => log.info(`Now playing: ${formatTrack(track)}`));
  bot.on('error', (error) => log.debug(`Bot error: ${error.message}`));

  for (const item of config.items) {
    try {
      const { track, started } = await bot.enqueue(item);
      if (!started) log.info(`Queued: ${formatTrack(track)}`);
    } catch (error) {
      log.error(`Couldn't queue "${item}": ${errorMessage(error)}`);
    }
  }

  if (interactive) startRepl(bot, { logger: log, onQuit: () => void shutdown('quit') });
  else log.info('Running without a terminal prompt; stop with Ctrl+C.');
}

main().catch((error) => {
  process.stderr.write(`ytm-bot: ${errorMessage(error)}\n`);
  process.exit(1);
});

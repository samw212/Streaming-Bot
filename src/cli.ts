#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StreamingBot } from './bot.ts';
import { launchBrowser, type BrowserSession } from './browser.ts';
import { formatTrack } from './commands.ts';
import { HELP, resolveConfig, type Config } from './config.ts';
import { createLogger, errorMessage, type Logger } from './logger.ts';
import { startRepl } from './repl.ts';
import { startServer, type RunningServer } from './server.ts';
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
  log.debug(`Using profile ${config.profileDir}`);
  const session = await launchBrowser({
    profileDir: config.profileDir,
    headless: config.headless,
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
  });

  try {
    if (config.mode === 'login') await login(session, config, log);
    else if (config.mode === 'search') await searchOnce(session, config, log);
    else await run(session, config, log);
  } catch (error) {
    await session.close();
    throw error;
  }
}

function makeDriver(session: BrowserSession, config: Config, log: Logger): YTMusicDriver {
  return new YTMusicDriver(session.context, session.page, {
    baseUrl: config.baseUrl,
    interactive: !config.headless,
    gateTimeoutMs: config.gateTimeoutMs,
    navigationTimeoutMs: 30_000,
    logger: log,
  });
}

async function login(session: BrowserSession, config: Config, log: Logger): Promise<void> {
  await session.page.goto(config.baseUrl);
  log.info('Sign in with the "Sign in" button in the YouTube Music window, then close the window.');
  log.info(`Your session is saved in ${config.profileDir} for next time.`);
  log.info('If Google says the browser may not be secure, try "--channel chrome", or just use the bot signed out.');
  await new Promise<void>((resolve) => session.context.on('close', () => resolve()));
}

async function searchOnce(session: BrowserSession, config: Config, log: Logger): Promise<void> {
  const driver = makeDriver(session, config, log);
  const results = await driver.search(config.items[0]!, 10);
  if (results.length === 0) process.stdout.write('No playable results.\n');
  results.forEach((t, i) => {
    const kind = t.kind ? `  [${t.kind}]` : '';
    process.stdout.write(`${String(i + 1).padStart(2)}. ${formatTrack(t)}${kind}\n    ${config.baseUrl}/watch?v=${t.videoId}\n`);
  });
  await session.close();
}

async function run(session: BrowserSession, config: Config, log: Logger): Promise<void> {
  const bot = new StreamingBot(makeDriver(session, config, log), {
    autoplay: config.autoplay,
    logger: log,
    ...(config.volume !== undefined ? { initialVolume: config.volume } : {}),
  });

  let server: RunningServer | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${reason}).`);
    bot.stop();
    await server?.close();
    await session.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('interrupted'));
  process.on('SIGTERM', () => void shutdown('terminated'));
  session.context.on('close', () => void shutdown('browser closed'));

  await bot.start();
  log.info('YouTube Music is open.');

  if (!config.repl || !process.stdin.isTTY) {
    bot.on('trackchange', (track) => log.info(`Now playing: ${formatTrack(track)}`));
  }
  bot.on('error', (error) => log.debug(`Bot error: ${error.message}`));

  if (config.server) {
    server = await startServer(bot, {
      host: config.host,
      port: config.port,
      logger: log,
      ...(config.apiToken ? { token: config.apiToken } : {}),
    });
    const tokenHint = config.apiToken ? '#token=<your token>' : '';
    log.info(`Web remote: ${server.url}/${tokenHint}  ·  API: ${server.url}/api/status`);
  }

  for (const item of config.items) {
    try {
      const { track, started } = await bot.enqueue(item);
      if (!started) log.info(`Queued: ${formatTrack(track)}`);
    } catch (error) {
      log.error(`Couldn't queue "${item}": ${errorMessage(error)}`);
    }
  }

  if (config.repl && process.stdin.isTTY) {
    startRepl(bot, { logger: log, onQuit: () => void shutdown('quit') });
  } else {
    log.info('Running without a terminal prompt; stop with Ctrl+C.');
  }
}

main().catch((error) => {
  process.stderr.write(`ytm-bot: ${errorMessage(error)}\n`);
  process.exit(1);
});

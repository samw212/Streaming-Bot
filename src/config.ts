import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isLogLevel, type LogLevel } from './logger.ts';
import { DEFAULT_BASE_URL } from './ytmusic/selectors.ts';

export type Mode = 'start' | 'login' | 'search' | 'help' | 'version';

export interface Config {
  mode: Mode;
  /** Things to queue at startup (start mode) or the search query (search mode). */
  items: string[];
  profileDir: string;
  headless: boolean;
  channel?: string;
  executablePath?: string;
  baseUrl: string;
  server: boolean;
  host: string;
  port: number;
  apiToken?: string;
  repl: boolean;
  autoplay: boolean;
  volume?: number;
  logLevel: LogLevel;
  gateTimeoutMs: number;
}

export const HELP = `ytm-bot: a YouTube Music player you control from the terminal, a REST API, or a web remote.

Usage:
  ytm-bot [options] [song | url ...]   Start the player, queueing anything given
  ytm-bot login [options]              Open the browser so you can sign in to YouTube Music
  ytm-bot search [options] <query>     Print search results and exit

Options:
  --profile <dir>        Browser profile to use (default: ~/.ytm-bot/profile)   [YTM_BOT_PROFILE]
  --channel <name>       Use an installed browser: chrome, msedge, ...           [YTM_BOT_CHANNEL]
  --executable-path <p>  Path to a Chromium-based browser binary
  --port <n>             Port for the API and web remote (default: 8765)         [YTM_BOT_PORT]
  --host <addr>          Address to listen on (default: 127.0.0.1)               [YTM_BOT_HOST]
  --api-token <token>    Require "Authorization: Bearer <token>" on the API      [YTM_BOT_API_TOKEN]
  --no-server            Don't start the API / web remote
  --no-repl              Don't read commands from the terminal (for services)
  --no-autoplay          Stop when the queue runs out instead of continuing with YouTube Music's picks
  --volume <0-100>       Volume to start at
  --gate-timeout <sec>   How long to wait for you to clear a CAPTCHA/consent page (default: 300)
  --log-level <level>    debug, info, warn, error or silent (default: info)      [YTM_BOT_LOG_LEVEL]
  --headless             Run without a window (testing only; YouTube Music rejects headless browsers)
  --base-url <url>       YouTube Music URL (default: ${DEFAULT_BASE_URL})       [YTM_BOT_BASE_URL]
  -h, --help             Show this help
  --version              Show the version

Examples:
  ytm-bot "daft punk get lucky" "https://music.youtube.com/watch?v=5NV6Rdv1a3I"
  ytm-bot --no-repl --port 9000 --api-token secret
  curl -X POST localhost:8765/api/command -H 'Content-Type: application/json' -d '{"command":"next"}'
`;

const MODES = new Set(['start', 'login', 'search']);

export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      profile: { type: 'string' },
      channel: { type: 'string' },
      'executable-path': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'api-token': { type: 'string' },
      server: { type: 'boolean', default: true },
      repl: { type: 'boolean', default: true },
      autoplay: { type: 'boolean', default: true },
      volume: { type: 'string' },
      'gate-timeout': { type: 'string' },
      'log-level': { type: 'string' },
      headless: { type: 'boolean' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  let mode: Mode = 'start';
  let items = positionals;
  if (items[0] && MODES.has(items[0])) {
    mode = items[0] as Mode;
    items = items.slice(1);
  }
  if (values.help) mode = 'help';
  else if (values.version) mode = 'version';

  if (mode === 'search' && items.length === 0) throw new Error('Usage: ytm-bot search <query>');

  const logLevel = values['log-level'] ?? env.YTM_BOT_LOG_LEVEL ?? 'info';
  if (!isLogLevel(logLevel)) throw new Error(`Unknown log level "${logLevel}".`);

  const baseUrl = (values['base-url'] ?? env.YTM_BOT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`--base-url "${baseUrl}" is not a URL.`);
  }

  const volume = values.volume === undefined ? undefined : integer(values.volume, '--volume', 0, 100);
  const channel = values.channel ?? env.YTM_BOT_CHANNEL;
  const executablePath = values['executable-path'];
  const apiToken = values['api-token'] ?? env.YTM_BOT_API_TOKEN;

  const config: Config = {
    mode,
    items: mode === 'search' ? [items.join(' ')] : items,
    profileDir: resolve(values.profile ?? env.YTM_BOT_PROFILE ?? join(homedir(), '.ytm-bot', 'profile')),
    headless: values.headless ?? truthy(env.YTM_BOT_HEADLESS),
    baseUrl,
    server: values.server && mode === 'start',
    host: values.host ?? env.YTM_BOT_HOST ?? '127.0.0.1',
    port: integer(values.port ?? env.YTM_BOT_PORT ?? '8765', '--port', 0, 65535),
    repl: values.repl && mode === 'start',
    autoplay: values.autoplay,
    logLevel,
    gateTimeoutMs: integer(values['gate-timeout'] ?? '300', '--gate-timeout', 1, 86_400) * 1000,
  };
  if (channel) config.channel = channel;
  if (executablePath) config.executablePath = resolve(executablePath);
  if (apiToken) config.apiToken = apiToken;
  if (volume !== undefined) config.volume = volume;

  if (mode === 'login' && config.headless) throw new Error('Signing in needs a visible browser window; drop --headless.');
  return config;
}

function integer(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value);
}

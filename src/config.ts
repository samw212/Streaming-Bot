import { parseArgs } from 'node:util';
import { errorMessage, isLogLevel, type LogLevel } from './logger.ts';
import { DEFAULT_CONFIG_PATH, SettingsError, validateBrowserSettings, WEBGL_MODES, type BrowserSettings } from './settings.ts';
import { DEFAULT_BASE_URL } from './ytmusic/selectors.ts';

export type Mode = 'start' | 'login' | 'search' | 'help' | 'version';

export interface Config {
  mode: Mode;
  /** Things to queue at startup (start mode) or the search query (search mode). */
  items: string[];
  /** Config file with browser profiles. */
  configPath?: string;
  /** Named browser profile from the config file. */
  profile?: string;
  /** Browser settings given as flags; applied over the config file and profile. */
  browser: BrowserSettings;
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

Browser:
  --config <file>          Config file with browser settings and profiles       [YTM_BOT_CONFIG]
                           (default: ${DEFAULT_CONFIG_PATH}, if it exists)
  --profile <name>         Browser profile from the config file to use          [YTM_BOT_PROFILE]
  --user-data-dir <dir>    Browser data directory (default: ~/.ytm-bot/profile,  [YTM_BOT_USER_DATA_DIR]
                           or ~/.ytm-bot/profiles/<name> for a named profile)
  --channel <name>         Use an installed browser: chrome, msedge, ...        [YTM_BOT_CHANNEL]
  --executable-path <p>    Path to a Chromium-based browser binary
  --browser-arg=<switch>   Extra Chromium switch; repeatable, e.g. --browser-arg=--start-maximized
  --locale <tag>           Interface language, e.g. de-DE
  --webgl <mode>           ${WEBGL_MODES.join(' | ')} (default: auto)               [YTM_BOT_WEBGL]
  --headless               No window (testing only; YouTube Music rejects headless browsers)

Player:
  --port <n>               Port for the API and web remote (default: 8765)      [YTM_BOT_PORT]
  --host <addr>            Address to listen on (default: 127.0.0.1)            [YTM_BOT_HOST]
  --api-token <token>      Require "Authorization: Bearer <token>" on the API   [YTM_BOT_API_TOKEN]
  --no-server              Don't start the API / web remote
  --no-repl                Don't read commands from the terminal (for services)
  --no-autoplay            Stop when the queue runs out instead of continuing with YouTube Music's picks
  --volume <0-100>         Volume to play at
  --gate-timeout <sec>     How long to wait for you to clear a CAPTCHA/consent page (default: 300)
  --log-level <level>      debug, info, warn, error or silent (default: info)   [YTM_BOT_LOG_LEVEL]
  --base-url <url>         YouTube Music URL (default: ${DEFAULT_BASE_URL})    [YTM_BOT_BASE_URL]
  -h, --help               Show this help
  --version                Show the version

Examples:
  ytm-bot "daft punk get lucky" "https://music.youtube.com/watch?v=5NV6Rdv1a3I"
  ytm-bot --profile pi --no-repl --host 0.0.0.0 --api-token secret
  ytm-bot --webgl disabled --browser-arg=--alsa-output-device=hw:1,0
  curl -X POST localhost:8765/api/command -H 'Content-Type: application/json' -d '{"command":"next"}'
`;

const MODES = new Set(['start', 'login', 'search']);

/** Maps setting paths back to the flags they came from, for error messages. */
const FLAG_FOR_SETTING: Array<[RegExp, string]> = [
  [/^flags\.args\[\d+\]/, '--browser-arg'],
  [/^flags\.context\.locale/, '--locale'],
  [/^flags\.webgl/, '--webgl'],
  [/^flags\.channel/, '--channel'],
  [/^flags\.executablePath/, '--executable-path'],
  [/^flags\.userDataDir/, '--user-data-dir'],
];

export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      config: { type: 'string' },
      profile: { type: 'string' },
      'user-data-dir': { type: 'string' },
      channel: { type: 'string' },
      'executable-path': { type: 'string' },
      'browser-arg': { type: 'string', multiple: true },
      locale: { type: 'string' },
      webgl: { type: 'string' },
      headless: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      'api-token': { type: 'string' },
      server: { type: 'boolean', default: true },
      repl: { type: 'boolean', default: true },
      autoplay: { type: 'boolean', default: true },
      volume: { type: 'string' },
      'gate-timeout': { type: 'string' },
      'log-level': { type: 'string' },
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

  const config: Config = {
    mode,
    items: mode === 'search' ? [items.join(' ')] : items,
    browser: browserFlags(values, env),
    baseUrl,
    server: values.server && mode === 'start',
    host: values.host ?? env.YTM_BOT_HOST ?? '127.0.0.1',
    port: integer(values.port ?? env.YTM_BOT_PORT ?? '8765', '--port', 0, 65535),
    repl: values.repl && mode === 'start',
    autoplay: values.autoplay,
    logLevel,
    gateTimeoutMs: integer(values['gate-timeout'] ?? '300', '--gate-timeout', 1, 86_400) * 1000,
  };
  const configPath = values.config ?? env.YTM_BOT_CONFIG;
  const profile = values.profile ?? env.YTM_BOT_PROFILE;
  const apiToken = values['api-token'] ?? env.YTM_BOT_API_TOKEN;
  if (configPath) config.configPath = configPath;
  if (profile) config.profile = profile;
  if (apiToken) config.apiToken = apiToken;
  if (values.volume !== undefined) config.volume = integer(values.volume, '--volume', 0, 100);

  if (mode === 'login' && config.browser.headless) throw new Error('Signing in needs a visible browser window; drop --headless.');
  return config;
}

/** Browser settings from flags and environment variables, validated like any other settings. */
function browserFlags(
  values: {
    'user-data-dir'?: string | undefined;
    channel?: string | undefined;
    'executable-path'?: string | undefined;
    'browser-arg'?: string[] | undefined;
    locale?: string | undefined;
    webgl?: string | undefined;
    headless?: boolean | undefined;
  },
  env: NodeJS.ProcessEnv,
): BrowserSettings {
  const raw: Record<string, unknown> = {};
  const userDataDir = values['user-data-dir'] ?? env.YTM_BOT_USER_DATA_DIR;
  const channel = values.channel ?? env.YTM_BOT_CHANNEL;
  const webgl = values.webgl ?? env.YTM_BOT_WEBGL;
  const headless = values.headless ?? (env.YTM_BOT_HEADLESS === undefined ? undefined : truthy(env.YTM_BOT_HEADLESS));
  if (userDataDir) raw.userDataDir = userDataDir;
  if (channel) raw.channel = channel;
  if (values['executable-path']) raw.executablePath = values['executable-path'];
  if (values['browser-arg']?.length) raw.args = values['browser-arg'];
  if (values.locale) raw.context = { locale: values.locale };
  if (webgl) raw.webgl = webgl;
  if (headless !== undefined) raw.headless = headless;

  try {
    return validateBrowserSettings(raw, 'flags');
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    let message = errorMessage(error);
    for (const [pattern, flag] of FLAG_FOR_SETTING) message = message.replace(pattern, flag);
    throw new Error(message);
  }
}

function integer(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function truthy(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value);
}

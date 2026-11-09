/**
 * Browser settings: a validated dictionary of how to launch the browser, optionally loaded from a
 * config file of named profiles.
 *
 *   {
 *     "browser":        { ...settings shared by every profile... },
 *     "defaultProfile": "desktop",
 *     "profiles":       { "desktop": { ...settings... }, "pi": { ... } }
 *   }
 *
 * Layers merge in order: built-in defaults < "browser" < the chosen profile < explicit overrides
 * (command-line flags or a dictionary passed to startBot). Scalars are replaced, `args` are
 * appended, and `context` is merged key by key.
 *
 * The bot runs as an ordinary browser that doesn't pretend to be anything else, so settings that
 * exist to disguise it (user agent, timezone, location or proxy overrides, and switches that hide
 * automation) are rejected with an explanation instead of being passed through.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorMessage } from './logger.ts';

export const WEBGL_MODES = ['auto', 'hardware', 'software', 'disabled'] as const;
/**
 * How the browser renders WebGL (YouTube Music itself barely uses it):
 *  - auto:     Chromium decides.
 *  - hardware: use the GPU even if Chromium has blocklisted its driver (visible windows only).
 *  - software: render with SwiftShader on the CPU, for machines without a usable GPU.
 *  - disabled: turn WebGL off entirely, e.g. to save resources on a Raspberry Pi.
 */
export type WebGLMode = (typeof WEBGL_MODES)[number];

export const WEBGL_ARGS: Record<WebGLMode, string[]> = {
  auto: [],
  hardware: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  software: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  disabled: ['--disable-3d-apis'],
};

const COLOR_SCHEMES = ['light', 'dark', 'no-preference'] as const;
const REDUCED_MOTION = ['reduce', 'no-preference'] as const;

/** Overrides applied to the browser context (Playwright's context options). */
export interface ContextOverrides {
  /** Language for YouTube Music's interface and the Accept-Language header, e.g. "de-DE". */
  locale?: string;
  colorScheme?: (typeof COLOR_SCHEMES)[number];
  reducedMotion?: (typeof REDUCED_MOTION)[number];
  /** Fixed page size; null follows the window size. Defaults to null in a window, 1280x800 headless. */
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
}

export interface BrowserSettings {
  /** Browser data directory (sign-in, cookies, YouTube Music preferences). */
  userDataDir?: string;
  /** Installed browser to use instead of Playwright's Chromium: "chrome", "msedge", ... */
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  /** Extra Chromium command-line switches, e.g. "--alsa-output-device=hw:1,0". */
  args?: string[];
  context?: ContextOverrides;
  webgl?: WebGLMode;
}

export interface ConfigFile {
  browser?: BrowserSettings;
  defaultProfile?: string;
  profiles?: Record<string, BrowserSettings>;
}

/** Settings with every default filled in: what launchBrowser actually uses. */
export interface ResolvedBrowserSettings {
  userDataDir: string;
  headless: boolean;
  webgl: WebGLMode;
  args: string[];
  context: ContextOverrides;
  channel?: string;
  executablePath?: string;
}

export class SettingsError extends Error {
  override name = 'SettingsError';
}

export const BOT_HOME = join(homedir(), '.ytm-bot');
export const DEFAULT_CONFIG_PATH = join(BOT_HOME, 'config.json');

/** Each named profile gets its own data directory unless it says otherwise. */
export function defaultUserDataDir(profile?: string): string {
  return profile ? join(BOT_HOME, 'profiles', profile) : join(BOT_HOME, 'profile');
}

// ---------------------------------------------------------------------------------- validation

const SETTINGS_KEYS = ['userDataDir', 'channel', 'executablePath', 'headless', 'args', 'context', 'webgl'];
const CONTEXT_KEYS = ['locale', 'colorScheme', 'reducedMotion', 'viewport', 'deviceScaleFactor'];
const CONFIG_KEYS = ['browser', 'defaultProfile', 'profiles', '$schema'];

const NOT_DISGUISED = 'the bot runs as an ordinary browser and does not disguise its identity, location or network';
const DISGUISE_CONTEXT_KEYS = new Set(['userAgent', 'timezoneId', 'geolocation', 'proxy', 'extraHTTPHeaders']);
const DISGUISE_SWITCHES = new Set(['--user-agent', '--proxy-server', '--proxy-pac-url', '--proxy-auto-detect']);
const MANAGED_SWITCHES: Record<string, string> = {
  '--user-data-dir': 'use the "userDataDir" setting instead',
  '--headless': 'use the "headless" setting instead',
  '--remote-debugging-port': 'Playwright manages its own connection to the browser',
  '--remote-debugging-pipe': 'Playwright manages its own connection to the browser',
};

/** "--foo=bar" -> "--foo". */
export function switchName(arg: string): string {
  return (arg.split('=')[0] ?? arg).toLowerCase();
}

/** Checks a settings dictionary and returns a clean copy. `path` names it in error messages. */
export function validateBrowserSettings(value: unknown, path = 'browser'): BrowserSettings {
  const input = asObject(value, path);
  const out: BrowserSettings = {};
  for (const [key, v] of Object.entries(input)) {
    const at = `${path}.${key}`;
    switch (key) {
      case 'userDataDir':
        out.userDataDir = asString(v, at);
        break;
      case 'channel':
        out.channel = asString(v, at);
        break;
      case 'executablePath':
        out.executablePath = asString(v, at);
        break;
      case 'headless':
        out.headless = asBoolean(v, at);
        break;
      case 'args':
        out.args = asArray(v, at).map((arg, i) => checkSwitch(asString(arg, `${at}[${i}]`), `${at}[${i}]`));
        break;
      case 'context':
        out.context = validateContext(v, at);
        break;
      case 'webgl':
        out.webgl = asOneOf(v, WEBGL_MODES, at);
        break;
      default:
        throw new SettingsError(`${at} is not a browser setting. Supported: ${SETTINGS_KEYS.join(', ')}.`);
    }
  }
  return out;
}

function validateContext(value: unknown, path: string): ContextOverrides {
  const input = asObject(value, path);
  const out: ContextOverrides = {};
  for (const [key, v] of Object.entries(input)) {
    const at = `${path}.${key}`;
    switch (key) {
      case 'locale':
        out.locale = asString(v, at);
        if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(out.locale)) {
          throw new SettingsError(`${at} must be a language tag like "en-US" (got "${out.locale}").`);
        }
        break;
      case 'colorScheme':
        out.colorScheme = asOneOf(v, COLOR_SCHEMES, at);
        break;
      case 'reducedMotion':
        out.reducedMotion = asOneOf(v, REDUCED_MOTION, at);
        break;
      case 'viewport': {
        if (v === null) {
          out.viewport = null;
          break;
        }
        const size = asObject(v, at);
        const extra = Object.keys(size).filter((k) => k !== 'width' && k !== 'height');
        if (extra.length) throw new SettingsError(`${at} only takes width and height (got ${extra.join(', ')}).`);
        out.viewport = { width: asInteger(size.width, `${at}.width`, 200, 7680), height: asInteger(size.height, `${at}.height`, 200, 4320) };
        break;
      }
      case 'deviceScaleFactor':
        out.deviceScaleFactor = asNumber(v, at, 0.5, 4);
        break;
      default:
        if (DISGUISE_CONTEXT_KEYS.has(key)) throw new SettingsError(`${at} isn't supported: ${NOT_DISGUISED}.`);
        throw new SettingsError(`${at} is not a supported context override. Supported: ${CONTEXT_KEYS.join(', ')}.`);
    }
  }
  return out;
}

function checkSwitch(arg: string, at: string): string {
  if (!/^--[a-z0-9]/i.test(arg)) {
    throw new SettingsError(`${at} ("${arg}") must be a Chromium switch starting with "--".`);
  }
  const name = switchName(arg);
  const managed = MANAGED_SWITCHES[name];
  if (managed) throw new SettingsError(`${at}: ${name} can't be set as an argument; ${managed}.`);
  if (DISGUISE_SWITCHES.has(name) || /automationcontrolled/i.test(arg)) {
    throw new SettingsError(`${at}: ${name} isn't supported: ${NOT_DISGUISED}.`);
  }
  return arg;
}

export function validateConfig(value: unknown): ConfigFile {
  const input = asObject(value, 'config');
  const unknown = Object.keys(input).filter((k) => !CONFIG_KEYS.includes(k));
  if (unknown.length) {
    throw new SettingsError(`Unknown top-level key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. Supported: browser, defaultProfile, profiles.`);
  }

  const config: ConfigFile = {};
  if (input.browser !== undefined) config.browser = validateBrowserSettings(input.browser, 'browser');
  if (input.profiles !== undefined) {
    config.profiles = {};
    for (const [name, settings] of Object.entries(asObject(input.profiles, 'profiles'))) {
      if (!/^[\w.-]+$/.test(name)) {
        throw new SettingsError(`Profile name "${name}" may only use letters, digits, ".", "_" and "-" (it names a folder).`);
      }
      config.profiles[name] = validateBrowserSettings(settings, `profiles.${name}`);
    }
  }
  if (input.defaultProfile !== undefined) {
    config.defaultProfile = asString(input.defaultProfile, 'defaultProfile');
    if (!config.profiles?.[config.defaultProfile]) {
      throw new SettingsError(`defaultProfile "${config.defaultProfile}" is not one of the profiles. ${listProfiles(config)}`);
    }
  }
  return config;
}

// ------------------------------------------------------------------------------ merge & resolve

export function mergeSettings(...layers: Array<BrowserSettings | undefined>): BrowserSettings {
  const out: BrowserSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.userDataDir !== undefined) out.userDataDir = layer.userDataDir;
    if (layer.channel !== undefined) out.channel = layer.channel;
    if (layer.executablePath !== undefined) out.executablePath = layer.executablePath;
    if (layer.headless !== undefined) out.headless = layer.headless;
    if (layer.webgl !== undefined) out.webgl = layer.webgl;
    if (layer.args?.length) out.args = [...(out.args ?? []), ...layer.args];
    if (layer.context) out.context = { ...out.context, ...layer.context };
  }
  return out;
}

export function resolveBrowserSettings(settings: BrowserSettings, profile?: string): ResolvedBrowserSettings {
  const resolved: ResolvedBrowserSettings = {
    userDataDir: resolve(expandHome(settings.userDataDir ?? defaultUserDataDir(profile))),
    headless: settings.headless ?? false,
    webgl: settings.webgl ?? 'auto',
    args: settings.args ?? [],
    context: settings.context ?? {},
  };
  if (settings.channel) resolved.channel = settings.channel;
  if (settings.executablePath) resolved.executablePath = resolve(expandHome(settings.executablePath));
  return resolved;
}

/** Switches the bot always needs. */
const BASE_ARGS = [
  // Music should start when the bot asks for it, not wait for a click.
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * The final Chromium command line: the bot's own switches, then the WebGL mode's, then the
 * user's. A later switch with the same name replaces an earlier one, so user args win.
 */
export function buildArgs(settings: ResolvedBrowserSettings): string[] {
  const byName = new Map<string, string>();
  for (const arg of [...BASE_ARGS, ...WEBGL_ARGS[settings.webgl], ...settings.args]) {
    byName.delete(switchName(arg)); // re-insert so the effective order matches precedence
    byName.set(switchName(arg), arg);
  }
  return [...byName.values()];
}

/** Playwright context options for the overrides, with the bot's defaults. */
export function buildContextOptions(settings: ResolvedBrowserSettings) {
  const { viewport, ...rest } = settings.context;
  return {
    // A visible window sizes itself; a headless one needs a viewport.
    viewport: viewport !== undefined ? viewport : settings.headless ? { width: 1280, height: 800 } : null,
    ...rest,
  };
}

// ---------------------------------------------------------------------------------- config file

/** Reads and validates a JSON config file. Relative paths in it are relative to the file. */
export async function loadConfigFile(path: string): Promise<ConfigFile> {
  const file = resolve(expandHome(path));
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new SettingsError(`Can't read config file ${file}: ${errorMessage(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`${file} is not valid JSON: ${errorMessage(error)}`);
  }

  let config: ConfigFile;
  try {
    config = validateConfig(json);
  } catch (error) {
    throw new SettingsError(`${file}: ${errorMessage(error)}`);
  }

  const base = dirname(file);
  const fixPaths = (s: BrowserSettings | undefined) => {
    if (s?.userDataDir) s.userDataDir = resolve(base, expandHome(s.userDataDir));
    if (s?.executablePath) s.executablePath = resolve(base, expandHome(s.executablePath));
  };
  fixPaths(config.browser);
  for (const profile of Object.values(config.profiles ?? {})) fixPaths(profile);
  return config;
}

export interface LoadSettingsOptions {
  /** Config file to read. If a profile is requested without one, ~/.ytm-bot/config.json is used. */
  configPath?: string;
  /** Named profile to use; defaults to the file's defaultProfile. */
  profile?: string;
  /** Applied last, over the file and profile (command-line flags, or a dictionary from code). */
  overrides?: BrowserSettings;
}

export interface LoadedSettings {
  settings: ResolvedBrowserSettings;
  profile?: string;
  configPath?: string;
}

export async function loadBrowserSettings(options: LoadSettingsOptions = {}): Promise<LoadedSettings> {
  const overrides = options.overrides ? validateBrowserSettings(options.overrides, 'overrides') : undefined;
  let configPath = options.configPath;
  if (!configPath && options.profile) {
    if (!existsSync(DEFAULT_CONFIG_PATH)) {
      throw new SettingsError(`No config file to read profile "${options.profile}" from: create ${DEFAULT_CONFIG_PATH} or pass --config <file>.`);
    }
    configPath = DEFAULT_CONFIG_PATH;
  }
  if (!configPath) return { settings: resolveBrowserSettings(mergeSettings(overrides)) };

  const config = await loadConfigFile(configPath);
  const profile = options.profile ?? config.defaultProfile;
  let chosen: BrowserSettings | undefined;
  if (profile) {
    chosen = config.profiles?.[profile];
    if (!chosen) throw new SettingsError(`No profile named "${profile}" in ${configPath}. ${listProfiles(config)}`);
  }
  const loaded: LoadedSettings = {
    settings: resolveBrowserSettings(mergeSettings(config.browser, chosen, overrides), profile),
    configPath: resolve(expandHome(configPath)),
  };
  if (profile) loaded.profile = profile;
  return loaded;
}

/** The default config file, if the user has created one. */
export function defaultConfigPathIfPresent(): string | undefined {
  return existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined;
}

// ---------------------------------------------------------------------------------- helpers

function listProfiles(config: ConfigFile): string {
  const names = Object.keys(config.profiles ?? {});
  return names.length ? `Available: ${names.join(', ')}.` : 'The file defines no profiles.';
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path;
}

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'string' ? `"${value}"` : typeof value;
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsError(`${at} must be an object (got ${describeType(value)}).`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SettingsError(`${at} must be a non-empty string (got ${describeType(value)}).`);
  return value.trim();
}

function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') throw new SettingsError(`${at} must be true or false (got ${describeType(value)}).`);
  return value;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new SettingsError(`${at} must be a list (got ${describeType(value)}).`);
  return value;
}

function asNumber(value: unknown, at: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsError(`${at} must be a number from ${min} to ${max} (got ${describeType(value)}${typeof value === 'number' ? ` ${value}` : ''}).`);
  }
  return value;
}

function asInteger(value: unknown, at: string, min: number, max: number): number {
  const n = asNumber(value, at, min, max);
  if (!Number.isInteger(n)) throw new SettingsError(`${at} must be a whole number (got ${n}).`);
  return n;
}

function asOneOf<T extends string>(value: unknown, options: readonly T[], at: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new SettingsError(`${at} must be one of ${options.join(', ')} (got ${describeType(value)}).`);
  }
  return value as T;
}

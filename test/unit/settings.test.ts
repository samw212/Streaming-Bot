import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  buildArgs,
  buildContextOptions,
  defaultUserDataDir,
  loadBrowserSettings,
  loadConfigFile,
  mergeSettings,
  resolveBrowserSettings,
  validateBrowserSettings,
  validateConfig,
} from '../../src/settings.ts';

describe('validateBrowserSettings', () => {
  it('accepts a full dictionary and returns a clean copy', () => {
    const input = {
      userDataDir: ' /data/ytm ',
      channel: 'chrome',
      headless: false,
      args: ['--start-maximized', '--alsa-output-device=hw:1,0'],
      context: { locale: 'de-DE', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 },
      webgl: 'software',
    };
    assert.deepEqual(validateBrowserSettings(input), { ...input, userDataDir: '/data/ytm' });
    assert.deepEqual(validateBrowserSettings({ context: { viewport: null } }), { context: { viewport: null } });
  });

  it('names the offending setting in errors', () => {
    assert.throws(() => validateBrowserSettings({ webgl: 'turbo' }, 'profiles.pi'), /^SettingsError: profiles\.pi\.webgl must be one of auto, hardware, software, disabled \(got "turbo"\)/);
    assert.throws(() => validateBrowserSettings({ args: '--x' }), /browser\.args must be a list \(got "--x"\)/);
    assert.throws(() => validateBrowserSettings({ args: ['--ok', 7] }), /browser\.args\[1\] must be a non-empty string \(got number\)/);
    assert.throws(() => validateBrowserSettings({ headless: 'yes' }), /browser\.headless must be true or false/);
    assert.throws(() => validateBrowserSettings({ context: { viewport: { width: 50, height: 600 } } }), /viewport\.width must be a number from 200/);
    assert.throws(() => validateBrowserSettings({ context: { locale: 'German' } }), /must be a language tag/);
    assert.throws(() => validateBrowserSettings([]), /browser must be an object \(got a list\)/);
  });

  it('rejects unknown keys, listing what is supported', () => {
    assert.throws(() => validateBrowserSettings({ stealth: true }), /browser\.stealth is not a browser setting\. Supported: userDataDir, channel/);
    assert.throws(() => validateBrowserSettings({ context: { offline: true } }), /context\.offline is not a supported context override\. Supported: locale/);
  });

  it('only takes switches, and not ones the bot manages itself', () => {
    assert.throws(() => validateBrowserSettings({ args: ['https://example.com'] }), /must be a Chromium switch starting with "--"/);
    assert.throws(() => validateBrowserSettings({ args: ['--user-data-dir=/tmp/x'] }), /use the "userDataDir" setting instead/);
    assert.throws(() => validateBrowserSettings({ args: ['--headless=new'] }), /use the "headless" setting instead/);
    assert.throws(() => validateBrowserSettings({ args: ['--remote-debugging-port=9222'] }), /Playwright manages/);
  });

  it('refuses settings whose only purpose is to disguise the browser', () => {
    for (const arg of ['--user-agent=Mozilla/5.0', '--proxy-server=socks5://x:1080', '--disable-blink-features=AutomationControlled', '--DISABLE-BLINK-FEATURES=Foo,AutomationControlled']) {
      assert.throws(() => validateBrowserSettings({ args: [arg] }), /isn't supported: the bot runs as an ordinary browser/, arg);
    }
    for (const key of ['userAgent', 'timezoneId', 'geolocation', 'proxy', 'extraHTTPHeaders']) {
      assert.throws(() => validateBrowserSettings({ context: { [key]: 'x' } }), /isn't supported: the bot runs as an ordinary browser/, key);
    }
  });
});

describe('merging and resolving', () => {
  it('lets later layers win, appends args and merges context', () => {
    const merged = mergeSettings(
      { channel: 'chrome', args: ['--a'], context: { locale: 'en-US', colorScheme: 'dark' }, webgl: 'auto' },
      undefined,
      { args: ['--b'], context: { locale: 'de-DE' }, webgl: 'disabled' },
      { headless: true },
    );
    assert.deepEqual(merged, { channel: 'chrome', args: ['--a', '--b'], context: { locale: 'de-DE', colorScheme: 'dark' }, webgl: 'disabled', headless: true });
  });

  it('fills defaults, with a separate data directory per named profile', () => {
    const plain = resolveBrowserSettings({});
    assert.equal(plain.userDataDir, defaultUserDataDir());
    assert.equal(plain.headless, false);
    assert.equal(plain.webgl, 'auto');
    assert.deepEqual(plain.args, []);
    assert.equal(resolveBrowserSettings({}, 'pi').userDataDir, join(homedir(), '.ytm-bot', 'profiles', 'pi'));
    assert.equal(resolveBrowserSettings({ userDataDir: '~/music' }).userDataDir, join(homedir(), 'music'));
  });

  it('builds the command line: bot switches, then the WebGL mode, then user args winning by name', () => {
    assert.deepEqual(buildArgs(resolveBrowserSettings({})), ['--autoplay-policy=no-user-gesture-required']);
    assert.deepEqual(buildArgs(resolveBrowserSettings({ webgl: 'software', args: ['--start-maximized'] })), [
      '--autoplay-policy=no-user-gesture-required',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--start-maximized',
    ]);
    assert.deepEqual(buildArgs(resolveBrowserSettings({ webgl: 'software', args: ['--use-angle=gl'] })), [
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-angle=gl',
    ]);
    assert.deepEqual(buildArgs(resolveBrowserSettings({ webgl: 'disabled' })).at(-1), '--disable-3d-apis');
  });

  it('builds context options with a viewport only when headless', () => {
    assert.deepEqual(buildContextOptions(resolveBrowserSettings({})), { viewport: null });
    assert.deepEqual(buildContextOptions(resolveBrowserSettings({ headless: true })), { viewport: { width: 1280, height: 800 } });
    assert.deepEqual(buildContextOptions(resolveBrowserSettings({ headless: true, context: { viewport: null, locale: 'fr-FR' } })), {
      viewport: null,
      locale: 'fr-FR',
    });
  });
});

describe('config files and profiles', () => {
  let dir: string;
  const write = async (name: string, value: unknown) => {
    const path = join(dir, name);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytm-bot-settings-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads profiles, resolving relative paths against the file', async () => {
    const path = await write('config.json', {
      browser: { context: { locale: 'en-US' }, args: ['--base'] },
      defaultProfile: 'desk',
      profiles: { desk: { userDataDir: 'data/desk', args: ['--desk'] }, pi: { webgl: 'disabled', userDataDir: '~/pi' } },
    });
    const config = await loadConfigFile(path);
    assert.equal(config.profiles?.desk?.userDataDir, join(dir, 'data', 'desk'));
    assert.equal(config.profiles?.pi?.userDataDir, join(homedir(), 'pi'));

    const desk = await loadBrowserSettings({ configPath: path });
    assert.equal(desk.profile, 'desk');
    assert.deepEqual(desk.settings.args, ['--base', '--desk']);
    assert.equal(desk.settings.context.locale, 'en-US');

    const pi = await loadBrowserSettings({ configPath: path, profile: 'pi', overrides: { context: { locale: 'de-DE' } } });
    assert.equal(pi.settings.webgl, 'disabled');
    assert.equal(pi.settings.context.locale, 'de-DE'); // overrides beat the file
    assert.deepEqual(pi.settings.args, ['--base']);
  });

  it('gives each profile its own data directory by default', async () => {
    const path = await write('dirs.json', { profiles: { one: {}, two: {} } });
    const one = await loadBrowserSettings({ configPath: path, profile: 'one' });
    const two = await loadBrowserSettings({ configPath: path, profile: 'two' });
    assert.equal(one.settings.userDataDir, defaultUserDataDir('one'));
    assert.notEqual(one.settings.userDataDir, two.settings.userDataDir);
    const none = await loadBrowserSettings({ configPath: path });
    assert.equal(none.profile, undefined);
    assert.equal(none.settings.userDataDir, defaultUserDataDir());
  });

  it('explains unknown profiles and broken files', async () => {
    const path = await write('named.json', { profiles: { desk: {}, pi: {} } });
    await assert.rejects(loadBrowserSettings({ configPath: path, profile: 'laptop' }), /No profile named "laptop" in .*named\.json\. Available: desk, pi\./);
    await assert.rejects(loadConfigFile(await write('bad.json', '{ "profiles": ')), /bad\.json is not valid JSON/);
    await assert.rejects(loadConfigFile(join(dir, 'missing.json')), /Can't read config file/);
    await assert.rejects(
      loadConfigFile(await write('typo.json', { profiles: { pi: { webgl: 'off' } } })),
      /typo\.json: profiles\.pi\.webgl must be one of/,
    );
  });

  it('checks the file structure', () => {
    assert.throws(() => validateConfig({ profile: {} }), /Unknown top-level key "profile"/);
    assert.throws(() => validateConfig({ defaultProfile: 'x', profiles: { y: {} } }), /defaultProfile "x" is not one of the profiles\. Available: y\./);
    assert.throws(() => validateConfig({ profiles: { 'my profile': {} } }), /may only use letters, digits/);
  });

  it('validates the dictionary passed in from code too', async () => {
    await assert.rejects(loadBrowserSettings({ overrides: { args: ['--user-agent=x'] } }), /overrides\.args\[0\]: --user-agent isn't supported/);
  });

  it('ships a valid example config', async () => {
    const config = await loadConfigFile(new URL('../../examples/config.json', import.meta.url).pathname);
    assert.deepEqual(Object.keys(config.profiles ?? {}), ['desktop', 'pi', 'no-gpu-server']);
    assert.equal(config.defaultProfile, 'desktop');
  });
});

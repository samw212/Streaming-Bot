import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandNames, findCommand, parseCommandLine } from '../../src/commands.ts';
import { resolveConfig } from '../../src/config.ts';

describe('resolveConfig', () => {
  it('has sensible defaults', () => {
    const config = resolveConfig([], {});
    assert.equal(config.mode, 'start');
    assert.deepEqual(config.browser, {});
    assert.equal(config.configPath, undefined);
    assert.equal(config.profile, undefined);
    assert.equal(config.server, true);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8765);
    assert.equal(config.autoplay, true);
    assert.equal(config.baseUrl, 'https://music.youtube.com');
    assert.deepEqual(config.items, []);
  });

  it('queues positional arguments and reads negated flags', () => {
    const config = resolveConfig(['--no-autoplay', '--no-server', '--volume', '40', 'song one', 'song two'], {});
    assert.deepEqual(config.items, ['song one', 'song two']);
    assert.equal(config.autoplay, false);
    assert.equal(config.server, false);
    assert.equal(config.volume, 40);
  });

  it('collects browser flags into a settings dictionary', () => {
    const config = resolveConfig(
      [
        '--profile', 'pi',
        '--config', 'my.json',
        '--user-data-dir', '/data/ytm',
        '--channel', 'chrome',
        '--browser-arg=--start-maximized',
        '--browser-arg=--alsa-output-device=hw:1,0',
        '--locale', 'de-DE',
        '--webgl', 'disabled',
        '--headless',
      ],
      {},
    );
    assert.equal(config.profile, 'pi');
    assert.equal(config.configPath, 'my.json');
    assert.deepEqual(config.browser, {
      userDataDir: '/data/ytm',
      channel: 'chrome',
      args: ['--start-maximized', '--alsa-output-device=hw:1,0'],
      context: { locale: 'de-DE' },
      webgl: 'disabled',
      headless: true,
    });
  });

  it('lets flags override environment variables', () => {
    const env = { YTM_BOT_PORT: '9000', YTM_BOT_API_TOKEN: 'from-env', YTM_BOT_HEADLESS: 'true', YTM_BOT_PROFILE: 'pi', YTM_BOT_WEBGL: 'software' };
    const fromEnv = resolveConfig([], env);
    assert.equal(fromEnv.port, 9000);
    assert.equal(fromEnv.apiToken, 'from-env');
    assert.equal(fromEnv.browser.headless, true);
    assert.equal(fromEnv.browser.webgl, 'software');
    assert.equal(fromEnv.profile, 'pi');
    const flags = resolveConfig(['--port', '1234', '--profile', 'desktop', '--webgl', 'auto'], env);
    assert.equal(flags.port, 1234);
    assert.equal(flags.profile, 'desktop');
    assert.equal(flags.browser.webgl, 'auto');
    assert.equal(resolveConfig([], { YTM_BOT_HEADLESS: 'no' }).browser.headless, false);
  });

  it('understands subcommands', () => {
    const search = resolveConfig(['search', 'daft', 'punk'], {});
    assert.equal(search.mode, 'search');
    assert.deepEqual(search.items, ['daft punk']);
    assert.equal(search.server, false);
    assert.equal(search.repl, false);
    assert.equal(resolveConfig(['login'], {}).mode, 'login');
    assert.equal(resolveConfig(['--help'], {}).mode, 'help');
  });

  it('rejects bad values with a clear message', () => {
    assert.throws(() => resolveConfig(['--port', 'abc'], {}), /--port must be a whole number/);
    assert.throws(() => resolveConfig(['--volume', '101'], {}), /--volume must be a whole number from 0 to 100/);
    assert.throws(() => resolveConfig(['--log-level', 'loud'], {}), /Unknown log level/);
    assert.throws(() => resolveConfig(['search'], {}), /Usage: ytm-bot search/);
    assert.throws(() => resolveConfig(['login', '--headless'], {}), /visible browser window/);
    assert.throws(() => resolveConfig(['--nope'], {}), /Unknown option/);
    assert.throws(() => resolveConfig(['--webgl', 'fast'], {}), /^Error: --webgl must be one of auto, hardware, software, disabled/);
    assert.throws(() => resolveConfig(['--locale', 'German'], {}), /^Error: --locale must be a language tag/);
    assert.throws(() => resolveConfig(['--browser-arg=start-maximized'], {}), /^Error: --browser-arg .*must be a Chromium switch/);
    assert.throws(() => resolveConfig(['--browser-arg=--user-agent=Foo'], {}), /^Error: --browser-arg: --user-agent isn't supported/);
  });

  it('strips a trailing slash from the base URL', () => {
    assert.equal(resolveConfig(['--base-url', 'http://localhost:1234/'], {}).baseUrl, 'http://localhost:1234');
  });
});

describe('command parsing', () => {
  it('splits the command word from its argument', () => {
    assert.deepEqual(parseCommandLine('  PLAY   daft punk  '), { name: 'play', arg: 'daft punk' });
    assert.deepEqual(parseCommandLine('next'), { name: 'next', arg: '' });
    assert.equal(parseCommandLine('   '), null);
  });

  it('finds commands by alias and has no duplicate names', () => {
    assert.equal(findCommand('skip')?.name, 'next');
    assert.equal(findCommand('NP')?.name, 'status');
    assert.equal(findCommand('q')?.name, 'queue');
    assert.equal(findCommand('dance'), undefined);
    const names = commandNames();
    assert.equal(new Set(names).size, names.length);
  });
});

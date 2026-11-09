import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandNames, findCommand, parseCommandLine } from '../../src/commands.ts';
import { resolveConfig } from '../../src/config.ts';

describe('resolveConfig', () => {
  it('has sensible defaults', () => {
    const config = resolveConfig([], {});
    assert.equal(config.mode, 'start');
    assert.equal(config.headless, false);
    assert.equal(config.server, true);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8765);
    assert.equal(config.autoplay, true);
    assert.equal(config.baseUrl, 'https://music.youtube.com');
    assert.match(config.profileDir, /\.ytm-bot[/\\]profile$/);
    assert.deepEqual(config.items, []);
  });

  it('queues positional arguments and reads negated flags', () => {
    const config = resolveConfig(['--no-autoplay', '--no-server', '--volume', '40', 'song one', 'song two'], {});
    assert.deepEqual(config.items, ['song one', 'song two']);
    assert.equal(config.autoplay, false);
    assert.equal(config.server, false);
    assert.equal(config.volume, 40);
  });

  it('lets flags override environment variables', () => {
    const env = { YTM_BOT_PORT: '9000', YTM_BOT_API_TOKEN: 'from-env', YTM_BOT_HEADLESS: 'true' };
    assert.equal(resolveConfig([], env).port, 9000);
    assert.equal(resolveConfig([], env).apiToken, 'from-env');
    assert.equal(resolveConfig([], env).headless, true);
    assert.equal(resolveConfig(['--port', '1234'], env).port, 1234);
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

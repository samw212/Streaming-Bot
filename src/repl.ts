import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline';
import type { StreamingBot } from './bot.ts';
import { commandNames, executeCommand, formatTrack } from './commands.ts';
import type { Logger } from './logger.ts';

export interface ReplOptions {
  logger: Logger;
  onQuit: () => void;
}

/** Interactive terminal control. Log lines and track changes are printed above the prompt. */
export function startRepl(bot: StreamingBot, options: ReplOptions): Interface {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'ytm> ',
    completer: (line: string) => {
      if (line.includes(' ')) return [[], line];
      const hits = commandNames().filter((name) => name.startsWith(line.toLowerCase()));
      return [hits, line];
    },
  });

  let closed = false;
  /** True while a typed command runs; its own reply already says what changed. */
  let running = false;

  const printAbove = (text: string) => {
    if (closed) {
      process.stdout.write(`${text}\n`);
      return;
    }
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    rl.prompt(true);
  };
  options.logger.setSink(printAbove);
  bot.on('trackchange', (track) => {
    if (!running) printAbove(`♪ Now playing: ${formatTrack(track)}`);
  });
  bot.on('idle', () => {
    if (!running) printAbove('■ Stopped.');
  });

  // Lines are handled one at a time so pasted batches of commands run in order.
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const input = line.trim();
      if (/^(quit|exit)$/i.test(input)) {
        rl.close();
        return;
      }
      if (input) {
        running = true;
        const result = await executeCommand(bot, input).finally(() => (running = false));
        process.stdout.write(`${result.ok ? '' : '✗ '}${result.message}\n`);
      }
      rl.prompt();
    });
  });
  rl.on('close', () => {
    closed = true;
    options.onQuit();
  });

  process.stdout.write('Type "help" for commands, "quit" to exit.\n');
  rl.prompt();
  return rl;
}

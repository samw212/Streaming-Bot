import { describe, type BotSnapshot, type StreamingBot } from './bot.ts';
import { errorMessage } from './logger.ts';
import { formatDuration, parseSeek } from './ytmusic/parse.ts';
import type { Track } from './ytmusic/types.ts';

export interface CommandResult {
  ok: boolean;
  /** Human-readable summary, printed by the REPL and shown by the web remote. */
  message: string;
  /** Structured result for API clients. */
  data?: unknown;
}

interface Command {
  name: string;
  aliases: string[];
  usage: string;
  summary: string;
  run(bot: StreamingBot, arg: string): Promise<CommandResult>;
}

const ok = (message: string, data?: unknown): CommandResult => (data === undefined ? { ok: true, message } : { ok: true, message, data });

const requireArg = (arg: string, usage: string) => {
  if (!arg) throw new Error(`Usage: ${usage}`);
  return arg;
};

export const COMMANDS: Command[] = [
  {
    name: 'play',
    aliases: ['p'],
    usage: 'play <query | url | #N>',
    summary: 'Play now (no argument: resume)',
    async run(bot, arg) {
      if (!arg) {
        await bot.resume();
        return ok('Resumed.');
      }
      const track = await bot.play(arg);
      return ok(`▶ ${formatTrack(track)}`, track);
    },
  },
  {
    name: 'add',
    aliases: ['a', 'enqueue'],
    usage: 'add <query | url | #N>',
    summary: 'Add to the end of the queue',
    async run(bot, arg) {
      const { track, position, started } = await bot.enqueue(requireArg(arg, this.usage));
      return ok(started ? `▶ ${formatTrack(track)}` : `Queued #${position}: ${formatTrack(track)}`, { track, position });
    },
  },
  {
    name: 'playnext',
    aliases: ['pn'],
    usage: 'playnext <query | url | #N>',
    summary: 'Queue to play right after the current track',
    async run(bot, arg) {
      const { track, started } = await bot.enqueue(requireArg(arg, this.usage), { next: true });
      return ok(started ? `▶ ${formatTrack(track)}` : `Up next: ${formatTrack(track)}`, { track });
    },
  },
  {
    name: 'search',
    aliases: ['s', 'find'],
    usage: 'search <query>',
    summary: 'Search; then use #N with play/add',
    async run(bot, arg) {
      const results = await bot.search(requireArg(arg, this.usage));
      if (results.length === 0) return ok(`No playable results for "${arg}".`, []);
      const lines = results.map((t, i) => `${String(i + 1).padStart(2)}. ${formatTrack(t)}${t.kind ? `  [${t.kind}]` : ''}`);
      return ok(`${lines.join('\n')}\nUse "play #N" or "add #N".`, results);
    },
  },
  {
    name: 'next',
    aliases: ['skip', 'n'],
    usage: 'next',
    summary: 'Skip to the next track',
    async run(bot) {
      const track = await bot.next();
      return ok(track ? `▶ ${formatTrack(track)}` : 'Nothing left to play; stopped.', track);
    },
  },
  {
    name: 'prev',
    aliases: ['previous', 'back', 'b'],
    usage: 'prev',
    summary: 'Restart the track, or go back one',
    async run(bot) {
      const track = await bot.previous();
      return ok(track ? `▶ ${formatTrack(track)}` : 'Nothing to go back to.', track);
    },
  },
  {
    name: 'pause',
    aliases: [],
    usage: 'pause',
    summary: 'Pause',
    async run(bot) {
      await bot.pause();
      return ok('Paused.');
    },
  },
  {
    name: 'resume',
    aliases: ['unpause', 'r'],
    usage: 'resume',
    summary: 'Resume',
    async run(bot) {
      await bot.resume();
      return ok('Resumed.');
    },
  },
  {
    name: 'toggle',
    aliases: ['pp'],
    usage: 'toggle',
    summary: 'Play/pause',
    async run(bot) {
      return ok((await bot.toggle()) === 'playing' ? 'Resumed.' : 'Paused.');
    },
  },
  {
    name: 'stop',
    aliases: [],
    usage: 'stop',
    summary: 'Stop playback (keeps the queue)',
    async run(bot) {
      await bot.stopPlayback();
      return ok('Stopped.');
    },
  },
  {
    name: 'volume',
    aliases: ['vol', 'v'],
    usage: 'volume [0-100 | +N | -N]',
    summary: 'Show or set the volume',
    async run(bot, arg) {
      const current = (await bot.snapshot()).player?.volume ?? 0;
      if (!arg) return ok(`Volume ${current}.`, { volume: current });
      const relative = /^[+-]\d+$/.test(arg);
      const value = Number(arg);
      if (!Number.isFinite(value)) throw new Error(`Usage: ${this.usage}`);
      const volume = await bot.setVolume(relative ? current + value : value);
      return ok(`Volume ${volume}.`, { volume });
    },
  },
  {
    name: 'seek',
    aliases: ['jump'],
    usage: 'seek <90 | 1:30 | +10 | -10>',
    summary: 'Jump within the track',
    async run(bot, arg) {
      const position = (await bot.snapshot()).player?.position ?? 0;
      const target = parseSeek(requireArg(arg, this.usage), position);
      await bot.seek(target);
      return ok(`At ${formatDuration(target)}.`, { position: target });
    },
  },
  {
    name: 'status',
    aliases: ['np', 'now', 'nowplaying'],
    usage: 'status',
    summary: 'What is playing',
    async run(bot) {
      const snapshot = await bot.snapshot();
      return ok(formatStatus(snapshot), snapshot);
    },
  },
  {
    name: 'queue',
    aliases: ['q', 'list', 'ls'],
    usage: 'queue [query | url | #N]',
    summary: 'Show the queue (with an argument: add)',
    async run(bot, arg) {
      if (arg) return findCommand('add')!.run(bot, arg);
      const queue = bot.queue;
      if (queue.length === 0) return ok(`The queue is empty. Autoplay is ${bot.autoplay ? 'on' : 'off'}.`, []);
      const lines = queue.map((t, i) => `${String(i + 1).padStart(2)}. ${formatTrack(t)}`);
      return ok(`Up next:\n${lines.join('\n')}`, queue);
    },
  },
  {
    name: 'remove',
    aliases: ['rm', 'del'],
    usage: 'remove <N>',
    summary: 'Remove queue entry N',
    async run(bot, arg) {
      const track = bot.removeFromQueue(parsePosition(requireArg(arg, this.usage)));
      return ok(`Removed ${formatTrack(track)}.`, track);
    },
  },
  {
    name: 'move',
    aliases: ['mv'],
    usage: 'move <from> <to>',
    summary: 'Reorder the queue',
    async run(bot, arg) {
      const [from, to] = requireArg(arg, this.usage).split(/\s+/);
      if (!from || !to) throw new Error(`Usage: ${this.usage}`);
      bot.moveInQueue(parsePosition(from), parsePosition(to));
      return ok(`Moved #${from} to #${to}.`, bot.queue);
    },
  },
  {
    name: 'clear',
    aliases: [],
    usage: 'clear',
    summary: 'Empty the queue',
    async run(bot) {
      const count = bot.clearQueue();
      return ok(`Removed ${count} track${count === 1 ? '' : 's'} from the queue.`, { removed: count });
    },
  },
  {
    name: 'autoplay',
    aliases: ['radio'],
    usage: 'autoplay [on | off]',
    summary: 'Let YouTube Music keep playing when the queue ends',
    async run(bot, arg) {
      if (arg) {
        const value = arg.toLowerCase();
        if (!['on', 'off', 'true', 'false', '1', '0'].includes(value)) throw new Error(`Usage: ${this.usage}`);
        bot.setAutoplay(['on', 'true', '1'].includes(value));
      }
      return ok(`Autoplay is ${bot.autoplay ? 'on' : 'off'}.`, { autoplay: bot.autoplay });
    },
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    usage: 'help',
    summary: 'List commands',
    async run() {
      const width = Math.max(...COMMANDS.map((c) => c.usage.length));
      const lines = COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
      return ok(`Commands:\n${lines.join('\n')}\n  ${'quit'.padEnd(width)}  Exit (terminal only)`);
    },
  },
];

export function findCommand(name: string): Command | undefined {
  const key = name.toLowerCase();
  return COMMANDS.find((c) => c.name === key || c.aliases.includes(key));
}

export function commandNames(): string[] {
  return COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
}

export function parseCommandLine(line: string): { name: string; arg: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const space = trimmed.search(/\s/);
  return space === -1
    ? { name: trimmed.toLowerCase(), arg: '' }
    : { name: trimmed.slice(0, space).toLowerCase(), arg: trimmed.slice(space + 1).trim() };
}

/** Runs one line of input. Never throws: failures come back as `{ ok: false }`. */
export async function executeCommand(bot: StreamingBot, line: string): Promise<CommandResult> {
  const parsed = parseCommandLine(line);
  if (!parsed) return { ok: false, message: 'Type a command, or "help".' };
  const command = findCommand(parsed.name);
  if (!command) return { ok: false, message: `Unknown command "${parsed.name}". Type "help" for a list.` };
  try {
    return await command.run(bot, parsed.arg);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function parsePosition(value: string): number {
  const position = Number(value.replace(/^#/, ''));
  if (!Number.isInteger(position) || position < 1) throw new Error(`"${value}" is not a queue position.`);
  return position;
}

export function formatTrack(track: Track): string {
  const extras = [track.album, track.durationSeconds ? formatDuration(track.durationSeconds) : undefined].filter(Boolean);
  return extras.length ? `${describe(track)} (${extras.join(', ')})` : describe(track);
}

export function formatStatus(snapshot: BotSnapshot): string {
  const { status, current, player, queue, autoplay } = snapshot;
  const lines: string[] = [];
  if (!current) {
    lines.push('Nothing playing.');
  } else {
    const icon = { playing: '▶', paused: '❚❚', loading: '…', ad: '⏵ad', idle: '■' }[status];
    const length = player?.duration || current.durationSeconds || 0;
    const progress = player && length > 0 ? `  ${formatDuration(player.position)} / ${formatDuration(length)}` : '';
    const volume = player ? `  vol ${player.volume}${player.muted ? ' (muted)' : ''}` : '';
    lines.push(`${icon} ${formatTrack(current)}${progress}${volume}`);
    if (status === 'ad') lines.push('  (YouTube Music is playing an ad)');
  }
  lines.push(`Queue: ${queue.length === 0 ? 'empty' : `${queue.length} track${queue.length === 1 ? '' : 's'}`} · autoplay ${autoplay ? 'on' : 'off'}`);
  if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`);
  return lines.join('\n');
}

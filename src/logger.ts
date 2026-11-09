export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Redirect output, e.g. so the REPL can print log lines above its prompt. */
  setSink(sink: (line: string) => void): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  let sink: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  };
  const write = (lineLevel: Exclude<LogLevel, 'silent'>, message: string) => {
    if (ORDER[lineLevel] < ORDER[level]) return;
    const time = new Date().toTimeString().slice(0, 8);
    sink(`${time} ${lineLevel.toUpperCase().padEnd(5)} ${message}`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    setSink: (next) => {
      sink = next;
    },
  };
}

/** A logger that drops everything; handy in tests. */
export const silentLogger: Logger = createLogger('silent');

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Structured console logging. English only, like every other product surface. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

export type LogSink = (level: LogLevel, message: string, at: number) => void;

const sinks = new Set<LogSink>();

let threshold: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const at = Date.now();
  const stamp = new Date(at).toISOString().slice(11, 23);
  const text = extra === undefined ? message : `${message} ${safeJson(extra)}`;
  const line = `${COLOURS[level]}${stamp} ${level.padEnd(5)}\x1b[0m ${scope.padEnd(14)} ${text}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  for (const sink of sinks) {
    try {
      sink(level, `${scope}: ${text}`, at);
    } catch {
      /* a broken sink must never take down logging */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

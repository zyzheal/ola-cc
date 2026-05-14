export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const LEVEL_PRIORITY: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let sharedLogger: Logger | null = null;

function buildLogger(): Logger {
  const minPriority = LEVEL_PRIORITY[process.env.SDK_LOG_LEVEL ?? 'warn'] ?? 30;

  const log = (level: string, msg: string, ctx?: Record<string, unknown>) => {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const entry = {
      level,
      time: new Date().toISOString(),
      msg,
      ...ctx,
    };

    const output = process.env.SDK_LOG_PRETTY === 'true'
      ? `[${entry.time}] ${level.toUpperCase()}: ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`
      : JSON.stringify(entry);

    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY.error) {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
  };
}

export function getLogger(): Logger {
  if (!sharedLogger) {
    sharedLogger = buildLogger();
  }
  return sharedLogger;
}

export function createMockLogger(): Logger & { calls: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> } {
  const calls: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
  return {
    calls,
    debug: (msg, ctx) => calls.push({ level: 'debug', msg, ctx }),
    info: (msg, ctx) => calls.push({ level: 'info', msg, ctx }),
    warn: (msg, ctx) => calls.push({ level: 'warn', msg, ctx }),
    error: (msg, ctx) => calls.push({ level: 'error', msg, ctx }),
  };
}

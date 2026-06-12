// Tiny structured logger. Zero deps. Levels gated by LOG_LEVEL env (default info).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(extra && typeof extra === 'object' ? extra : extra !== undefined ? { extra } : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

/** Create a logger bound to a scope label, e.g. logger('worker:266-03335'). */
export function logger(scope = 'app') {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}

export default logger;

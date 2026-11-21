/**
 * The platform's one way to write a log line.
 *
 * Every line is one object on the console, which Workers Observability turns
 * into searchable fields:
 *
 * - `message`: what the list shows, `[module] what happened: why`, so a line
 *   reads on its own without opening it;
 * - `kind`: `app` for what our code chose to say, `request` for the line the
 *   Worker writes per HTTP request (`requestLine`). Cloudflare's own
 *   per-invocation records are switched off (`invocation_logs: false`), so
 *   anything else in the list did not come from us;
 * - `module`: which part of the platform said it (`shop-hub`, `live-activity`);
 * - `level`: `info`, `warn` or `error`, written through the console method of
 *   the same name so Observability's own level filter agrees;
 * - `event`: optional stable name to search for (`live_activity_rotated`);
 * - anything else the caller adds, and `error` as name, message and stack.
 *
 * Search `kind = app` for our lines, `module = shop-hub` for one part,
 * `level = error` for what went wrong.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogFields = { event?: string; error?: unknown } & Record<string, unknown>;
export type Logger = Record<LogLevel, (text: string, fields?: LogFields) => void>;

type ErrorFields = { name: string; message: string; code?: string; stack?: string };

/** An error as fields: what it was and where, without the whole object graph. */
export function errorFields(error: unknown): ErrorFields {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
      // Enough frames to find it; a full trace makes every line long.
      ...(error.stack ? { stack: error.stack.split("\n").slice(0, 8).join("\n") } : {}),
    };
  }
  return { name: typeof error, message: typeof error === "string" ? error : safeJson(error) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What a line is made of; `write` is the console, swapped in tests. */
export function logLine(kind: "app" | "request", module: string, level: LogLevel, text: string, fields: LogFields = {}) {
  const { error, ...rest } = fields;
  const failure = error === undefined ? undefined : errorFields(error);
  // The caller's fields come first: what makes a line ours (message, kind, module, level) is never theirs to change.
  return {
    ...rest,
    message: `[${module}] ${text}${failure ? `: ${failure.message}` : ""}`,
    kind,
    module,
    level,
    ...(failure ? { error: failure } : {}),
  };
}

function write(level: LogLevel, line: Record<string, unknown>) {
  console[level](line);
}

/** A module's logger: `const log = logger("shop-hub")`, then `log.error("board read failed", { error })`. */
export function logger(module: string): Logger {
  const at = (level: LogLevel) => (text: string, fields?: LogFields) => write(level, logLine("app", module, level, text, fields));
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

/**
 * A path as it may be kept: a card's or account's number is not (an identity's
 * subject, any long run of digits), the rest is what was asked for.
 */
export function loggedPath(path: string): string {
  return path
    .replace(/(\/identities\/[^/]+\/)[^/]+/, "$1:subject")
    .replace(/(^|\/)\d{8,}(?=\/|$)/g, "$1:number");
}

/**
 * The Worker's line for one HTTP request: method, path, status and time. The
 * query is left out (it can carry tokens). A server error is an error, a
 * refused request a warning.
 */
export function requestLine(request: Request, status: number, durationMs: number) {
  const path = loggedPath(new URL(request.url).pathname);
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  write(level, logLine("request", "http", level, `${request.method} ${path} ${status} ${Math.round(durationMs)}ms`, {
    method: request.method,
    path,
    status,
    durationMs: Math.round(durationMs),
  }));
}

/**
 * What a shop bot and the platform say to each other over the bot's WebSocket,
 * as `hardware/aimeio-relay.ts` is for a HINATA IO.
 *
 * A bot that says `commands: 1` in its hello sends its players' commands as
 * `command` frames, run by `resources/bot-commands.ts`, and is told what to
 * say in `say` frames: the answers, and the shop's news. Older bots send
 * `request` frames, run through the platform's own routes in-process with the
 * bot's token, as an HTTP request would be.
 */
import type { BotMessage } from "@prism/core";
import type { Env } from "../bindings.js";
import { parseHaReport, type HaReport } from "../hardware/aimeio-relay.js";

export type BotFrame =
  /**
   * `ha` says the bot can watch Home Assistant for the shop; `name` is how the board calls it.
   * Neither is sent by a bot that predates watching, which is then never asked to.
   */
  /**
   * `announcements: "message"`: the bot says the message the platform writes and is
   * sent only what it is set to announce. Older bots choose and word it themselves.
   */
  | { type: "hello"; reminderLeadSeconds?: number; ha?: true; name?: string; announcements?: "message"; commands?: 1 }
  | BotCommandFrame
  | { type: "request"; id: string; method: "GET" | "POST" | "PUT"; path: string; query?: Record<string, unknown>; body?: unknown }
  /** What a watching bot reports, in the shape an IO reports it: `ha.status` and `ha.states`. */
  | { type: "ha"; report: HaReport };

/** A chat identity: the platform (`onebot`) and who on it. `name` is what the chat calls them. */
export type ChatIdentity = { provider: string; subject: string; name?: string };

/**
 * A player's command. `id` is the bot's own and the same when it sends it
 * again, so it runs once. `name` is the command as the bot registers it
 * (aliases already resolved), `args` its arguments as typed; `target` the
 * person it names (an @mention), `channel` where it was said.
 */
export type BotCommandFrame = {
  type: "command";
  id: string;
  name: string;
  args: string[];
  from: ChatIdentity;
  target?: ChatIdentity;
  channel: string;
};

/**
 * Something the bot says. `replyTo` names the command it answers; `to` where,
 * by default where the command was said; `done` marks a command's last word.
 */
export type SayFrame = { type: "say"; message: BotMessage; replyTo?: string; to?: string; done?: true };

export function sayFrame(message: BotMessage, options: { replyTo?: string; to?: string; done?: boolean } = {}): SayFrame {
  return {
    type: "say",
    message,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.to ? { to: options.to } : {}),
    ...(options.done ? { done: true as const } : {}),
  };
}

/** `serverMs` is how long the platform spent on the request, so the Bot can tell the network from the server. */
export type BotResponse = { type: "response"; id: string; status: number; body: unknown; serverMs?: number };

/** What a bot is called on the board when it does not say. */
export const DEFAULT_BOT_NAME = "Bot";

/** A request frame, hello or watcher report, or null for anything malformed. */
export function parseBotFrame(raw: string): BotFrame | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.type === "hello") {
    const lead = value.reminderLeadSeconds;
    const name = typeof value.name === "string" ? value.name.trim().slice(0, 40) : "";
    return {
      type: "hello",
      ...(typeof lead === "number" && lead >= 0 && lead <= 24 * 3600 ? { reminderLeadSeconds: lead } : {}),
      ...(value.ha === true ? { ha: true as const } : {}),
      ...(name ? { name } : {}),
      ...(value.announcements === "message" ? { announcements: "message" as const } : {}),
      ...(value.commands === 1 ? { commands: 1 as const } : {}),
    };
  }
  if (value.type === "command") return parseCommand(value);
  if (value.type === "ha") {
    const report = parseHaReport(value);
    return report ? { type: "ha", report } : null;
  }
  if (value.type !== "request") return null;
  const { id, method, path, query, body } = value;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (method !== "GET" && method !== "POST" && method !== "PUT") return null;
  if (typeof path !== "string") return null;
  return {
    type: "request",
    id,
    method,
    path,
    ...(query && typeof query === "object" ? { query: query as Record<string, unknown> } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null);

function chatIdentity(value: unknown): ChatIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = text(record.provider, 64)?.toLowerCase();
  const subject = text(record.subject, 256);
  if (!provider || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider) || !subject) return null;
  const name = text(record.name, 100);
  return { provider, subject, ...(name ? { name } : {}) };
}

function parseCommand(value: Record<string, unknown>): BotCommandFrame | null {
  const id = text(value.id, 64);
  const name = text(value.name, 64);
  const from = chatIdentity(value.from);
  const channel = text(value.channel, 256);
  if (!id || !name || !from || !channel) return null;
  const args = Array.isArray(value.args) ? value.args.slice(0, 16).map((arg) => String(arg ?? "").slice(0, 512)) : [];
  const target = value.target === undefined ? null : chatIdentity(value.target);
  return { type: "command", id, name, args, from, ...(target ? { target } : {}), channel };
}

/**
 * The URL a bot path runs as. Only the shop's integration routes and the
 * version endpoint are reachable; anything else is refused before it runs.
 */
export function botRequestUrl(shopCode: string, path: string, query?: Record<string, unknown>): URL | null {
  const clean = path.replace(/^\/+/, "");
  let url: URL;
  if (clean === "version") url = new URL("https://prism.internal/version");
  else if (/^integration(\/[A-Za-z0-9._:~%-]+)+$/.test(clean)) {
    const prefix = `/api/v1/shops/${encodeURIComponent(shopCode)}/integration/`;
    url = new URL(`https://prism.internal/api/v1/shops/${encodeURIComponent(shopCode)}/${clean}`);
    // Dot segments are resolved by URL; what remains must still be inside.
    if (!url.pathname.startsWith(prefix) || /%2e|%2f/i.test(clean)) return null;
  } else return null;
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

// Hono's own context type is wider than what is passed here; the call site narrows it.
type App = { fetch(request: Request, env: Env, ctx: any): Response | Promise<Response> };

export async function runBotRequest(input: {
  app: App;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
  token: string;
  shopCode: string;
  frame: Extract<BotFrame, { type: "request" }>;
}): Promise<BotResponse> {
  const { frame } = input;
  const url = botRequestUrl(input.shopCode, frame.path, frame.query);
  if (!url) return { type: "response", id: frame.id, status: 404, body: { error: { code: "NOT_FOUND", message: "Bot 不能访问这个接口" } } };
  const response = await input.app.fetch(
    new Request(url, {
      method: frame.method,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      ...(frame.method === "GET" ? {} : { body: JSON.stringify(frame.body ?? {}) }),
    }),
    input.env,
    { waitUntil: input.waitUntil, passThroughOnException() {} },
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const serverMs = Number.parseFloat(response.headers.get("x-response-time") ?? "");
  return { type: "response", id: frame.id, status: response.status, body, ...(Number.isFinite(serverMs) ? { serverMs } : {}) };
}

/** The bot's credentials stopped working: its connection should end too. */
export function revokedCredentials(response: BotResponse): boolean {
  const error = (response.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return response.status === 403 && error?.code === "FORBIDDEN" && error.message === "店铺 Bot 凭据无效";
}

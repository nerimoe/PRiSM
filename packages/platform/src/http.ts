import { HTTPException } from "hono/http-exception";

export function jsonError(status: number, message: string, code?: string, details?: unknown): never {
  throw new HTTPException(status as never, {
    message,
    res: Response.json({ error: { code: code ?? ({ 400: "INVALID_REQUEST", 401: "AUTHENTICATION_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 410: "EXPIRED", 429: "RATE_LIMITED" } as Record<number, string>)[status] ?? "INTERNAL_ERROR", message, ...(details === undefined ? {} : { details }) } }, { status }),
  });
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function allowedOrigins(env: { APP_ORIGIN?: string; EXTRA_ALLOWED_ORIGINS?: string }): Set<string> {
  const values = [
    env.APP_ORIGIN,
    ...(env.EXTRA_ALLOWED_ORIGINS?.split(",") ?? []),
  ];
  return new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)));
}

export function assertAllowedOrigin(request: Request, env: { APP_ORIGIN?: string; EXTRA_ALLOWED_ORIGINS?: string }): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (!allowedOrigins(env).has(origin)) {
    throw new Response(JSON.stringify({ error: "请求来源无效" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

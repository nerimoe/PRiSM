import { HTTPException } from "hono/http-exception";

export function jsonError(
  status: number,
  message: string,
  code?: string,
  details?: unknown,
): never {
  const defaultCode =
    ({
      400: "INVALID_REQUEST",
      401: "AUTHENTICATION_REQUIRED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      410: "EXPIRED",
      422: "VALIDATION_FAILED",
      429: "RATE_LIMITED",
      500: "INTERNAL_ERROR",
      503: "SERVICE_UNAVAILABLE",
    } as Record<number, string>)[status] ?? "INTERNAL_ERROR";

  throw new HTTPException(status as never, {
    message,
    res: Response.json(
      {
        error: {
          code: code ?? defaultCode,
          message,
          ...(details === undefined ? {} : { details }),
        },
      },
      { status },
    ),
  });
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

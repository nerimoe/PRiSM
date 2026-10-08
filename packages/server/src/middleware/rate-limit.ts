import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../bindings.js";
import { clientIp } from "../http.js";

export type LimitRule = {
  key: string;
  limit: 3 | 5 | 10 | 20 | 30 | 60 | number;
  windowSeconds?: number;
};

type MemoryEntry = {
  count: number;
  resetAt: number;
};

const memoryLimiter = new Map<string, MemoryEntry>();

export function clearRateLimitMemory(): void {
  memoryLimiter.clear();
}

export async function enforceRateLimits(
  c: Context<AppBindings>,
  rules: LimitRule[],
): Promise<void> {
  const now = Date.now();

  for (const rule of rules) {
    const windowSeconds = rule.windowSeconds ?? 60;
    const bindingName = `RATE_LIMIT_${rule.limit}` as keyof AppBindings["Bindings"];
    const binding = c.env ? (c.env[bindingName] as RateLimit | undefined) : undefined;

    if (binding && windowSeconds === 60) {
      const res = await binding.limit({ key: rule.key });
      if (!res.success) {
        throw new HTTPException(429, {
          res: Response.json(
            {
              error: {
                code: "RATE_LIMITED",
                message: "操作过于频繁，请稍后重试",
              },
            },
            {
              status: 429,
              headers: {
                "retry-after": "60",
                "cache-control": "no-store",
              },
            },
          ),
        });
      }
    } else {
      // Graceful in-memory fallback for local development or non-CF environments
      const windowMs = windowSeconds * 1000;
      const entry = memoryLimiter.get(rule.key);

      if (!entry || now >= entry.resetAt) {
        memoryLimiter.set(rule.key, {
          count: 1,
          resetAt: now + windowMs,
        });
      } else {
        entry.count += 1;
        if (entry.count > rule.limit) {
          const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
          throw new HTTPException(429, {
            res: Response.json(
              {
                error: {
                  code: "RATE_LIMITED",
                  message: "操作过于频繁，请稍后重试",
                },
              },
              {
                status: 429,
                headers: {
                  "retry-after": String(retryAfter),
                  "cache-control": "no-store",
                },
              },
            ),
          });
        }
      }
    }
  }
}

export function rateLimitMiddleware(
  getRules: (c: Context<AppBindings>) => LimitRule[] | Promise<LimitRule[]>,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const rules = await getRules(c);
    await enforceRateLimits(c, rules);
    await next();
  };
}

export function loginRateLimitRules(
  c: Context<AppBindings>,
  input: {
    userId: string;
    machineId: string;
  },
): LimitRule[] {
  const ip = clientIp(c.req.raw);
  return [
    { key: `login:user:${input.userId}`, limit: 5, windowSeconds: 60 },
    { key: `login:machine:${input.machineId}`, limit: 20, windowSeconds: 60 },
    { key: `login:ip:${ip}`, limit: 30, windowSeconds: 60 },
  ];
}

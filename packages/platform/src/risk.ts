import type { Context } from "hono";
import type { AppBindings } from "./types";
import { HTTPException } from "hono/http-exception";
import { clientIp, jsonError, nowIso } from "./http";

type LimitRule = {
  key: string;
  limit: 3 | 5 | 10 | 20 | 30 | 60;
  windowSeconds: 60;
};

export async function enforceRateLimits(c: Context<AppBindings>, rules: LimitRule[]): Promise<void> {
  for (const rule of rules) {
    const binding = c.env[`RATE_LIMIT_${rule.limit}` as keyof typeof c.env] as RateLimit | undefined;
    if (!binding || rule.windowSeconds !== 60) jsonError(503, "限流服务尚未配置");
    if (!(await binding.limit({ key: rule.key })).success) {
      throw new HTTPException(429, { res: Response.json({ error: { code: "RATE_LIMITED", message: "操作过于频繁，请稍后重试" } },
        { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } }) });
    }
  }
}

export function loginRateLimitRules(c: Context<AppBindings>, input: {
  userId: string;
  machineId: string;
}): LimitRule[] {
  const ip = clientIp(c.req.raw);
  return [
    { key: `login:user:${input.userId}`, limit: 5, windowSeconds: 60 },
    { key: `login:machine:${input.machineId}`, limit: 20, windowSeconds: 60 },
    { key: `login:ip:${ip}`, limit: 30, windowSeconds: 60 },
  ];
}

export async function assertNotBanned(c: Context<AppBindings>, subjects: Array<[string, string | null | undefined]>): Promise<void> {
  for (const [subjectType, subjectValue] of subjects) {
    if (!subjectValue) continue;
    const ban = await c.env.DB.prepare(
      "SELECT id FROM bans WHERE subject_type = ? AND subject_value = ? AND (expires_at IS NULL OR expires_at > ?)",
    )
      .bind(subjectType, subjectValue, nowIso())
      .first<{ id: string }>();
    if (ban) jsonError(403, "当前无法进行此操作");
  }
}

import type { Context } from "hono";
import type { AppBindings } from "./types";
import { clientIp, jsonError, nowIso } from "./http";

type LimitRule = {
  key: string;
  limit: number;
  windowSeconds: number;
};

export async function enforceRateLimits(c: Context<AppBindings>, rules: LimitRule[]): Promise<void> {
  for (const rule of rules) {
    const count = await incrementCounter(c.env.RATE_LIMIT, rule.key, rule.windowSeconds);
    if (count > rule.limit) jsonError(429, "操作过于频繁，请稍后重试");
  }
}

async function incrementCounter(kv: KVNamespace, key: string, ttl: number): Promise<number> {
  const current = Number((await kv.get(key)) || "0");
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: ttl });
  return next;
}

export function loginRateLimitRules(c: Context<AppBindings>, input: {
  userId: string;
  machineId: string;
}): LimitRule[] {
  const minute = Math.floor(Date.now() / 60_000);
  const ip = clientIp(c.req.raw);
  return [
    { key: `login:user:${input.userId}:${minute}`, limit: 5, windowSeconds: 90 },
    { key: `login:machine:${input.machineId}:${minute}`, limit: 20, windowSeconds: 90 },
    { key: `login:ip:${ip}:${minute}`, limit: 30, windowSeconds: 90 },
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

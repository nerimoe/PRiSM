import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireUser } from "./auth";
import { sha256 } from "./crypto";
import { jsonError } from "./http";
import type { AppBindings } from "./types";

/** A lost response must never cause another debit or physical operation. */
export async function runPlayerOperation(
  c: Context<AppBindings>,
  shopId: string,
  kind: string,
  body: Record<string, unknown>,
  execute: () => Promise<Response>,
) {
  const user = requireUser(c);
  const id = z.string().uuid().parse(body.operationId);
  const { location: _location, operationId: _id, ...payload } = body;
  const requestHash = await sha256(JSON.stringify(payload));
  const claimed = await c.env.DB.prepare(
    `INSERT INTO player_operations (shop_id,user_id,id,kind,status,request_hash,created_at)
    VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(shop_id,user_id,id) DO NOTHING RETURNING id`,
  )
    .bind(shopId, user.id, id, kind, requestHash, new Date().toISOString())
    .first();
  if (!claimed) {
    const existing = await c.env.DB.prepare(
      "SELECT kind,request_hash,result_json FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
    )
      .bind(shopId, user.id, id)
      .first<{
        kind: string;
        request_hash: string;
        result_json: string | null;
      }>();
    if (existing?.kind !== kind || existing.request_hash !== requestHash)
      jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
    if (existing.result_json) {
      const result = JSON.parse(existing.result_json) as {
        status: number;
        body: unknown;
      };
      return Response.json(result.body, { status: result.status });
    }
    jsonError(
      409,
      "操作未完成，请稍后重试",
      "OPERATION_PENDING",
      { operationId: id },
    );
  }
  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    if (error instanceof HTTPException && error.status < 500)
      response = error.getResponse();
    else {
      await c.env.DB.prepare(
        "UPDATE player_operations SET status='unknown' WHERE shop_id=? AND user_id=? AND id=?",
      )
        .bind(shopId, user.id, id)
        .run();
      throw error;
    }
  }
  const result = {
    status: response.status,
    body: await response.clone().json(),
  };
  await c.env.DB.prepare(
    "UPDATE player_operations SET status=?,result_json=? WHERE shop_id=? AND user_id=? AND id=?",
  )
    .bind(
      response.ok ? "completed" : response.status >= 500 ? "unknown" : "failed",
      JSON.stringify(result),
      shopId,
      user.id,
      id,
    )
    .run();
  return response;
}

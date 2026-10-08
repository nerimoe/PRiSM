import type { Context, Hono } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import { getBillingShop, staffPrincipal } from "./billing";
import { sha256 } from "./crypto";
import { jsonError } from "./http";
import { runPlayerOperation } from "./operations";
import type { AppBindings } from "./types";

type C = Context<AppBindings>;
const provider = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine(value => value !== "web-account", "网页账号身份不可转换");
const conversionSchema = z.object({ sourceProvider: provider, targetProvider: provider })
  .refine(value => value.sourceProvider !== value.targetProvider, "原标识和目标标识不能相同");

async function snapshot(c: C, shopId: string, source: string, target: string) {
  const identities = await c.env.DB.prepare(`SELECT i.player_id AS playerId,i.provider,i.subject,p.display_name AS displayName
    FROM player_identities i JOIN players p ON p.shop_id=i.shop_id AND p.id=i.player_id
    WHERE i.shop_id=? AND i.provider IN (?,?) ORDER BY i.provider,i.subject`).bind(shopId,source,target)
    .all<{ playerId:string;provider:string;subject:string;displayName:string }>();
  const bindings = await c.env.DB.prepare(`SELECT b.user_id AS userId,b.provider,b.subject,a.player_id AS playerId FROM shop_platform_bindings b
    JOIN shop_player_accounts a ON a.shop_id=b.shop_id AND a.user_id=b.user_id
    WHERE b.shop_id=? AND b.provider IN (?,?) ORDER BY b.provider,b.subject`).bind(shopId,source,target)
    .all<{ userId:string;provider:string;subject:string;playerId:string }>();
  const rows = identities.results.filter(row => row.provider === source);
  const targets = new Map(identities.results.filter(row => row.provider === target).map(row => [row.subject,row.playerId]));
  const sourceOwners = new Map(rows.map(row => [row.subject,row.playerId]));
  const targetBindings = bindings.results.filter(row => row.provider === target);
  const targetBySubject = new Map(targetBindings.map(row => [row.subject,row.userId]));
  const targetByUser = new Map(targetBindings.map(row => [row.userId,row.subject]));
  const conflicts = rows.filter(row => targets.has(row.subject) && targets.get(row.subject) !== row.playerId)
    .map(row => ({ subject:row.subject,reason:"目标身份已属于其他玩家" }));
  for (const row of bindings.results.filter(row => row.provider === source)) {
    if (sourceOwners.get(row.subject) !== row.playerId)
      conflicts.push({ subject:row.subject,reason:"绑定与玩家身份不一致，请先修复" });
    if (targetBySubject.has(row.subject) && targetBySubject.get(row.subject) !== row.userId
      || targetByUser.has(row.userId) && targetByUser.get(row.userId) !== row.subject)
      conflicts.push({ subject:row.subject,reason:"目标平台已有不同账号绑定" });
  }
  const sourceBindings = bindings.results.filter(row => row.provider === source);
  return { sourceProvider:source,targetProvider:target,identityCount:rows.length,
    playerCount:new Set(rows.map(row=>row.playerId)).size,bindingCount:sourceBindings.length,conflicts,
    samples:rows.slice(0,20).map(row=>({ playerId:row.playerId,displayName:row.displayName,from:`${source}:${row.subject}`,to:`${target}:${row.subject}` })),
    fingerprint:await sha256(JSON.stringify([source,target,identities.results,bindings.results])) };
}

export function registerIdentityConversionRoutes(app: Hono<AppBindings>) {
  app.post("/api/v1/shops/:shopCode/identity-conversion/preview",async c => {
    const shop = await getBillingShop(c,c.req.param("shopCode"));
    if ((await staffPrincipal(c,shop)).staffRole !== "owner") jsonError(403,"只有店铺负责人可以转换身份","FORBIDDEN");
    const body = conversionSchema.parse(await c.req.json());
    return c.json(await snapshot(c,shop.id,body.sourceProvider,body.targetProvider));
  });
  app.post("/api/v1/shops/:shopCode/identity-conversion/apply",async c => {
    const shop = await getBillingShop(c,c.req.param("shopCode"));
    if ((await staffPrincipal(c,shop)).staffRole !== "owner") jsonError(403,"只有店铺负责人可以转换身份","FORBIDDEN");
    const body = conversionSchema.and(z.object({ fingerprint:z.string().regex(/^[A-Za-z0-9_-]{43}$/),operationId:z.string().uuid() })).parse(await c.req.json());
    return runPlayerOperation(c,shop.id,"identity-conversion",body,async()=>{
      const repos = createD1Repositories({ db:c.env.DB,shopId:shop.id,id:crypto.randomUUID,now:()=>new Date() });
      return withOperationLease({ repository:repos.operationLocks,scope:"platform.identities",resourceId:shop.id,now:()=>new Date() },async()=>{
        const preview = await snapshot(c,shop.id,body.sourceProvider,body.targetProvider);
        if (preview.fingerprint !== body.fingerprint) jsonError(409,"身份数据已变化，请重新预览","IDENTITY_CONVERSION_STALE");
        if (preview.conflicts.length) jsonError(409,"存在身份冲突，请处理后重新预览","IDENTITY_CONVERSION_CONFLICT");
        const { sourceProvider:source,targetProvider:target } = body;
        // All four writes form one D1 transaction. Uniqueness protects against concurrent target claims.
        await c.env.DB.batch([
          c.env.DB.prepare(`DELETE FROM player_identities AS old WHERE shop_id=? AND provider=?
            AND EXISTS(SELECT 1 FROM player_identities destination WHERE destination.shop_id=old.shop_id
              AND destination.provider=? AND destination.subject=old.subject AND destination.player_id=old.player_id)`).bind(shop.id,source,target),
          c.env.DB.prepare("UPDATE player_identities SET provider=? WHERE shop_id=? AND provider=?").bind(target,shop.id,source),
          c.env.DB.prepare(`DELETE FROM shop_platform_bindings AS old WHERE shop_id=? AND provider=?
            AND EXISTS(SELECT 1 FROM shop_platform_bindings destination WHERE destination.shop_id=old.shop_id
              AND destination.provider=? AND destination.subject=old.subject AND destination.user_id=old.user_id)`).bind(shop.id,source,target),
          c.env.DB.prepare("UPDATE shop_platform_bindings SET provider=? WHERE shop_id=? AND provider=?").bind(target,shop.id,source),
        ]);
        return c.json({ ...preview,converted:true });
      });
    });
  });
}

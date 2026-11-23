import { Hono, type Context } from "hono";
import { z } from "zod";
import { withOperationLease } from "@prism/application";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { sha256 } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { runPlayerOperation } from "./player-operation.js";
import type { AppBindings } from "../../bindings.js";
import { ACCOUNT_PROFILES_SQL } from "../../resources/account-profiles.js";

type C = Context<AppBindings>;
const provider = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine(value => value !== "web-account", "网页账号身份不可转换");
const conversionSchema = z.object({ sourceProvider: provider, targetProvider: provider })
  .refine(value => value.sourceProvider !== value.targetProvider, "原标识和目标标识不能相同");

async function snapshot(c: C, shopId: string, source: string, target: string) {
  const identities = await c.env.DB.prepare(`SELECT i.player_id AS playerId,i.provider,i.subject,p.display_name AS displayName,
      EXISTS(SELECT 1 FROM ${ACCOUNT_PROFILES_SQL} a WHERE a.shop_id=i.shop_id AND a.player_id=i.player_id) AS owned
    FROM player_identities i JOIN players p ON p.shop_id=i.shop_id AND p.id=i.player_id
    WHERE i.shop_id=? AND i.provider IN (?,?) ORDER BY i.provider,i.subject`).bind(shopId,source,target)
    .all<{ playerId:string;provider:string;subject:string;displayName:string;owned:number }>();
  const rows = identities.results.filter(row => row.provider === source);
  const targets = new Map(identities.results.filter(row => row.provider === target).map(row => [row.subject,row.playerId]));
  const conflicts = rows.filter(row => targets.has(row.subject) && targets.get(row.subject) !== row.playerId)
    .map(row => ({ subject:row.subject,reason:"目标身份已属于其他玩家" }));
  return { sourceProvider:source,targetProvider:target,identityCount:rows.length,
    playerCount:new Set(rows.map(row=>row.playerId)).size,
    // Identities on profiles a PRiSM account owns: what the account sees as its bound platform identities.
    bindingCount:rows.filter(row => row.owned).length,conflicts,
    samples:rows.slice(0,20).map(row=>({ playerId:row.playerId,displayName:row.displayName,from:`${source}:${row.subject}`,to:`${target}:${row.subject}` })),
    fingerprint:await sha256(JSON.stringify([source,target,identities.results])) };
}

export const identityConversionRouter = new Hono<AppBindings>();
identityConversionRouter.post("/preview",async c => {
    const shop = getShop(c);
    if ((await staffPrincipal(c,shop)).staffRole !== "owner") jsonError(403,"只有店铺负责人可以转换身份","FORBIDDEN");
    const body = conversionSchema.parse(await c.req.json());
    return c.json(await snapshot(c,shop.id,body.sourceProvider,body.targetProvider));
  });
  identityConversionRouter.post("/apply",async c => {
    const shop = getShop(c);
    if ((await staffPrincipal(c,shop)).staffRole !== "owner") jsonError(403,"只有店铺负责人可以转换身份","FORBIDDEN");
    const body = conversionSchema.and(z.object({ fingerprint:z.string().regex(/^[A-Za-z0-9_-]{43}$/),operationId:z.string().uuid() })).parse(await c.req.json());
    return runPlayerOperation(c,shop.id,"identity-conversion",body,async()=>{
      const repos = getShopDeps(c).repositories;
      return withOperationLease({ repository:repos.operationLocks,scope:"platform.identities",resourceId:shop.id,now:()=>new Date() },async()=>{
        const preview = await snapshot(c,shop.id,body.sourceProvider,body.targetProvider);
        if (preview.fingerprint !== body.fingerprint) jsonError(409,"身份数据已变化，请重新预览","IDENTITY_CONVERSION_STALE");
        if (preview.conflicts.length) jsonError(409,"存在身份冲突，请处理后重新预览","IDENTITY_CONVERSION_CONFLICT");
        const { sourceProvider:source,targetProvider:target } = body;
        // Both writes form one D1 transaction. Uniqueness protects against concurrent target claims.
        await c.env.DB.batch([
          c.env.DB.prepare(`DELETE FROM player_identities AS old WHERE shop_id=? AND provider=?
            AND EXISTS(SELECT 1 FROM player_identities destination WHERE destination.shop_id=old.shop_id
              AND destination.provider=? AND destination.subject=old.subject AND destination.player_id=old.player_id)`).bind(shop.id,source,target),
          c.env.DB.prepare("UPDATE player_identities SET provider=? WHERE shop_id=? AND provider=?").bind(target,shop.id,source),
        ]);
        return c.json({ ...preview,converted:true });
      });
    });
  });

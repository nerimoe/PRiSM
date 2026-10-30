import type { Context } from "hono";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease, type PricingSessionChange, type PricingSessionOrchestrator } from "@prism/application";
import { assertNotBanned, getShopForMachine as getBillingShop, requireShopPlayer } from "./machine-login.js";
import { createD1Executor, createD1Repositories } from "@prism/adapter-d1";
import { PrismDomainError, type SessionTransitionWrite } from "@prism/core";
import { createSqlRepositories, type SqlStatement } from "@prism/storage-sql";
import { requireUser } from "../../middleware/auth.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { jsonError } from "../../http.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import type { AppBindings } from "../../bindings.js";
import type { ScannedResource as ScannedResource } from "./resource-ticket.js";
import { loadResource, mahjongConfigOf } from "../../resources/resource.js";
import { liveSeatsSql } from "../../resources/capabilities/mahjong-occupancy.js";
import { createOccupancy } from "../../resources/occupancy/service.js";

type C = Context<AppBindings, any, any>;
export type { MahjongConfig } from "../../resources/capabilities/catalog.js";
/** The table's plan and size; its size is the resource's capacity. */
async function mahjongConfig(c: C, machine: ScannedResource) {
  const device = await loadResource(c.env.DB, machine.shop_id, machine.id);
  const config = device ? mahjongConfigOf(device) : null;
  return device && config ? { ...config, capacity: device.capacity } : null;
}
// A seat lives as long as the session it runs on; see `mahjong-occupancy.ts`.
const liveSeats = liveSeatsSql;

/** Seats at a table; `mine` marks the viewer's seat: the signed-in user's, or a player's for the bot. */
export async function mahjongState(c: C, machine: ScannedResource, viewer?: { playerId: string }) {
  const config = await mahjongConfig(c, machine);
  if (!config) return null;
  const result = await c.env.DB.prepare(`SELECT p.id AS playerId, p.display_name AS name,
    CASE WHEN ${viewer ? "ms.player_id=?" : "a.user_id=?"} THEN 1 ELSE 0 END AS mine,
    CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing
    FROM (${liveSeats}) ms
    JOIN players p ON p.shop_id=ms.shop_id AND p.id=ms.player_id
    LEFT JOIN shop_player_accounts a ON a.shop_id=ms.shop_id AND a.player_id=ms.player_id
    LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
    WHERE ms.machine_id=? ORDER BY ms.joined_at,ms.player_id`)
    .bind(viewer?.playerId ?? requireUser(c).id,machine.id).all<{playerId:string;name:string;mine:number;playing:number}>();
  return { capacity: config.capacity, seats: result.results.map(s => ({ playerId:s.playerId, name:s.name, mine:!!s.mine, playing:!!s.playing })) };
}

/** A staff member seats a chosen player instead of themselves. */
async function staffTargetPlayer(c: C, shopId: string, playerId: string) {
  const player = await c.env.DB.prepare(
    "SELECT id,status FROM players WHERE shop_id=? AND id=?",
  ).bind(shopId, playerId).first<{id:string;status:string}>();
  if (!player) jsonError(404, "没有找到这个玩家", "PLAYER_NOT_FOUND");
  if (player.status !== "active")
    jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  return player;
}

type Seat = {
  playerId: string; machineId: string; sessionId: string; entrySessionId: string | null;
  entryOwned: number; joinedAt: string; playing: number; planId: string | null; entryPlanId: string | null;
};

async function seatsInShop(c: C, shopId: string) {
  return (await c.env.DB.prepare(`SELECT ms.player_id AS playerId, ms.machine_id AS machineId,
    ms.session_id AS sessionId, ms.entry_session_id AS entrySessionId, ms.entry_owned AS entryOwned,
    ms.joined_at AS joinedAt, CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing,
    json_extract(s.pricing_config_ids_json,'$[0]') AS planId,
    CASE WHEN e.status='active' THEN json_extract(e.pricing_config_ids_json,'$[0]') END AS entryPlanId
    FROM (${liveSeats}) ms
    LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
    LEFT JOIN sessions e ON e.shop_id=ms.shop_id AND e.id=ms.entry_session_id
    WHERE ms.shop_id=? ORDER BY ms.joined_at,ms.player_id`).bind(shopId).all<Seat>()).results;
}

/** Leaving a table releases its own plans, while keeping plans that other active plans require. */
async function prepareSeatBilling(
  pricing: PricingSessionOrchestrator,
  input: { playerId: string; desired: string | null; old?: Seat; joining: boolean; at: Date; metadata: Record<string, unknown>; expectedRevision?: string },
) {
  const changes: PricingSessionChange[] = input.desired ? [{
    action: "activate", pricingConfigId: input.desired, at: input.at,
    expectedRevision: input.expectedRevision, metadata: input.metadata,
  }] : [];
  let result = await pricing.prepare(input.playerId, changes);
  if (input.old) {
    const release = [
      ...(input.old.playing && input.old.planId ? [{ id: input.old.planId, onlyUnused: input.joining }] : []),
      ...(input.old.entryOwned && input.old.entryPlanId ? [{ id: input.old.entryPlanId, onlyUnused: true }] : []),
    ];
    for (const plan of release) {
      if (plan.id === input.desired || !result.active.some(s => s.pricingConfigId === plan.id)) continue;
      const change: PricingSessionChange = { action: "deactivate", pricingConfigId: plan.id, at: input.at };
      const candidate = await pricing.prepare(input.playerId, [...changes, change]);
      if (plan.onlyUnused && candidate.transitions.at(-1)!.stopped.length > 1) continue;
      changes.push(change);
      result = candidate;
    }
  }
  return result;
}

function startsPlaying(here: readonly Seat[], old: Seat | undefined, gamePlan: string | null, capacity: number) {
  return !!gamePlan && (here.length + 1 >= capacity || here.some(s => s.playing)
    || !!old?.playing && old.planId === gamePlan);
}

/** Seat changes can change the price too: confirming a wait must not silently confirm a game. */
function seatRevision(here: readonly Seat[], old: Seat | undefined, gamePlan: string | null, waitingPlan: string | null, capacity: number) {
  return JSON.stringify([gamePlan, waitingPlan, capacity,
    here.map(s => [s.playerId, s.sessionId, s.playing]),
    old ? [old.machineId, old.sessionId, old.entrySessionId, old.entryOwned] : null]);
}

function confirmedBillingRevision(expected: unknown, seats: string) {
  if (expected === undefined) return undefined;
  try {
    const parts: unknown = JSON.parse(String(expected));
    if (Array.isArray(parts) && parts.length === 2 && typeof parts[0] === "string" && parts[1] === seats) return parts[0];
  } catch { /* A stale or malformed confirmation follows the same refusal path. */ }
  throw new PrismDomainError("计费或桌位状态已变化，请重新确认", "PRICING_STATE_REVISION_MISMATCH");
}

/** The confirmation shows the same seat transition as the write, including the old table's release. */
export async function previewMahjong(c: C, machine: ScannedResource, playerId: string) {
  const config = await mahjongConfig(c, machine);
  if (!config) return null;
  const shop = await getBillingShop(c, machine.shop_public_id);
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  const seats = await seatsInShop(c, shop.id);
  const old = seats.find(s => s.playerId === playerId);
  const here = seats.filter(s => s.machineId === machine.id);
  const gamePlan = config.pricingConfigIds[0] ?? null;
  const waitingPlan = await deps.resourceBilling.planOf(machine.id);
  const desired = startsPlaying(here, old, gamePlan, config.capacity) ? gamePlan : waitingPlan;
  if (!desired) return null;
  const result = await prepareSeatBilling(deps.pricingSessions, {
    playerId, desired, old, joining: true, at: new Date(), metadata: {},
  });
  const items = result.transitions.flatMap(t => [...t.started, ...t.stopped, ...t.kept]);
  const item = (session: (typeof result.active)[number]) => ({
    planId: session.pricingConfigId!,
    planName: items.find(i => i.planId === session.pricingConfigId)?.planName ?? session.pricingConfigId!,
    reason: items.find(i => i.planId === session.pricingConfigId)?.reason ?? "kept",
    sessionId: session.id, startedAt: session.startedAt,
  });
  return {
    resourceId: machine.id, pricingConfigId: desired,
    planName: items.find(i => i.planId === desired)?.planName ?? desired,
    changed: !!(result.close.length || result.create.length), revision: JSON.stringify([result.transitions[0]!.revision, seatRevision(here, old, gamePlan, waitingPlan, config.capacity)]),
    started: result.create.map(item), stopped: result.close.map(item),
    kept: result.active.filter(s => !result.create.some(created => created.id === s.id)).map(item),
  };
}

/** Seat moves and every affected player's billing are committed in one D1 transaction. */
async function commitSeats(c: C, shopId: string, billing: SessionTransitionWrite, seats: readonly Seat[], playerId: string) {
  const statements: SqlStatement[] = [];
  // Reuse the session repository's writer, as checkout does, without committing early.
  const writer = createSqlRepositories({
    executor: {
      shopId,
      async first() { throw new Error("Seat commit must not read"); },
      async all() { throw new Error("Seat commit must not read"); },
      async run(sql, params) { statements.push({ sql, params }); },
      async batch(batch) { statements.push(...batch); },
    },
    id: crypto.randomUUID, now: () => new Date(),
  });
  await writer.sessions.applyTransition!(billing);
  statements.push(
    { sql: `DELETE FROM mahjong_seats WHERE shop_id=? AND (shop_id,player_id) NOT IN (SELECT shop_id,player_id FROM (${liveSeats}))`, params: [shopId] },
    { sql: "DELETE FROM mahjong_seats WHERE shop_id=? AND session_id IN (SELECT value FROM json_each(?))", params: [shopId, JSON.stringify(billing.close.map(s => s.id))] },
    { sql: "DELETE FROM mahjong_seats WHERE shop_id=? AND player_id=?", params: [shopId, playerId] },
    ...seats.map(seat => ({
      sql: `INSERT INTO mahjong_seats(shop_id,player_id,machine_id,session_id,entry_session_id,entry_owned,joined_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(shop_id,player_id) DO UPDATE SET
        machine_id=excluded.machine_id,session_id=excluded.session_id,entry_session_id=excluded.entry_session_id,
        entry_owned=excluded.entry_owned,joined_at=excluded.joined_at`,
      params: [shopId, seat.playerId, seat.machineId, seat.sessionId, seat.entrySessionId, seat.entryOwned, seat.joinedAt],
    })),
  );
  await createD1Executor(c.env.DB, shopId).batch(statements);
}

export async function operateMahjong(
  c: C,
  machine: ScannedResource,
  body: Record<string, unknown>,
  options: { staff?: boolean; bot?: { playerId: string } } = {},
) {
  const config = await mahjongConfig(c, machine);
  if (!config) jsonError(409, "这里不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  await assertNotBanned(c, options.bot ? [["machine",machine.id]] : [["user",requireUser(c).id],["machine",machine.id]]);
  const shop = await getBillingShop(c, machine.shop_public_id);
  if (!options.staff && !options.bot) {
    checkShopLocation(shop, "machine", body.location);
  }
  const targetPlayerId = typeof body.playerId === "string" ? body.playerId : "";
  if (options.staff && !targetPlayerId) jsonError(400, "请选择玩家", "PLAYER_REQUIRED");
  const player = options.bot ? await staffTargetPlayer(c, shop.id, options.bot.playerId)
    : options.staff ? await staffTargetPlayer(c, shop.id, targetPlayerId) : await requireShopPlayer(c, shop);
  const joining = body.action === "mahjong.join" || body.action === "mahjong.seat";
  const confirmed = !!options.staff || !!options.bot || body.consent === true;
  const repos = createD1Repositories({ db: c.env.DB, shopId: shop.id, id: crypto.randomUUID, now: () => new Date() });
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  const once = (action: () => Promise<Response>) => options.bot ? action() : runPlayerOperation(c, shop.id, `mahjong/${machine.id}`, body, action);
  return once(() => withOperationLease({
    // One shop seat lock serializes transfers across tables; billing locks still protect each player.
    repository: repos.operationLocks, scope: "mahjong.table", resourceId: shop.id, now: () => new Date(),
  }, async () => {
    const before = await seatsInShop(c, shop.id);
    const ids = [...new Set([player.id, ...before.filter(s => s.machineId === machine.id).map(s => s.playerId)])].sort();
    const lockPlayers = <T,>(index: number, action: () => Promise<T>): Promise<T> => index === ids.length ? action()
      : withOperationLease({ repository: repos.operationLocks, scope: PLAYER_BILLING_LOCK_SCOPE, resourceId: ids[index]!, now: () => new Date() }, () => lockPlayers(index + 1, action));
    return lockPlayers(0, async () => {
      const seats = await seatsInShop(c, shop.id);
      const old = seats.find(s => s.playerId === player.id);
      const here = seats.filter(s => s.machineId === machine.id);
      if (joining && old?.machineId === machine.id)
        return c.json({ mahjong: await mahjongState(c, machine, options.bot), alreadySeated: true });
      if (!joining && old?.machineId !== machine.id) jsonError(409, "你不在这张麻将桌上", "MAHJONG_NOT_SEATED");
      if (joining && here.length >= config.capacity) jsonError(409, "已满桌", "MAHJONG_TABLE_FULL");
      const at = new Date();
      const gamePlan = config.pricingConfigIds[0] ?? null;
      const waitingPlan = await deps.resourceBilling.planOf(machine.id);
      if (joining && waitingPlan && !gamePlan) jsonError(409, "请店家配置麻将计费规则", "DEVICE_CONFIGURATION_REQUIRED");
      const expectedRevision = confirmedBillingRevision(body.expectedRevision, seatRevision(here, old, gamePlan, waitingPlan, config.capacity));
      const playing = joining && startsPlaying(here, old, gamePlan, config.capacity);
      const running = joining && waitingPlan ? await deps.resourceBilling.activeSession({ resourceId: machine.id, playerId: player.id }) : null;
      if (joining && waitingPlan && !running && !options.staff && !options.bot && body.consent === true)
        checkShopLocation(shop, "checkin", body.location);
      if (joining && waitingPlan && !confirmed && !running) jsonError(403, "请先确认开始计费", "CHECKIN_REQUIRED");

      const changedSeats: Seat[] = [];
      const prepared: Awaited<ReturnType<typeof deps.pricingSessions.prepare>>[] = [];
      const newcomers = joining ? (playing ? [...here.filter(s => !s.playing), null] : [null]) : [null];
      for (const seat of newcomers) {
        const playerId = seat?.playerId ?? player.id;
        const desired = joining ? (playing ? gamePlan : waitingPlan) : null;
        const result = await prepareSeatBilling(deps.pricingSessions, {
          playerId, desired, old: playerId === player.id ? old : undefined, joining, at,
          ...(playerId === player.id ? { expectedRevision } : {}),
          metadata: playing ? { mahjongDeviceId: machine.id } : { resourceId: machine.id },
        });
        prepared.push(result);
        if (joining) {
          const session = desired ? result.active.find(s => s.pricingConfigId === desired)! : null;
          if (seat) changedSeats.push({ ...seat, sessionId: session!.id, playing: 1 });
          else {
            const entry = !playing ? session : result.active.find(s => s.pricingConfigId === waitingPlan) ?? running;
            changedSeats.push({
              playerId, machineId: machine.id, sessionId: playing ? session!.id : crypto.randomUUID(),
              entrySessionId: entry?.id ?? null,
              entryOwned: +(entry?.metadata?.resourceId === machine.id || !!old?.entryOwned && old.entrySessionId === entry?.id),
              joinedAt: at.toISOString(), playing: +playing, planId: playing ? desired : null, entryPlanId: entry?.pricingConfigId ?? null,
            });
          }
        }
      }
      await commitSeats(c, shop.id, {
        close: prepared.flatMap(p => [...p.close]), create: prepared.flatMap(p => [...p.create]),
      }, changedSeats, player.id);
      const occupancy = createOccupancy({ db: c.env.DB, shopId: shop.id });
      if (old && (!joining || old.machineId !== machine.id))
        await occupancy.left({ resourceId: old.machineId, playerId: player.id, at }).catch(error => console.error("Occupancy release failed", error));
      await occupancy.syncHeld(at).catch(error => console.error("Occupancy sync failed", error));
      const sync = Promise.all(ids.map(id => refreshActivityBill(c.env, shop.id, id, false, true)))
        .catch(error => console.error("Mahjong live bill sync failed", error));
      try { c.executionCtx.waitUntil(sync); } catch { void sync; }
      const remaining = (await deps.pricingSessions.getActive(player.id)).active.map(plan => plan.planName);
      return c.json({ mahjong: await mahjongState(c, machine, options.bot), billing: { remaining },
        ...(joining && old ? { movedFrom: { id: old.machineId } } : {}) });
    });
  }).catch(error => {
    if (String(error).includes("PRICING_CONFIG_NOT_IN_RELEASE"))
      jsonError(409, "当前入场版本不包含此计费方案，请先结账后重新入场", "PRICING_CONFIG_NOT_IN_RELEASE");
    if (error && typeof error === "object" && "code" in error && error.code === "OPERATION_IN_PROGRESS")
      jsonError(409, "其他操作正在进行，请重试", "OPERATION_IN_PROGRESS");
    throw error;
  }));
}

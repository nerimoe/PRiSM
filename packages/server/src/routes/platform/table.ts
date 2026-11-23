import type { Context } from "hono";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease, type PricingSessionChange, type PricingSessionOrchestrator } from "@prism/application";
import { assertNotBanned, getShopForMachine as getBillingShop, requireShopPlayer } from "./machine-login.js";
import { createD1Executor, createD1Repositories } from "@prism/adapter-d1";
import { PrismDomainError, type SessionTransitionWrite } from "@prism/core";
import { createSqlRepositories, type SqlStatement } from "@prism/storage-sql";
import { requireUser } from "../../middleware/auth.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { publishShopFacts, type FactOrigin } from "../../events/shop-facts.js";
import { requestOrigin } from "../../middleware/tenant.js";
import { jsonError } from "../../http.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import type { AppBindings, TenantShop } from "../../bindings.js";
import type { ScannedResource as ScannedResource } from "./resource-ticket.js";
import { loadResource, tableConfigOf, type Resource } from "../../resources/resource.js";
import { liveSeatsSql } from "../../resources/capabilities/table-occupancy.js";
import { createOccupancy } from "../../resources/occupancy/service.js";
import { logger } from "../../log.js";

const log = logger("table");

type C = Context<AppBindings, any, any>;
/** What seating needs of where it runs: a route's context, or the shop hub for a bot's command. */
export type TableRuntime = Pick<C, "env"> & { executionCtx: { waitUntil(promise: Promise<unknown>): void } };
export type { TableConfig } from "../../resources/capabilities/catalog.js";
/** The table's plan and size; its size is the resource's capacity. */
async function tableConfig(c: Pick<C, "env">, machine: ScannedResource, known?: Resource | null) {
  const device = known ?? await loadResource(c.env.DB, machine.shop_id, machine.id);
  const config = device ? tableConfigOf(device) : null;
  return device && config ? { ...config, capacity: device.capacity } : null;
}
// A seat lives as long as the session it runs on; see `table-occupancy.ts`.
const liveSeats = liveSeatsSql;

/** Seats at a table; `mine` marks the viewer's seat: the signed-in user's, or a player's for the bot. */
export async function tableState(c: Pick<C, "env"> | C, machine: ScannedResource, viewer?: { playerId: string }, device?: Resource | null) {
  const config = await tableConfig(c, machine, device);
  if (!config) return null;
  const result = await c.env.DB.prepare(`SELECT p.id AS playerId, p.display_name AS name,
    CASE WHEN ${viewer ? "ts.player_id=?" : "a.user_id=?"} THEN 1 ELSE 0 END AS mine,
    CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing
    FROM (${liveSeats}) ts
    JOIN players p ON p.shop_id=ts.shop_id AND p.id=ts.player_id
    LEFT JOIN shop_player_accounts a ON a.shop_id=ts.shop_id AND a.player_id=ts.player_id
    LEFT JOIN sessions s ON s.shop_id=ts.shop_id AND s.id=ts.session_id
    WHERE ts.machine_id=? ORDER BY ts.joined_at,ts.player_id`)
    .bind(viewer?.playerId ?? requireUser(c as C).id,machine.id).all<{playerId:string;name:string;mine:number;playing:number}>();
  return { capacity: config.capacity, seats: result.results.map(s => ({ playerId:s.playerId, name:s.name, mine:!!s.mine, playing:!!s.playing })) };
}

/** A staff member seats a chosen player instead of themselves. */
async function staffTargetPlayer(c: Pick<C, "env">, shopId: string, playerId: string) {
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

async function seatsInShop(c: Pick<C, "env">, shopId: string) {
  return (await c.env.DB.prepare(`SELECT ts.player_id AS playerId, ts.machine_id AS machineId,
    ts.session_id AS sessionId, ts.entry_session_id AS entrySessionId, ts.entry_owned AS entryOwned,
    ts.joined_at AS joinedAt, CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing,
    json_extract(s.pricing_config_ids_json,'$[0]') AS planId,
    CASE WHEN e.status='active' THEN json_extract(e.pricing_config_ids_json,'$[0]') END AS entryPlanId
    FROM (${liveSeats}) ts
    LEFT JOIN sessions s ON s.shop_id=ts.shop_id AND s.id=ts.session_id
    LEFT JOIN sessions e ON e.shop_id=ts.shop_id AND e.id=ts.entry_session_id
    WHERE ts.shop_id=? ORDER BY ts.joined_at,ts.player_id`).bind(shopId).all<Seat>()).results;
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

/**
 * Whether a player sitting down plays now: at once on a table that starts on
 * sitting down, otherwise once the table is full or already playing.
 */
function startsPlaying(here: readonly Seat[], old: Seat | undefined, gamePlan: string | null, capacity: number, startWhen: "full" | "seated" = "full") {
  if (!gamePlan) return false;
  if (startWhen === "seated") return true;
  return here.length + 1 >= capacity || here.some(s => s.playing)
    || !!old?.playing && old.planId === gamePlan;
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
export async function previewTable(c: C, machine: ScannedResource, playerId: string) {
  const config = await tableConfig(c, machine);
  if (!config) return null;
  const shop = await getBillingShop(c, machine.shop_public_id);
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  const seats = await seatsInShop(c, shop.id);
  const old = seats.find(s => s.playerId === playerId);
  const here = seats.filter(s => s.machineId === machine.id);
  const gamePlan = config.pricingConfigIds[0] ?? null;
  const waitingPlan = await deps.resourceBilling.planOf(machine.id);
  const desired = startsPlaying(here, old, gamePlan, config.capacity, config.startWhen) ? gamePlan : waitingPlan;
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
async function commitSeats(c: Pick<C, "env">, shopId: string, billing: SessionTransitionWrite, seats: readonly Seat[], playerId: string) {
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
    { sql: `DELETE FROM table_seats WHERE shop_id=? AND (shop_id,player_id) NOT IN (SELECT shop_id,player_id FROM (${liveSeats}))`, params: [shopId] },
    { sql: "DELETE FROM table_seats WHERE shop_id=? AND session_id IN (SELECT value FROM json_each(?))", params: [shopId, JSON.stringify(billing.close.map(s => s.id))] },
    { sql: "DELETE FROM table_seats WHERE shop_id=? AND player_id=?", params: [shopId, playerId] },
    ...seats.map(seat => ({
      sql: `INSERT INTO table_seats(shop_id,player_id,machine_id,session_id,entry_session_id,entry_owned,joined_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(shop_id,player_id) DO UPDATE SET
        machine_id=excluded.machine_id,session_id=excluded.session_id,entry_session_id=excluded.entry_session_id,
        entry_owned=excluded.entry_owned,joined_at=excluded.joined_at`,
      params: [shopId, seat.playerId, seat.machineId, seat.sessionId, seat.entrySessionId, seat.entryOwned, seat.joinedAt],
    })),
  );
  await createD1Executor(c.env.DB, shopId).batch(statements);
}

/** A table after a move, and for someone getting up what still bills. */
export type TableMove = {
  table: NonNullable<Awaited<ReturnType<typeof tableState>>> | null;
  billing?: { remaining: string[] };
  alreadySeated?: boolean;
  movedFrom?: { id: string };
};

export async function operateTable(
  c: C,
  machine: ScannedResource,
  body: Record<string, unknown>,
  options: { staff?: boolean; bot?: { playerId: string } } = {},
) {
  const config = await tableConfig(c, machine);
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
  const joining = body.action === "table.join" || body.action === "table.seat";
  const once = (action: () => Promise<Response>) => options.bot ? action() : runPlayerOperation(c, shop.id, `table/${machine.id}`, body, action);
  return once(async () => c.json(await moveTable(c, shop, machine, player, {
    joining, onBehalf: !!options.staff || !!options.bot, body, viewer: options.bot,
    origin: requestOrigin(c, options.staff ? "merchant" : "page"),
  })));
}

/**
 * Seat or unseat a player whose right to it the caller has checked: a route for a
 * signed-in player or staff, or a bot's command. `onBehalf`: staff or a bot act for
 * the player, which is their confirmation.
 */
export async function moveTable(
  c: TableRuntime,
  shop: TenantShop,
  machine: ScannedResource,
  player: { id: string },
  input: {
    joining: boolean; onBehalf: boolean; body: Record<string, unknown>; viewer?: { playerId: string };
    /** Where the move was asked for, for the facts it publishes. */
    origin: FactOrigin;
  },
): Promise<TableMove> {
  const { joining, onBehalf, body, viewer } = input;
  const config = await tableConfig(c, machine);
  if (!config) jsonError(409, "这里不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  const confirmed = onBehalf || body.consent === true;
  const repos = createD1Repositories({ db: c.env.DB, shopId: shop.id, id: crypto.randomUUID, now: () => new Date() });
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  return withOperationLease({
    // One shop seat lock serializes transfers across tables; billing locks still protect each player.
    repository: repos.operationLocks, scope: "table.seat", resourceId: shop.id, now: () => new Date(),
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
        return { table: await tableState(c, machine, viewer), alreadySeated: true };
      if (!joining && old?.machineId !== machine.id) jsonError(409, "你不在这张桌游桌上", "TABLE_NOT_SEATED");
      if (joining && here.length >= config.capacity) jsonError(409, "已满桌", "TABLE_FULL");
      const at = new Date();
      const gamePlan = config.pricingConfigIds[0] ?? null;
      const waitingPlan = await deps.resourceBilling.planOf(machine.id);
      if (joining && waitingPlan && !gamePlan) jsonError(409, "请店家配置桌游计费规则", "DEVICE_CONFIGURATION_REQUIRED");
      const expectedRevision = confirmedBillingRevision(body.expectedRevision, seatRevision(here, old, gamePlan, waitingPlan, config.capacity));
      const playing = joining && startsPlaying(here, old, gamePlan, config.capacity, config.startWhen);
      const running = joining && waitingPlan ? await deps.resourceBilling.activeSession({ resourceId: machine.id, playerId: player.id }) : null;
      if (joining && waitingPlan && !running && !onBehalf && body.consent === true)
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
          metadata: playing ? { tableDeviceId: machine.id } : { resourceId: machine.id },
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
        await occupancy.left({ resourceId: old.machineId, playerId: player.id, at }).catch(error => log.error("occupancy release failed", { error }));
      await occupancy.syncHeld(at).catch(error => log.error("occupancy sync failed", { error }));
      // What happened at the table; the listeners move the players' pages and bills and the table's idle timer.
      await publishShopFacts({ db: c.env.DB, env: c.env, shopId: shop.id }, input.origin, ids.map((id) => ({
        name: "seat.changed" as const, resourceId: machine.id, playerId: id,
        payload: { joined: joining, ...(old && old.machineId !== machine.id ? { left: old.machineId } : {}) },
      })));
      const remaining = (await deps.pricingSessions.getActive(player.id)).active.map(plan => plan.planName);
      return { table: await tableState(c, machine, viewer), billing: { remaining },
        ...(joining && old ? { movedFrom: { id: old.machineId } } : {}) };
    });
  }).catch(error => {
    if (String(error).includes("PRICING_CONFIG_NOT_IN_RELEASE"))
      jsonError(409, "当前入场版本不包含此计费方案，请先结账后重新入场", "PRICING_CONFIG_NOT_IN_RELEASE");
    if (error && typeof error === "object" && "code" in error && error.code === "OPERATION_IN_PROGRESS")
      jsonError(409, "其他操作正在进行，请重试", "OPERATION_IN_PROGRESS");
    throw error;
  });
}

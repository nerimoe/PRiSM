/**
 * What happened at a cabinet between two reads of its books.
 *
 * The IO only reports what amdaemon's backup holds; the platform decides what
 * a change means. The counters are cumulative, so a read that was missed in
 * between loses nothing: the next one carries the whole difference.
 *
 * - `cabinet.reset`: a counter went down. Only clearing the books does that, so
 *   nothing else is read into the same step.
 * - `cabinet.coin`: coins went in (`total_coin` rose).
 * - `cabinet.consumed`: credits were spent, mostly by starting a game. What the
 *   cabinet had, plus what it was given since, minus what it has now.
 *
 * Credit is read from the first player slot: maimai shares one coin slot, so
 * both slots always hold the same.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { CabinetSnapshot } from "../../hardware/aimeio-relay.js";
import { hinataConfigOf, type Resource } from "../resource.js";

export type CabinetBooks = Extract<CabinetSnapshot, { players: unknown }>;

export type CabinetChange =
  | { type: "cabinet.reset"; detail: { credit: number } }
  | { type: "cabinet.coin"; detail: { coins: number; credit: number } }
  | { type: "cabinet.consumed"; detail: { credits: number; credit: number } };

export function isCabinetBooks(snapshot: CabinetSnapshot | null | undefined): snapshot is CabinetBooks {
  return !!snapshot && !("error" in snapshot);
}

export function cabinetChanges(before: CabinetBooks, after: CabinetBooks): CabinetChange[] {
  const b = before.bookkeeping;
  const a = after.bookkeeping;
  const credit = after.players[0]!.credit;
  const counters = ["totalCoin", "coinCredit", "serviceCredit", "emoneyCredit", "totalCredit"] as const;
  if (counters.some((key) => a[key] < b[key])) return [{ type: "cabinet.reset", detail: { credit } }];

  const changes: CabinetChange[] = [];
  const coins = a.totalCoin - b.totalCoin;
  const credited = a.coinCredit - b.coinCredit;
  if (coins > 0) changes.push({ type: "cabinet.coin", detail: { coins, credit } });
  const given = credited + (a.serviceCredit - b.serviceCredit) + (a.emoneyCredit - b.emoneyCredit);
  const spent = before.players[0]!.credit + given - credit;
  if (spent > 0) changes.push({ type: "cabinet.consumed", detail: { credits: spent, credit } });
  return changes;
}

/**
 * How long a coin through the platform holds off the next one, so the books
 * the next is judged by already show the first. The IO reads them every 500 ms.
 */
export const COIN_SETTLE_MS = 2000;

/**
 * Where a cabinet stands against its `coinCap`: `unknown` when no limit is set or
 * the books are not known now (no IO reporting them, or its link is down).
 */
export async function coinLimit(db: D1DatabaseLike, shopId: string, device: Resource): Promise<"full" | "room" | "unknown"> {
  const cap = hinataConfigOf(device)?.coinCap ?? null;
  if (cap === null) return "unknown";
  const rows = await db.prepare(
    "SELECT key, value_json FROM device_state WHERE shop_id = ? AND device_id = ? AND capability = 'hinata_io' AND key IN ('cabinet', 'link')",
  ).bind(shopId, device.id).all<{ key: string; value_json: string }>();
  const state = Object.fromEntries(rows.results.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
  const books = state.cabinet as { players?: Array<{ credit: number }> } | undefined;
  const credit = books?.players?.[0]?.credit;
  if (state.link !== "online" || typeof credit !== "number") return "unknown";
  return credit >= cap ? "full" : "room";
}

/** Whether the device's direct-connected IO is connected now. */
export async function ioConnected(db: D1DatabaseLike, shopId: string, deviceId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT value_json FROM device_state WHERE shop_id = ? AND device_id = ? AND capability = 'hinata_io' AND key = 'link'",
  ).bind(shopId, deviceId).first<{ value_json: string }>();
  return row?.value_json === JSON.stringify("online");
}

/**
 * Whether a coin through the platform may go in, judged by the cabinet's books.
 *
 * - `full`: the cabinet already holds the device's `coinCap` credits.
 * - `settling`: another coin went in moments ago and the books may not show it yet.
 * - `ok`: it may; the settle lock is taken for this coin.
 * - `unknown`: no limit is set, or the books are not known now (no IO reporting
 *   them, or its link is down); the caller's cooldown decides instead.
 */
export async function coinGate(
  db: D1DatabaseLike,
  shopId: string,
  device: Resource,
  operationId: string,
  now = new Date(),
): Promise<"ok" | "full" | "settling" | "unknown"> {
  const limit = await coinLimit(db, shopId, device);
  if (limit !== "room") return limit;
  const claim = await db.prepare(
    `INSERT INTO operation_locks(shop_id,scope,resource_id,lock_id,expires_at,acquired_at)
     VALUES (?,'device.coin-settle',?,?,?,?)
     ON CONFLICT(shop_id,scope,resource_id) DO UPDATE SET
       lock_id=excluded.lock_id,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at
     WHERE operation_locks.expires_at<=excluded.acquired_at RETURNING lock_id`,
  ).bind(shopId, device.id, operationId, new Date(now.getTime() + COIN_SETTLE_MS).toISOString(), now.toISOString()).first();
  return claim ? "ok" : "settling";
}

/**
 * Whether a coin through the platform may go in now. A cabinet that reports its
 * books and has a coin limit is judged by them (`coinGate`); any other keeps the
 * shop's coin cooldown.
 */
export async function claimCoin(db:D1DatabaseLike,shopId:string,device:Resource,id:string):Promise<"ok"|"cooldown"|"full"> {
  const gate=await coinGate(db,shopId,device,id);
  if(gate==="ok")return "ok";
  if(gate==="full")return "full";
  if(gate==="settling")return "cooldown";
  return await claimCooldown(db,shopId,device.id,id)?"ok":"cooldown";
}

async function claimCooldown(db:D1DatabaseLike,shopId:string,machineId:string,id:string) {
  const configured=await db.prepare(
    "SELECT json_extract(value_json,'$.coinCooldownMs') AS cooldown FROM app_settings WHERE shop_id=? AND key='venue.operations'",
  ).bind(shopId).first<{cooldown:number|null}>();
  const raw=configured?.cooldown;
  const cooldown=typeof raw==="number"&&Number.isInteger(raw)&&raw>=0?raw:60000;
  const now=Date.now();
  const claim=await db.prepare(
    `INSERT INTO operation_locks(shop_id,scope,resource_id,lock_id,expires_at,acquired_at)
     VALUES (?,'device.coin',?,?,?,?)
     ON CONFLICT(shop_id,scope,resource_id) DO UPDATE SET
       lock_id=excluded.lock_id,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at
     WHERE operation_locks.expires_at<=excluded.acquired_at RETURNING lock_id`,
  ).bind(shopId,machineId,id,new Date(now+cooldown).toISOString(),new Date(now).toISOString()).first();
  return !!claim;
}

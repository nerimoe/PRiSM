import type { Context } from "hono";
import { decryptSecret, encryptSecret, sha256 } from "./crypto";
import { getMachineByPublicId, machineSelect } from "./db";
import { jsonError } from "./http";
import type { AppBindings, MachineRow } from "./types";

export const machineSessionTtlSeconds = 300;
type Navigation = { shopCode: string; publicId: string; expiresAt: number };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const navigationKey = (secret: string) => `prism:machine-navigation:v1:${secret}`;

/** Opaque navigation only: the API still validates the current machine and shop. */
export async function mintMachineTicket(secret: string, shopCode: string, publicId: string, now = Date.now()) {
  if (!validId(shopCode) || !validId(publicId)) jsonError(404, "机台不可用");
  if (!secret) jsonError(503, "会话密钥尚未配置");
  const payload: Navigation = { shopCode, publicId, expiresAt: now + machineSessionTtlSeconds * 1000 };
  return { ticket: `v1.${await encryptSecret(JSON.stringify(payload), navigationKey(secret))}`, expiresIn: machineSessionTtlSeconds };
}

export async function readMachineTicket(secret: string, ticket: string, now = Date.now()): Promise<Navigation> {
  let payload: Navigation;
  try {
    if (!secret || !ticket.startsWith("v1.") || ticket.length > 1024) throw new Error("Invalid ticket");
    payload = JSON.parse(await decryptSecret(ticket.slice(3), navigationKey(secret)));
    if (!payload || !validId(payload.shopCode) || !validId(payload.publicId)
      || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now
      || payload.expiresAt > now + machineSessionTtlSeconds * 1000) throw new Error("Expired ticket");
  } catch { jsonError(410, "本次会话已失效", "TICKET_EXPIRED"); }
  return payload;
}

export async function createMachineSession(c: Context<AppBindings>, shopCode: string, publicId: string) {
  const normalizedShopCode = shopCode.trim(), normalizedPublicId = publicId.trim();
  const machine = await getMachineByPublicId(c.env.DB, normalizedPublicId);
  if (!machine || machine.enabled !== 1 || machine.shop_public_id !== normalizedShopCode) jsonError(404, "机台不可用");
  return { ...await mintMachineTicket(c.env.SESSION_SECRET, normalizedShopCode, normalizedPublicId), publicId: machine.public_id, machine };
}

export async function resolveMachineSession(c: Context<AppBindings>, ticket: string, routePublicId?: string): Promise<{ publicId: string; machine: MachineRow; coinUsed: boolean }> {
  const normalizedTicket = ticket.trim(), route = routePublicId?.trim();
  if (!normalizedTicket || normalizedTicket.length > 1024) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  let machine: MachineRow | null;
  if (normalizedTicket.startsWith("v1.")) {
    const navigation = await readMachineTicket(c.env.SESSION_SECRET, normalizedTicket);
    if (route && route !== navigation.publicId) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
    machine = await getMachineByPublicId(c.env.DB, navigation.publicId);
    if (!machine || machine.shop_public_id !== navigation.shopCode) jsonError(404, "机台不可用");
  } else {
    // Accept already-issued native/web DB tickets until their original expiry.
    machine = await c.env.DB.prepare(`${machineSelect}
      JOIN machine_tickets t ON t.machine_id=machines.id WHERE t.token_hash=? AND t.expires_at>?`)
      .bind(await sha256(normalizedTicket), new Date().toISOString()).first<MachineRow>();
    if (!machine || route && route !== machine.public_id) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  }
  if (machine.enabled !== 1) jsonError(404, "机台不可用");
  return { publicId: machine.public_id, machine, coinUsed: false };
}

export function publicMachine(machine: MachineRow) {
  return {
    publicId: machine.public_id,
    name: machine.name,
    kind: machine.kind,
    coinAfterSwipe: !!machine.coin_after_swipe,
    capabilities: {
      power: !!machine.ha_binding_encrypted,
      card: !!machine.hinata_url_encrypted,
      coin:
        !!machine.hinata_url_encrypted && !!machine.hinata_password_encrypted && machine.coin_key > 0,
      door: !!machine.ttlock_lock_id,
      mahjong: !!machine.mahjong_config_json,
    },
    webOnly:
      !!machine.coin_after_swipe ||
      !!machine.billing_enabled ||
      !machine.hinata_url_encrypted ||
      !!machine.ttlock_lock_id ||
      !!machine.ha_binding_encrypted,
    shop: {
      name: machine.shop_name,
      publicId: machine.shop_public_id,
      locationEnabled: !!machine.machine_geo,
      machineGeo: !!machine.machine_geo,
      billingEnabled: !!machine.billing_enabled,
      heroUrl: machine.shop_hero_url,
      latitude: machine.latitude,
      longitude: machine.longitude,
      radiusMeters: machine.radius_meters,
    },
  };
}

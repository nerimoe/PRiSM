import type { Context } from "hono";
import { randomToken, sha256 } from "./crypto";
import { getMachineByPublicId } from "./db";
import { jsonError } from "./http";
import type { AppBindings, MachineRow } from "./types";

export const machineSessionTtlSeconds = 300;

export type MachineSession = {
  ticket: string;
  expiresIn: number;
  publicId: string;
  machine: MachineRow;
};

export async function createMachineSession(
  c: Context<AppBindings>,
  shopCode: string,
  publicId: string,
): Promise<MachineSession> {
  const normalizedShopCode = shopCode.trim();
  const normalizedPublicId = publicId.trim();
  const machine = await getMachineByPublicId(c.env.DB, normalizedPublicId);
  if (
    !machine ||
    machine.enabled !== 1 ||
    machine.shop_public_id !== normalizedShopCode
  ) {
    jsonError(404, "机台不可用");
  }

  const ticket = randomToken(24);
  await c.env.DB.prepare(
    "INSERT INTO machine_tickets (token_hash,machine_id,expires_at) VALUES (?,?,?)",
  )
    .bind(
      await sha256(ticket),
      machine.id,
      new Date(Date.now() + machineSessionTtlSeconds * 1000).toISOString(),
    )
    .run();

  return {
    ticket,
    expiresIn: machineSessionTtlSeconds,
    publicId: machine.public_id,
    machine,
  };
}

export async function resolveMachineSession(
  c: Context<AppBindings>,
  ticket: string,
  routePublicId?: string,
): Promise<{ publicId: string; machine: MachineRow; coinUsed: boolean }> {
  const normalizedTicket = ticket.trim();
  const normalizedRoutePublicId = routePublicId?.trim();
  if (!normalizedTicket) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");

  const row = await c.env.DB.prepare(
    "SELECT m.public_id,t.coin_operation_id FROM machine_tickets t JOIN machines m ON m.id=t.machine_id WHERE t.token_hash=? AND t.expires_at>? AND t.claimed_at IS NULL",
  )
    .bind(await sha256(normalizedTicket), new Date().toISOString())
    .first<{ public_id: string; coin_operation_id: string | null }>();
  if (
    !row ||
    (normalizedRoutePublicId && normalizedRoutePublicId !== row.public_id)
  )
    jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  const publicId = row.public_id;
  const machine = await getMachineByPublicId(c.env.DB, publicId);
  if (!machine || machine.enabled !== 1) jsonError(404, "机台不可用");
  return {
    publicId: machine.public_id,
    machine,
    coinUsed: !!row.coin_operation_id,
  };
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

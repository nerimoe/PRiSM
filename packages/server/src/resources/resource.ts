/**
 * A device as the rest of the platform sees it: identity plus the capabilities
 * bound to it. Nothing outside this module reads capability storage directly,
 * so "what can this device do" has exactly one answer.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { decryptSecret } from "../crypto.js";
import { adoptHaBindings } from "./capabilities/ha-connections.js";
import { adoptLegacyRegistries } from "./capabilities/legacy-registries.js";
import {
  capabilities,
  capabilitySpec,
  hasResourceLink,
  legacyCoin,
  type ActionName,
  type BoundView,
  type CabinetKey,
  type CapabilityId,
  type CoinConfig,
  type DoorConfig,
  type HinataConfig,
  type HostConfig,
  type IotConfig,
  type KeysConfig,
  type ResourceButton,
  type TableConfig,
} from "./capabilities/catalog.js";
import { logger } from "../log.js";

const log = logger("resources");

export type BoundCapability = {
  id: CapabilityId;
  config: Record<string, unknown>;
  /** Names of secrets present. The values stay encrypted until `secret()` is called. */
  secretNames: ReadonlySet<string>;
  credentialHash: string | null;
};

export type Resource = {
  id: string;
  shopId: string;
  publicId: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  kind: string;
  /** How many can use it at once; 0 for one nobody occupies. A table's size. */
  capacity: number;
  /** How long someone counts as on it after the last sign of them. */
  occupancyMinutes: number;
  capabilities: ReadonlyMap<CapabilityId, BoundCapability>;
};

type ResourceRow = {
  id: string;
  shop_id: string;
  public_id: string;
  name: string;
  aliases_json: string | null;
  enabled: number;
  kind: string;
  capacity: number | null;
  occupancy_minutes: number | null;
};

type CapabilityRow = {
  device_id: string;
  capability: string;
  config_json: string;
  secret_json: string;
  credential_hash: string | null;
};

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseAliases(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function bind(row: CapabilityRow): BoundCapability | null {
  const spec = capabilitySpec(row.capability);
  // A capability this release does not know is ignored rather than guessed at.
  if (!spec) return null;
  const parsed = spec.config.safeParse(parseObject(row.config_json));
  if (!parsed.success) return null;
  const secrets = parseObject(row.secret_json);
  return {
    id: spec.id,
    config: parsed.data as Record<string, unknown>,
    secretNames: new Set(Object.keys(secrets).filter((key) => typeof secrets[key] === "string" && secrets[key])),
    credentialHash: row.credential_hash,
  };
}

const deviceColumns = "id, shop_id, public_id, name, aliases_json, enabled, kind, capacity, occupancy_minutes";

/**
 * Upgrade older stored rows in memory without mutating storage:
 * - Pre-0056 `hinata_io` rows holding `coinKey` expand into `hinata_io` + `coin`.
 * - Pre-`keys` rows with `hinata_io.keys`, `host.keys`, or legacy GPIO `coin`
 *   synthesize a unified `keys` capability so actions and UI work seamlessly.
 */
function upgradeLegacyCapabilityRows(capabilityRows: CapabilityRow[]): CapabilityRow[] {
  const rowsRead = capabilityRows.flatMap((row) => {
    if (row.capability !== "hinata_io") return [row];
    const raw = parseObject(row.config_json);
    const moved = legacyCoin(raw);
    if (!moved) return [row];
    const io = { ...row, config_json: JSON.stringify(moved.io) };
    const hasCoin = capabilityRows.some((other) => other.device_id === row.device_id && other.capability === "coin");
    return moved.coin && !hasCoin
      ? [io, { ...row, capability: "coin", config_json: JSON.stringify(moved.coin), secret_json: "{}", credential_hash: null }]
      : [io];
  });

  // Group by device to check whether a legacy row needs a synthesized `keys` capability.
  const byDevice = new Map<string, CapabilityRow[]>();
  for (const row of rowsRead) {
    const list = byDevice.get(row.device_id) ?? [];
    list.push(row);
    byDevice.set(row.device_id, list);
  }

  const finalRows: CapabilityRow[] = [];
  for (const [deviceId, list] of byDevice) {
    const hasKeys = list.some((r) => r.capability === "keys");
    if (hasKeys) {
      finalRows.push(...list);
      continue;
    }

    const synthesizedButtons: ResourceButton[] = [];
    const seenIds = new Set<string>();
    const addKeyboard = (raw: unknown) => {
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const one = item as Partial<CabinetKey>;
        if (typeof one.id !== "string" || typeof one.name !== "string" || typeof one.key !== "number") continue;
        if (seenIds.has(one.id)) continue;
        seenIds.add(one.id);
        synthesizedButtons.push({ id: one.id, name: one.name, mode: "keyboard", key: one.key });
      }
    };

    const nextList = list.map((row) => {
      const cfg = parseObject(row.config_json);
      if (row.capability === "hinata_io") addKeyboard(cfg.keys);
      if (row.capability === "host") addKeyboard(cfg.keys);
      if (row.capability === "coin" && cfg.method === "gpio" && typeof cfg.nodeId === "string" && typeof cfg.pin === "number") {
        const coinBtnId = "coin";
        if (!seenIds.has(coinBtnId)) {
          seenIds.add(coinBtnId);
          synthesizedButtons.push({
            id: coinBtnId,
            name: "投币",
            mode: "gpio",
            nodeId: cfg.nodeId,
            pin: cfg.pin,
            pulseMs: typeof cfg.pulseMs === "number" ? cfg.pulseMs : 80,
            activeLow: cfg.activeLow !== false,
          });
        }
        return {
          ...row,
          config_json: JSON.stringify({
            keyId: coinBtnId,
            cap: null,
            afterSwipe: false,
            feedbackNodeId: typeof cfg.feedbackPin === "number" ? cfg.nodeId : null,
            feedbackPin: typeof cfg.feedbackPin === "number" ? cfg.feedbackPin : null,
            feedbackEdge: cfg.feedbackEdge ?? "falling",
            feedbackDebounceMs: cfg.feedbackDebounceMs ?? 50,
            feedbackSignal: cfg.feedbackSignal ?? "cabinet.coin",
          }),
        };
      }
      return row;
    });

    finalRows.push(...nextList);
    if (synthesizedButtons.length > 0) {
      finalRows.push({
        device_id: deviceId,
        capability: "keys",
        config_json: JSON.stringify({ buttons: synthesizedButtons.slice(0, 16) }),
        secret_json: "{}",
        credential_hash: null,
      });
    }
  }
  return finalRows;
}

async function assemble(db: D1DatabaseLike, shopId: string, rows: ResourceRow[]): Promise<Resource[]> {
  if (!rows.length) return [];
  const capabilityRows = (
    await db
      .prepare(
        `SELECT device_id, capability, config_json, secret_json, credential_hash
         FROM device_capabilities WHERE shop_id = ? AND device_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(shopId, JSON.stringify(rows.map((row) => row.id)))
      .all<CapabilityRow>()
  ).results;
  const rowsRead = upgradeLegacyCapabilityRows(capabilityRows);
  const byDevice = new Map<string, Map<CapabilityId, BoundCapability>>();
  for (const row of rowsRead) {
    const bound = bind(row);
    if (!bound) continue;
    const map = byDevice.get(row.device_id) ?? new Map<CapabilityId, BoundCapability>();
    map.set(bound.id, bound);
    byDevice.set(row.device_id, map);
  }
  return rows.map((row) => ({
    id: row.id,
    shopId: row.shop_id,
    publicId: row.public_id,
    name: row.name,
    aliases: parseAliases(row.aliases_json),
    enabled: row.enabled === 1,
    kind: row.kind,
    capacity: row.capacity ?? 0,
    occupancyMinutes: row.occupancy_minutes ?? 15,
    capabilities: byDevice.get(row.id) ?? new Map(),
  }));
}

export async function loadResource(db: D1DatabaseLike, shopId: string, deviceId: string): Promise<Resource | null> {
  const row = await db
    .prepare(`SELECT ${deviceColumns} FROM machines WHERE shop_id = ? AND id = ?`)
    .bind(shopId, deviceId)
    .first<ResourceRow>();
  return row ? (await assemble(db, shopId, [row]))[0]! : null;
}

/**
 * Every device of a shop exactly as stored. Unlike `loadDevices` it never adopts
 * registry entries or old bindings, so it only reads: for views that are opened
 * often and must not write.
 */
export async function listResources(db: D1DatabaseLike, shopId: string): Promise<Resource[]> {
  const rows = (
    await db
      .prepare(`SELECT ${deviceColumns} FROM machines WHERE shop_id = ? ORDER BY created_at, id`)
      .bind(shopId)
      .all<ResourceRow>()
  ).results;
  return assemble(db, shopId, rows);
}

/**
 * Every device of a shop. Registry entries left by older deployments are
 * adopted as devices first, so a listing is always complete.
 */
export async function loadResources(
  db: D1DatabaseLike,
  shopId: string,
  encryptionKey: string | undefined,
): Promise<Resource[]> {
  await adoptLegacyRegistries({ db, shopId, encryptionKey });
  try {
    await adoptHaBindings(db, shopId, encryptionKey);
  } catch (error) {
    // An old binding still works as it is; a failed move (for example while a
    // backup holds the shop read-only) is retried on the next listing.
    log.error("could not move old Home Assistant bindings onto resources; trying again on the next listing", { shopId, error });
  }
  return listResources(db, shopId);
}

export function has(device: Resource, capability: CapabilityId): boolean {
  return device.capabilities.has(capability);
}

/** Whether the device has a player-facing QR / NFC link. */
export function resourceHasLink(device: Resource): boolean {
  return hasResourceLink(device.capabilities.keys());
}

/** Whether the device offers an action right now, given its bound capabilities. */
export function can(device: Resource, action: ActionName): boolean {
  for (const [id, bound] of device.capabilities) {
    const spec = capabilities[id];
    if (!(action in spec.actions)) continue;
    return (spec.available as (a: ActionName, c: unknown, s: ReadonlySet<string>, o: ReadonlyMap<CapabilityId, BoundView>) => boolean)(
      action,
      bound.config,
      bound.secretNames,
      device.capabilities,
    );
  }
  return false;
}

export function hinataConfigOf(device: Resource): HinataConfig | null {
  return (device.capabilities.get("hinata_io")?.config as HinataConfig | undefined) ?? null;
}

export function keysConfigOf(device: Resource): KeysConfig | null {
  return (device.capabilities.get("keys")?.config as KeysConfig | undefined) ?? null;
}

export function coinConfigOf(device: Resource): CoinConfig | null {
  return (device.capabilities.get("coin")?.config as CoinConfig | undefined) ?? null;
}

/** The button in `keys` that a coin triggers (keyboard or GPIO). */
export function coinKeyOf(device: Resource): ResourceButton | null {
  const coin = coinConfigOf(device);
  if (!coin?.keyId) return null;
  return keysConfigOf(device)?.buttons.find((button) => button.id === coin.keyId) ?? null;
}

export function hostConfigOf(device: Resource): HostConfig | null {
  return (device.capabilities.get("host")?.config as HostConfig | undefined) ?? null;
}

export function iotConfigOf(device: Resource): IotConfig | null {
  return (device.capabilities.get("iot")?.config as IotConfig | undefined) ?? null;
}

export function doorConfigOf(device: Resource): DoorConfig | null {
  return (device.capabilities.get("door")?.config as DoorConfig | undefined) ?? null;
}

export function tableConfigOf(device: Resource): TableConfig | null {
  return (device.capabilities.get("table")?.config as TableConfig | undefined) ?? null;
}

/** Decrypt one secret of a bound capability. Reads storage, so only call when acting. */
export async function readSecret(
  db: D1DatabaseLike,
  device: Pick<Resource, "id" | "shopId">,
  capability: CapabilityId,
  name: string,
  encryptionKey: string | undefined,
): Promise<string | null> {
  if (!encryptionKey) return null;
  const row = await db
    .prepare(`SELECT secret_json FROM device_capabilities WHERE shop_id = ? AND device_id = ? AND capability = ?`)
    .bind(device.shopId, device.id, capability)
    .first<{ secret_json: string }>();
  const value = parseObject(row?.secret_json ?? null)[name];
  if (typeof value !== "string" || !value) return null;
  try {
    return await decryptSecret(value, encryptionKey);
  } catch {
    return null;
  }
}

/** Case- and space-insensitive device lookup by id, public id, name or alias. */
export function matchesRef(device: Resource, ref: string): boolean {
  const target = ref.trim().toLowerCase();
  if (!target) return false;
  return [device.id, device.publicId, device.name, ...device.aliases].some(
    (value) => value.trim().toLowerCase() === target,
  );
}

/** The capability flags the player page and native apps have always received. */
export function publicCapabilities(device: Resource) {
  return {
    power: has(device, "power"),
    climate: has(device, "climate"),
    card: can(device, "aime.scan"),
    coin: can(device, "coin"),
    door: can(device, "door.open"),
    table: has(device, "table"),
  };
}

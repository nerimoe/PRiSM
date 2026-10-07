import {
  centsOf,
  ZERO_CENTS,
  PrismDomainError,
  type AssetDefinitionRepository,
  type AssetRepository,
  type LiveBillingSnapshot,
  type PricingHistoryRepository,
  type PricingCapHistoryRepository,
  type SessionRepository,
  type SettlementRepository,
} from "@prism/core";
import { createSettlementService } from "./settlement-service";
import { createAvailableAssetReader } from "./available-assets";
import { createAssetDefinitionEffectProvider } from "./asset-definition-effects";
import { createVersionedPricingResolvers } from "./versioned-pricing";
import {
  createStaffOperationsService,
  type LivePlayerView,
} from "./staff-operations";

/** Deserialize only engine dates; opaque asset metadata keeps its original string values. */
export function hydrateLiveBillingSnapshot(
  value: unknown,
): LiveBillingSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1
  )
    throw new Error("Unsupported live billing snapshot");
  function revive(value: unknown, key = ""): unknown {
    if (key === "metadata" || key === "config") return value;
    if (
      typeof value === "string" &&
      /(?:At|_at)$|^(start|end)$/.test(key) &&
      /^\d{4}-\d{2}-\d{2}T/.test(value)
    )
      return new Date(value);
    if (Array.isArray(value)) return value.map((item) => revive(item));
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, revive(item, key)]),
      );
    return value;
  }
  return revive(value) as LiveBillingSnapshot;
}

/** The browser uses the same preview orchestration, asset effects and version resolvers as checkout. */
export function createLiveBillingCalculator(
  snapshot: LiveBillingSnapshot,
  players: LivePlayerView[],
) {
  const readOnly = async (): Promise<never> => {
    throw new Error("Live billing snapshots cannot perform writes");
  };
  const byPlayer = new Map(
    snapshot.players.map((player) => [player.playerId, player]),
  );
  const state = (id: string) => {
    const player = byPlayer.get(id);
    if (!player)
      throw new PrismDomainError("Player not found.", "PLAYER_NOT_FOUND");
    return player;
  };
  const clock = snapshot.capturedAt;
  const now = () => clock;
  const definitions: AssetDefinitionRepository = {
    save: readOnly,
    listAll: async () => snapshot.assetDefinitions,
    findByCode: async (type, code) =>
      snapshot.assetDefinitions.find(
        (definition) => definition.type === type && definition.code === code,
      ) ?? null,
  };
  const assets: AssetRepository = {
    listAssetHoldings: async (id) => state(id).holdings,
    commitAssetTransaction: readOnly,
    listLedgerEntriesByPlayerId: readOnly,
    listTransactionsByPlayerId: readOnly,
  };
  const sessions: SessionRepository = {
    findActiveByPlayerId: async (id) =>
      state(id).sessions.filter((session) => session.status === "active"),
    findUnpaidClosedByPlayerId: async (id) =>
      state(id).sessions.filter(
        (session) =>
          session.status === "closed" && session.paymentStatus === "unpaid",
      ),
    findById: async (id) =>
      snapshot.players
        .flatMap((player) => player.sessions)
        .find((session) => session.id === id) ?? null,
    save: readOnly,
  };
  const settlements: SettlementRepository = {
    saveSettlement: readOnly,
    saveCheckout: readOnly,
    findSettlementBySessionId: readOnly,
    listPastAppliedAdjustmentsByPlayerId: async (id) =>
      state(id).pastAppliedAdjustments,
  };
  const history: PricingHistoryRepository = {
    appendEntries: readOnly,
    sumByPlayerAndKeys: async (id, keys) =>
      Object.fromEntries(
        keys.map((key) => {
          const name = `${key.pricingConfigId}@${key.providerId}@${key.ruleId}@${key.ruleAnchorAt.toISOString()}`;
          return [name, state(id).pricingPaidHistory[name] ?? ZERO_CENTS];
        }),
      ),
  };
  const capHistory: PricingCapHistoryRepository = {
    appendEntries: readOnly,
    sumByPlayerAndKeys: async (id, keys) =>
      Object.fromEntries(
        keys.map((key) => {
          const name = `${key.capConfigId}@${key.capRuleId}@${key.capAnchorAt.toISOString()}`;
          return [name, state(id).capPaidHistory[name] ?? ZERO_CENTS];
        }),
      ),
  };
  const releases = new Map(
    snapshot.pricingReleases.map((release) => [release.id, release]),
  );
  const preview = createSettlementService({
    sessions,
    assets,
    settlements,
    assetDefinitions: definitions,
    availableAssets: createAvailableAssetReader({
      assets,
      assetDefinitions: definitions,
      now,
    }),
    assetEffectProviders: [createAssetDefinitionEffectProvider(definitions)],
    pricingProviders: [],
    pricingHistory: history,
    pricingCapHistory: capHistory,
    now,
    ...createVersionedPricingResolvers({
      pricingHistory: history,
      async sessionPricing(session) {
        const release = session.pricingReleaseId
          ? releases.get(session.pricingReleaseId)
          : null;
        if (session.pricingReleaseId && !release)
          throw new PrismDomainError(
            "Pinned pricing release not found.",
            "PRICING_RELEASE_NOT_FOUND",
          );
        return {
          configs: (release?.configs ?? snapshot.currentPricingConfigs).filter(
            (config) => config.enabled && config.status !== "archived",
          ),
          timeZone: release?.timeZone ?? "UTC",
        };
      },
    }),
  });
  const operations = createStaffOperationsService({
    now,
    checkout: preview,
    listPricingConfigs: async () => snapshot.currentPricingConfigs,
    staffQueries: {
      listPlayers: async (options) =>
        players
          .filter(
            (player) =>
              !options?.playerIds ||
              options.playerIds.includes(player.playerId),
          )
          .map((player) => ({
            id: player.playerId,
            paymentMode: player.paymentMode,
            displayName: player.displayName,
            status: player.status,
            walletTotal: centsOf(player.walletTotal),
            activeSessionId:
              player.sessions.find((session) => session.status === "active")
                ?.id ?? null,
          })),
      listActiveSessions: async () => [],
      listLiveSessions: async (options) =>
        snapshot.players
          .filter(
            (player) =>
              !options?.playerIds ||
              options.playerIds.includes(player.playerId),
          )
          .flatMap((player) =>
            player.sessions.map((session) => ({
              id: session.id,
              playerId: player.playerId,
              playerDisplayName:
                players.find((row) => row.playerId === player.playerId)
                  ?.displayName ?? player.playerId,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
              status: session.status,
              label: session.label,
              elapsedMinutes: Math.max(
                0,
                Math.floor(
                  ((session.endedAt ?? clock).getTime() -
                    session.startedAt.getTime()) /
                    60_000,
                ),
              ),
            })),
          ),
    },
  });
  return {
    async calculatePlayer(playerId: string) {
      const row = (await operations.listLivePlayers({ playerId }))[0];
      if (!row) throw new Error("该玩家已不在店，请刷新列表");
      return {
        ...row,
        identities:
          players.find((player) => player.playerId === playerId)?.identities ??
          [],
      };
    },
  };
}

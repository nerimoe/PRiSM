import type {
  AssetDefinitionRepository,
  AssetGrant,
  AssetMergeStrategy,
  AssetRepository,
  Player,
  PlayerIdentity,
  PlayerIdentityRepository,
  PlayerRepository,
  PlayerStatus,
  RedeemRepository,
} from "@prism/core";
import { diffAssetHoldings, grantAssets, isActiveInWindow, PrismDomainError } from "@prism/core";
import { assertPresentGrantAssetDefinitionsActive } from "./redeem";

export type StaffCreatePlayerInput = {
  displayName: string;
  initialGrants?: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: Date | null;
    expiresAt: Date | null;
    durationMs?: number;
  }>;
};

export type StaffUpdatePlayerStatusInput = {
  playerId: string;
  status: PlayerStatus;
};

export type StaffBindPlayerIdentityInput = {
  playerId: string;
  provider: string;
  subject: string;
};

export type StaffDeletePlayerIdentityInput = {
  playerId: string;
  provider: string;
  subject: string;
};

export type ResolvePlayerIdentityInput = {
  provider: string;
  subject: string;
};

export type StaffPlayerServiceDependencies = {
  players: PlayerRepository;
  assets?: AssetRepository;
  assetDefinitions?: AssetDefinitionRepository;
  redeems?: Pick<RedeemRepository, "findPresentById">;
  playerIdentities?: PlayerIdentityRepository;
  getDefaultRegistrationPresentId?: () => Promise<string | null>;
  id: () => string;
  now: () => Date;
};

export type StaffPlayerService = {
  createPlayer(input: StaffCreatePlayerInput): Promise<Player>;
  updatePlayerStatus(input: StaffUpdatePlayerStatusInput): Promise<Player>;
  bindPlayerIdentity(input: StaffBindPlayerIdentityInput): Promise<PlayerIdentity>;
  deletePlayerIdentity(input: StaffDeletePlayerIdentityInput): Promise<void>;
  resolvePlayerIdentity(input: ResolvePlayerIdentityInput): Promise<Player | null>;
};

export function createStaffPlayerService(dependencies: StaffPlayerServiceDependencies): StaffPlayerService {
  return {
    async createPlayer(input) {
      const now = dependencies.now();
      const player: Player = {
        id: dependencies.id(),
        displayName: input.displayName,
        status: "active",
        createdAt: now,
      };
      const grantPlan = input.initialGrants === undefined
        ? await resolveDefaultRegistrationGrants(dependencies, now)
        : {
            grants: input.initialGrants.map((grant) => ({
              ...grant,
              reason: "player.register.grant",
              refId: player.id,
            })),
            transactionKind: "player.register.grant",
            transactionRefId: player.id,
            metadata: { grantCount: input.initialGrants.length },
          };

      await dependencies.players.save(player);

      if (grantPlan.grants.length > 0) {
        if (!dependencies.assets) {
          throw new PrismDomainError("Asset repository is required for register-time grants.", "REGISTER_GRANTS_NOT_CONFIGURED");
        }

        const existingHoldings = await dependencies.assets.listAssetHoldings(player.id);
        const result = grantAssets({
          playerId: player.id,
          existingHoldings,
          grants: grantPlan.grants,
          idFactory: dependencies.id,
          now,
        });

        await dependencies.assets.commitAssetTransaction({
          transaction: {
            id: `asset-tx:${grantPlan.transactionKind}:${player.id}`,
            playerId: player.id,
            kind: grantPlan.transactionKind,
            refId: grantPlan.transactionRefId,
            createdAt: player.createdAt,
            metadata: grantPlan.metadata,
          },
          holdingChanges: diffAssetHoldings(existingHoldings, result.holdings),
          assetLedgerEntries: result.assetLedgerEntries,
        });
      }

      return player;
    },

    async updatePlayerStatus(input) {
      const player = await dependencies.players.findById(input.playerId);
      if (!player) {
        throw new PrismDomainError("Player not found.", "PLAYER_NOT_FOUND");
      }

      await dependencies.players.updateStatus(input.playerId, input.status);
      return {
        ...player,
        status: input.status,
      };
    },

    async bindPlayerIdentity(input) {
      if (!dependencies.playerIdentities) {
        throw new PrismDomainError("Player identity repository is required.", "PLAYER_IDENTITY_REPOSITORY_NOT_CONFIGURED");
      }

      const player = await dependencies.players.findById(input.playerId);
      if (!player) {
        throw new PrismDomainError("Player not found.", "PLAYER_NOT_FOUND");
      }

      const identity: PlayerIdentity = {
        playerId: input.playerId,
        provider: input.provider,
        subject: input.subject,
        createdAt: dependencies.now(),
      };
      await dependencies.playerIdentities.save(identity);
      return identity;
    },

    async deletePlayerIdentity(input) {
      if (!dependencies.playerIdentities) {
        throw new PrismDomainError("Player identity repository is required.", "PLAYER_IDENTITY_REPOSITORY_NOT_CONFIGURED");
      }

      const player = await dependencies.players.findById(input.playerId);
      if (!player) {
        throw new PrismDomainError("Player not found.", "PLAYER_NOT_FOUND");
      }

      await dependencies.playerIdentities.delete(input.playerId, input.provider, input.subject);
    },

    async resolvePlayerIdentity(input) {
      if (!dependencies.playerIdentities) {
        throw new PrismDomainError("Player identity repository is required.", "PLAYER_IDENTITY_REPOSITORY_NOT_CONFIGURED");
      }

      return dependencies.playerIdentities.findPlayerByIdentity(input.provider, input.subject);
    },
  };
}

async function resolveDefaultRegistrationGrants(
  dependencies: StaffPlayerServiceDependencies,
  now: Date,
): Promise<{
  grants: AssetGrant[];
  transactionKind: string;
  transactionRefId: string;
  metadata: Record<string, unknown>;
}> {
  const presentId = (await dependencies.getDefaultRegistrationPresentId?.())?.trim();
  if (!presentId) {
    return {
      grants: [],
      transactionKind: "player.register.present",
      transactionRefId: "",
      metadata: { grantCount: 0 },
    };
  }
  if (!dependencies.redeems || !dependencies.assetDefinitions) {
    throw new PrismDomainError(
      "Registration present dependencies are not configured.",
      "REGISTER_PRESENTS_NOT_CONFIGURED",
    );
  }

  const present = await dependencies.redeems.findPresentById(presentId);
  if (!present) {
    return {
      grants: [],
      transactionKind: "player.register.present",
      transactionRefId: presentId,
      metadata: { presentId, grantCount: 0 },
    };
  }
  if (present.status === "archived" || !isActiveInWindow(present, now)) {
    return {
      grants: [],
      transactionKind: "player.register.present",
      transactionRefId: present.id,
      metadata: { presentId: present.id, presentName: present.name, grantCount: 0 },
    };
  }

  await assertPresentGrantAssetDefinitionsActive(
    { assetDefinitions: dependencies.assetDefinitions },
    present.grants,
    now,
  );
  const grants = present.grants
    .filter((grant) => isActiveInWindow(grant, now))
    .map((grant) => ({
      ...grant,
      reason: "player.register.present",
      refId: present.id,
    }));
  return {
    grants,
    transactionKind: "player.register.present",
    transactionRefId: present.id,
    metadata: { presentId: present.id, presentName: present.name, grantCount: grants.length },
  };
}

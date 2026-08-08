import type {
  AssetGrant,
  AssetMergeStrategy,
  AssetRepository,
  Player,
  PlayerIdentity,
  PlayerIdentityRepository,
  PlayerRepository,
  PlayerStatus,
} from "@prism/core";
import { diffAssetHoldings, grantAssets, PrismDomainError } from "@prism/core";

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
  playerIdentities?: PlayerIdentityRepository;
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
      const player: Player = {
        id: dependencies.id(),
        displayName: input.displayName,
        status: "active",
        createdAt: dependencies.now(),
      };

      await dependencies.players.save(player);

      if (input.initialGrants && input.initialGrants.length > 0) {
        if (!dependencies.assets) {
          throw new PrismDomainError("Asset repository is required for register-time grants.", "REGISTER_GRANTS_NOT_CONFIGURED");
        }

        const grants: AssetGrant[] = input.initialGrants.map((grant) => ({
          ...grant,
          reason: "player.register.grant",
          refId: player.id,
        }));
        const existingHoldings = await dependencies.assets.listAssetHoldings(player.id);
        const result = grantAssets({
          playerId: player.id,
          existingHoldings,
          grants,
          idFactory: dependencies.id,
          now: dependencies.now(),
        });

        await dependencies.assets.commitAssetTransaction({
          transaction: {
            id: `asset-tx:player.register.grant:${player.id}`,
            playerId: player.id,
            kind: "player.register.grant",
            refId: player.id,
            createdAt: player.createdAt,
            metadata: {
              grantCount: input.initialGrants.length,
            },
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

import type {
  ExternalIdentity,
  Player,
  PlayerIdentityRepository,
  PlayerRepository,
  PlayerSession,
  PlayerSessionRepository,
} from "@prism/core";
import {
  normalizeExternalIdentity,
  parseIdentityKey,
  PrismDomainError,
} from "@prism/core";

export type PlayerAuthIdentityInput = {
  identity?: ExternalIdentity;
  identityKey?: string;
};

export type PlayerAuthSecret = {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

export type PlayerAuthServiceDependencies = {
  players: PlayerRepository;
  playerIdentities: PlayerIdentityRepository;
  playerSessions: PlayerSessionRepository;
  id: () => string;
  now: () => Date;
  createSecret(label: "player-session"): PlayerAuthSecret | Promise<PlayerAuthSecret>;
  sessionDurationMs: number;
};

export type PlayerAuthService = {
  loginByIdentity(input: PlayerAuthIdentityInput): Promise<{
    token: string;
    player: Player;
  }>;
  authenticate(tokenHash: string): Promise<{ playerId: string } | null>;
};

export function createPlayerAuthService(dependencies: PlayerAuthServiceDependencies): PlayerAuthService {
  return {
    async loginByIdentity(input) {
      const identity = identityFromInput(input);
      const player = await dependencies.playerIdentities.findPlayerByIdentity(
        identity.provider,
        identity.subject,
      );
      if (!player) {
        throw new PrismDomainError("Player identity was not found.", "PLAYER_IDENTITY_NOT_FOUND");
      }
      if (player.status !== "active") {
        throw new PrismDomainError("Player is not active.", "PLAYER_NOT_ACTIVE");
      }

      const now = dependencies.now();
      const secret = await dependencies.createSecret("player-session");
      const session: PlayerSession = {
        id: dependencies.id(),
        playerId: player.id,
        tokenHash: secret.tokenHash,
        expiresAt: new Date(now.getTime() + dependencies.sessionDurationMs),
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      };
      await dependencies.playerSessions.save(session);
      return {
        token: secret.token,
        player,
      };
    },

    async authenticate(tokenHash) {
      const session = await dependencies.playerSessions.findByTokenHash(tokenHash);
      if (!session || session.revokedAt || session.expiresAt.getTime() <= dependencies.now().getTime()) {
        return null;
      }
      const player = await dependencies.players.findById(session.playerId);
      if (!player || player.status !== "active") {
        return null;
      }
      await dependencies.playerSessions.save({
        ...session,
        lastUsedAt: dependencies.now(),
      });
      return { playerId: player.id };
    },
  };
}

function identityFromInput(input: PlayerAuthIdentityInput): ExternalIdentity {
  if (input.identity) return normalizeExternalIdentity(input.identity);
  if (typeof input.identityKey === "string") return parseIdentityKey(input.identityKey);
  throw new PrismDomainError(
    "Player auth requires an identity or identity key.",
    "PLAYER_AUTH_IDENTITY_REQUIRED",
  );
}

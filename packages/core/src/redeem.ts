import type { AssetGrant, AssetHolding, GrantAssetsResult } from "./assets";
import { grantAssets, isActiveInWindow } from "./assets";
import { PrismDomainError } from "./errors";

export type PresentGrant = Omit<AssetGrant, "reason" | "refId">;

export type Present = {
  id: string;
  name: string;
  oncePerPlayer: boolean;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  status?: PresentStatus;
  grants: readonly PresentGrant[];
};

export type PresentStatus = "active" | "archived";

export type RedeemCode = {
  id: string;
  code: string;
  presentId: string;
  activeAt: Date | null;
  expiresAt: Date | null;
  maxUseCount: number;
  usageCount?: number;
};

export type RedeemRecord = {
  playerId: string;
  codeId: string;
  presentId: string;
  redeemedAt: Date;
};

export type RedeemGiftInput = {
  playerId: string;
  code: RedeemCode;
  present: Present;
  existingHoldings: readonly AssetHolding[];
  redeemRecords: readonly RedeemRecord[];
  now: Date;
  idFactory: () => string;
};

export type RedeemGiftResult = GrantAssetsResult & {
  redeemRecord: RedeemRecord;
};

export function redeemGift(input: RedeemGiftInput): RedeemGiftResult {
  if (input.code.activeAt && input.code.activeAt > input.now) {
    throw new PrismDomainError(
      "Redeem code is not active.",
      "REDEEM_CODE_NOT_ACTIVE",
    );
  }
  if (input.code.expiresAt && input.code.expiresAt <= input.now) {
    throw new PrismDomainError("Redeem code expired.", "REDEEM_CODE_EXPIRED");
  }
  if (input.present.activeAt && input.present.activeAt > input.now) {
    throw new PrismDomainError("Present is not active.", "PRESENT_NOT_ACTIVE");
  }
  if (input.present.expiresAt && input.present.expiresAt <= input.now) {
    throw new PrismDomainError("Present expired.", "PRESENT_EXPIRED");
  }

  const codeUseCount = input.redeemRecords.filter(
    (record) => record.codeId === input.code.id,
  ).length;
  if (codeUseCount >= input.code.maxUseCount) {
    throw new PrismDomainError(
      "Redeem code reached max use count.",
      "REDEEM_CODE_MAX_USE_REACHED",
    );
  }

  const playerRedeemedPresent = input.redeemRecords.some(
    (record) =>
      record.playerId === input.playerId &&
      record.presentId === input.present.id,
  );
  if (input.present.oncePerPlayer && playerRedeemedPresent) {
    throw new PrismDomainError(
      "Present has already been redeemed by this player.",
      "PRESENT_ONCE_PER_PLAYER_REDEEMED",
    );
  }

  const grantResult = grantAssets({
    playerId: input.playerId,
    existingHoldings: input.existingHoldings,
    grants: input.present.grants
      .filter((grant) => isActiveInWindow(grant, input.now))
      .map((grant) => ({
        ...grant,
        reason: "gift.redeem",
        refId: input.code.id,
      })),
    idFactory: input.idFactory,
    now: input.now,
  });

  return {
    ...grantResult,
    redeemRecord: {
      playerId: input.playerId,
      codeId: input.code.id,
      presentId: input.present.id,
      redeemedAt: input.now,
    },
  };
}

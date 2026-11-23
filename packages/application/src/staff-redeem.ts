import type { AssetDefinitionRepository, Present, PresentGrant, RedeemCode, RedeemRepository } from "@prism/core";
import {
  formatGeneratedRedeemCode,
  generateRedeemCodeToken,
  normalizeCustomRedeemCode,
  normalizeRedeemCodePrefix,
  PrismDomainError,
} from "@prism/core";
import { assertPresentGrantAssetDefinitionsActive } from "./redeem-service";

export type StaffCreatePresentInput = {
  name: string;
  oncePerPlayer: boolean;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  grants: readonly PresentGrant[];
};

export type StaffCreateRedeemCodeInput = {
  code: string;
  presentId: string;
  activeAt: Date | null;
  expiresAt: Date | null;
  maxUseCount: number;
};

export type StaffCreateRedeemCodeBatchInput = Omit<StaffCreateRedeemCodeInput, "code"> & {
  prefix?: string;
  count: number;
};

export type StaffRedeemServiceDependencies = {
  redeems: RedeemRepository;
  assetDefinitions?: AssetDefinitionRepository;
  id: () => string;
  now?: () => Date;
  generateCode?: () => string;
};

export type StaffRedeemService = {
  createPresent(input: StaffCreatePresentInput): Promise<Present>;
  listPresents(): Promise<Present[]>;
  archivePresent(input: { presentId: string }): Promise<Present>;
  restorePresent(input: { presentId: string }): Promise<Present>;
  createRedeemCode(input: StaffCreateRedeemCodeInput): Promise<RedeemCode>;
  createRedeemCodeBatch(input: StaffCreateRedeemCodeBatchInput): Promise<RedeemCode[]>;
  listRedeemCodes(): Promise<RedeemCode[]>;
  revokeRedeemCode(input: { codeId: string }): Promise<RedeemCode>;
};

export function createStaffRedeemService(dependencies: StaffRedeemServiceDependencies): StaffRedeemService {
  return {
    async createPresent(input) {
      for (const grant of input.grants) {
        if (
          grant.maxPerPlayer !== undefined &&
          (!Number.isInteger(grant.maxPerPlayer) || grant.maxPerPlayer < 1)
        ) {
          throw new PrismDomainError(
            "Grant maxPerPlayer must be a positive integer.",
            "INVALID_PRESENT_GRANT_LIMIT",
          );
        }
      }
      await assertPresentGrantAssetDefinitionsActive(dependencies, input.grants, dependencies.now?.() ?? new Date());
      const present: Present = {
        id: dependencies.id(),
        name: input.name,
        oncePerPlayer: input.oncePerPlayer,
        ...(input.activeAt !== undefined ? { activeAt: input.activeAt } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        status: "active",
        grants: input.grants.map((grant) => ({ ...grant })),
      };

      await dependencies.redeems.savePresent(present);
      return present;
    },

    async listPresents() {
      return dependencies.redeems.listPresents();
    },

    async archivePresent(input) {
      const present = await dependencies.redeems.findPresentById(input.presentId);
      if (!present) {
        throw new PrismDomainError("Present not found.", "PRESENT_NOT_FOUND");
      }
      const archived: Present = {
        ...present,
        status: "archived",
      };
      await dependencies.redeems.savePresent(archived);
      return archived;
    },

    async restorePresent(input) {
      const present = await dependencies.redeems.findPresentById(input.presentId);
      if (!present) {
        throw new PrismDomainError("Present not found.", "PRESENT_NOT_FOUND");
      }
      const restored: Present = {
        ...present,
        status: "active",
      };
      await dependencies.redeems.savePresent(restored);
      return restored;
    },

    async createRedeemCode(input) {
      assertValidRedeemCodeParams(input);
      const normalizedCode = normalizeCustomRedeemCode(input.code);
      await assertPresentCanReceiveNewCodes(dependencies, input.presentId);
      if (await dependencies.redeems.findRedeemCodeByCode(normalizedCode)) {
        throw new PrismDomainError("Redeem code already exists.", "REDEEM_CODE_ALREADY_EXISTS");
      }
      const code: RedeemCode = {
        id: dependencies.id(),
        code: normalizedCode,
        presentId: input.presentId,
        activeAt: input.activeAt,
        expiresAt: input.expiresAt,
        maxUseCount: input.maxUseCount,
      };

      await persistRedeemCodes(dependencies.redeems, [code]);
      return code;
    },

    async createRedeemCodeBatch(input) {
      if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) {
        throw new PrismDomainError("Redeem code batch count must be between 1 and 100.", "INVALID_REDEEM_CODE_BATCH_COUNT");
      }
      assertValidRedeemCodeParams(input);
      const cleanPrefix = normalizeRedeemCodePrefix(input.prefix);
      await assertPresentCanReceiveNewCodes(dependencies, input.presentId);
      const nextToken = dependencies.generateCode ?? generateRedeemCodeToken;
      const seen = new Set<string>();
      const codes: RedeemCode[] = [];
      for (let i = 0; i < input.count; i++) {
        let candidate = "";
        for (let attempt = 0; attempt < 16; attempt++) {
          const next = formatGeneratedRedeemCode(cleanPrefix, nextToken());
          if (seen.has(next)) continue;
          if (await dependencies.redeems.findRedeemCodeByCode(next)) continue;
          candidate = next;
          break;
        }
        if (!candidate) {
          throw new PrismDomainError("Could not generate a unique redeem code.", "REDEEM_CODE_GENERATION_FAILED");
        }
        seen.add(candidate);
        codes.push({
          id: dependencies.id(),
          code: candidate,
          presentId: input.presentId,
          activeAt: input.activeAt,
          expiresAt: input.expiresAt,
          maxUseCount: input.maxUseCount,
        });
      }
      await persistRedeemCodes(dependencies.redeems, codes);
      return codes;
    },

    async listRedeemCodes() {
      return dependencies.redeems.listRedeemCodes();
    },

    async revokeRedeemCode(input) {
      const code = await dependencies.redeems.findRedeemCodeById(input.codeId);
      if (!code) {
        throw new PrismDomainError("Redeem code not found.", "REDEEM_CODE_NOT_FOUND");
      }
      const revoked: RedeemCode = {
        ...code,
        maxUseCount: 0,
      };
      await dependencies.redeems.saveRedeemCode(revoked);
      return revoked;
    },
  };
}

async function persistRedeemCodes(redeems: RedeemRepository, codes: readonly RedeemCode[]): Promise<void> {
  try {
    if (redeems.saveRedeemCodes) {
      await redeems.saveRedeemCodes(codes);
    } else {
      for (const code of codes) {
        await redeems.saveRedeemCode(code);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new PrismDomainError("Redeem code already exists.", "REDEEM_CODE_ALREADY_EXISTS");
    }
    throw error;
  }
}

function assertValidRedeemCodeParams(input: {
  maxUseCount: number;
  activeAt: Date | null;
  expiresAt: Date | null;
}): void {
  if (!Number.isInteger(input.maxUseCount) || input.maxUseCount < 1) {
    throw new PrismDomainError(
      "Redeem code maxUseCount must be a positive integer.",
      "INVALID_REDEEM_CODE_MAX_USE_COUNT",
    );
  }
  if (input.activeAt && input.expiresAt && input.expiresAt <= input.activeAt) {
    throw new PrismDomainError(
      "Redeem code expiry must be after activation time.",
      "INVALID_REDEEM_CODE_WINDOW",
    );
  }
}

async function assertPresentCanReceiveNewCodes(
  dependencies: StaffRedeemServiceDependencies,
  presentId: string,
): Promise<void> {
  const present = await dependencies.redeems.findPresentById(presentId);
  if (!present) {
    throw new PrismDomainError("Present not found.", "PRESENT_NOT_FOUND");
  }
  if (present.status === "archived") {
    throw new PrismDomainError("Present has been archived.", "PRESENT_ARCHIVED");
  }
}

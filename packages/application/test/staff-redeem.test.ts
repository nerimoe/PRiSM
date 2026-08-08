import { describe, expect, it } from "bun:test";
import type {
  AssetDefinition,
  AssetDefinitionRepository,
  Present,
  RedeemCode,
  RedeemRecord,
  RedeemRepository,
} from "@prism/core";
import { createStaffRedeemService } from "../src/index";

class MemoryRedeemRepository implements RedeemRepository {
  savedPresents: Present[] = [];
  savedCodes: RedeemCode[] = [];

  async findRedeemCodeByCode(code: string): Promise<RedeemCode | null> {
    return (
      this.savedCodes.find((redeemCode) => redeemCode.code === code) ?? null
    );
  }

  async findRedeemCodeById(codeId: string): Promise<RedeemCode | null> {
    return (
      this.savedCodes.find((redeemCode) => redeemCode.id === codeId) ?? null
    );
  }

  async findPresentById(presentId: string): Promise<Present | null> {
    return (
      this.savedPresents.find((present) => present.id === presentId) ?? null
    );
  }

  async savePresent(present: Present): Promise<void> {
    const index = this.savedPresents.findIndex(
      (saved) => saved.id === present.id,
    );
    if (index === -1) {
      this.savedPresents.push(present);
      return;
    }
    this.savedPresents[index] = present;
  }

  async listPresents(): Promise<Present[]> {
    return this.savedPresents;
  }

  async saveRedeemCode(code: RedeemCode): Promise<void> {
    const index = this.savedCodes.findIndex((saved) => saved.id === code.id);
    if (index === -1) {
      this.savedCodes.push(code);
      return;
    }
    this.savedCodes[index] = code;
  }

  async listRedeemCodes(): Promise<RedeemCode[]> {
    return this.savedCodes;
  }

  async listRedeemRecords(): Promise<RedeemRecord[]> {
    return [];
  }

  async countRedeemCodeUses(): Promise<number> {
    return 0;
  }

  async hasPlayerRedeemedPresent(): Promise<boolean> {
    return false;
  }

  async saveRedeemRecord(): Promise<void> {}
}

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  constructor(private readonly definitions: AssetDefinition[]) {}

  async save(definition: AssetDefinition): Promise<void> {
    const index = this.definitions.findIndex(
      (existing) =>
        existing.type === definition.type && existing.code === definition.code,
    );
    if (index === -1) {
      this.definitions.push(definition);
      return;
    }
    this.definitions[index] = definition;
  }

  async findByCode(
    type: string,
    code: string,
  ): Promise<AssetDefinition | null> {
    return (
      this.definitions.find(
        (definition) => definition.type === type && definition.code === code,
      ) ?? null
    );
  }

  async listAll(): Promise<AssetDefinition[]> {
    return [...this.definitions];
  }
}

describe("createStaffRedeemService", () => {
  it("creates a present and a redeem code for CDK recharge workflows", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => (redeems.savedPresents.length === 0 ? "present-1" : "code-1"),
    });

    const present = await service.createPresent({
      name: "Top up",
      oncePerPlayer: true,
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 100,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    });
    const code = await service.createRedeemCode({
      code: "PRISM-2026",
      presentId: present.id,
      activeAt: new Date("2026-06-07T00:00:00.000Z"),
      expiresAt: new Date("2026-07-07T00:00:00.000Z"),
      maxUseCount: 1,
    });

    expect(present).toEqual({
      id: "present-1",
      name: "Top up",
      oncePerPlayer: true,
      status: "active",
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 100,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    });
    expect(code).toEqual({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: new Date("2026-06-07T00:00:00.000Z"),
      expiresAt: new Date("2026-07-07T00:00:00.000Z"),
      maxUseCount: 1,
    });
    expect(redeems.savedPresents).toEqual([present]);
    expect(redeems.savedCodes).toEqual([code]);
    await expect(service.listPresents()).resolves.toEqual([present]);
  });

  it("saves present effective windows for gift campaigns", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => "present-1",
      now: () => new Date("2026-07-05T10:00:00.000Z"),
    });

    await expect(
      service.createPresent({
        name: "暑期礼物",
        oncePerPlayer: true,
        activeAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        grants: [],
      }),
    ).resolves.toEqual({
      id: "present-1",
      name: "暑期礼物",
      oncePerPlayer: true,
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      status: "active",
      grants: [],
    });
  });

  it("ignores expired present contents when validating grant asset definitions", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      assetDefinitions: new MemoryAssetDefinitionRepository([
        {
          type: "coupon",
          code: "old",
          name: "旧券",
          stackable: true,
          status: "archived",
          metadata: null,
        },
      ]),
      id: () => "present-1",
      now: () => new Date("2026-07-05T10:00:00.000Z"),
    });

    await expect(
      service.createPresent({
        name: "补偿礼物",
        oncePerPlayer: false,
        grants: [
          {
            assetType: "coupon",
            assetCode: "old",
            amount: 1,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      id: "present-1",
      grants: [
        {
          assetType: "coupon",
          assetCode: "old",
        },
      ],
    });
  });

  it("archives presents without deleting gifts referenced by redeem codes", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => "unused",
    });
    await redeems.savePresent({
      id: "present-1",
      name: "准考证活动",
      oncePerPlayer: true,
      status: "active",
      grants: [],
    });
    await redeems.saveRedeemCode({
      id: "code-1",
      code: "GAOKAO",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
    });

    await expect(
      service.archivePresent({ presentId: "present-1" }),
    ).resolves.toEqual({
      id: "present-1",
      name: "准考证活动",
      oncePerPlayer: true,
      status: "archived",
      grants: [],
    });
    await expect(redeems.findRedeemCodeById("code-1")).resolves.toMatchObject({
      presentId: "present-1",
    });
  });

  it("restores archived presents so they can receive new codes again", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => "unused",
    });
    await redeems.savePresent({
      id: "present-1",
      name: "暑假活动",
      oncePerPlayer: true,
      status: "archived",
      grants: [],
    });

    await expect(
      service.restorePresent({ presentId: "present-1" }),
    ).resolves.toEqual({
      id: "present-1",
      name: "暑假活动",
      oncePerPlayer: true,
      status: "active",
      grants: [],
    });
    await expect(
      service.createRedeemCode({
        code: "SUMMER",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      }),
    ).resolves.toMatchObject({
      code: "SUMMER",
      presentId: "present-1",
    });
  });

  it("does not create new redeem codes for archived presents", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => "code-1",
    });
    await redeems.savePresent({
      id: "present-1",
      name: "旧活动",
      oncePerPlayer: true,
      status: "archived",
      grants: [],
    });

    await expect(
      service.createRedeemCode({
        code: "OLD-ACTIVITY",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      }),
    ).rejects.toMatchObject({
      code: "PRESENT_ARCHIVED",
    });
    expect(redeems.savedCodes).toEqual([]);
  });

  it("does not create new presents that grant archived asset definitions", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      assetDefinitions: new MemoryAssetDefinitionRepository([
        {
          type: "coupon",
          code: "old-event",
          name: "旧活动券",
          stackable: true,
          status: "archived",
          metadata: null,
        },
      ]),
      id: () => "present-1",
    });

    await expect(
      service.createPresent({
        name: "旧活动补发",
        oncePerPlayer: true,
        grants: [
          {
            assetType: "coupon",
            assetCode: "old-event",
            amount: 1,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "ASSET_DEFINITION_ARCHIVED",
    });
    expect(redeems.savedPresents).toEqual([]);
  });

  it("lists and revokes redeem codes for staff management", async () => {
    const redeems = new MemoryRedeemRepository();
    const service = createStaffRedeemService({
      redeems,
      id: () => "unused",
    });
    await redeems.saveRedeemCode({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
    });

    await expect(service.listRedeemCodes()).resolves.toEqual([
      {
        id: "code-1",
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
    ]);

    const revoked = await service.revokeRedeemCode({
      codeId: "code-1",
    });

    expect(revoked).toEqual({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 0,
    });
    await expect(service.listRedeemCodes()).resolves.toEqual([revoked]);
  });

  it("creates redeem codes in batches for CDK workflows", async () => {
    const redeems = new MemoryRedeemRepository();
    const ids = ["code-1", "code-2"];
    const service = createStaffRedeemService({
      redeems,
      id: () => ids.shift() ?? "unexpected",
    });
    await redeems.savePresent({
      id: "present-1",
      name: "活动礼物",
      oncePerPlayer: true,
      status: "active",
      grants: [],
    });

    const codes = await service.createRedeemCodeBatch({
      prefix: "PRISM",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
      count: 2,
    });

    expect(codes).toEqual([
      {
        id: "code-1",
        code: "PRISM-code-1",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      {
        id: "code-2",
        code: "PRISM-code-2",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
    ]);
    expect(redeems.savedCodes).toEqual(codes);
  });
});

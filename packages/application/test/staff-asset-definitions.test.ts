import { describe, expect, it } from "bun:test";
import type { AssetDefinition, AssetDefinitionRepository, PricingEffect, PricingEffectRepository } from "@prism/core";
import { createStaffAssetDefinitionService } from "../src/index";

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  saved: AssetDefinition[] = [];

  async save(definition: AssetDefinition): Promise<void> {
    this.saved = [definition, ...this.saved.filter((existing) => existing.type !== definition.type || existing.code !== definition.code)];
  }

  async findByCode(type: string, code: string): Promise<AssetDefinition | null> {
    return this.saved.find((definition) => definition.type === type && definition.code === code) ?? null;
  }

  async listAll(): Promise<AssetDefinition[]> {
    return [...this.saved].sort((a, b) => `${a.type}:${a.code}`.localeCompare(`${b.type}:${b.code}`));
  }
}

class MemoryPricingEffectRepository implements PricingEffectRepository {
  constructor(private readonly effects: PricingEffect[]) {}

  async save(effect: PricingEffect): Promise<void> {
    const index = this.effects.findIndex((existing) => existing.id === effect.id);
    if (index === -1) {
      this.effects.push(effect);
      return;
    }
    this.effects[index] = effect;
  }

  async findById(effectId: string): Promise<PricingEffect | null> {
    return this.effects.find((effect) => effect.id === effectId) ?? null;
  }

  async listAll(): Promise<PricingEffect[]> {
    return [...this.effects];
  }
}

describe("createStaffAssetDefinitionService", () => {
  it("saves and lists staff-managed asset definitions", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
    });

    const definition = await service.saveAssetDefinition({
      type: "pass",
      code: "pass.monthly",
      name: "Monthly pass",
      stackable: false,
      metadata: {
        settlementEffect: "time.free",
      },
    });

    expect(definition).toEqual({
      type: "pass",
      code: "pass.monthly",
      name: "Monthly pass",
      stackable: false,
      status: "active",
      metadata: {
        settlementEffect: "time.free",
      },
    });
    expect(assetDefinitions.saved).toEqual([definition]);
    await expect(service.listAssetDefinitions()).resolves.toEqual([definition]);
  });

  it("saves effective windows and a reusable pricing effect binding on asset definitions", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
      pricingEffects: new MemoryPricingEffectRepository([
        {
          id: "effect-monthly-pass",
          name: "月卡免时费",
          type: "free",
          scope: "session",
          value: null,
          consumable: false,
          limitPerDay: null,
          activeAt: null,
          expiresAt: null,
          status: "active",
          config: null,
        },
      ]),
    });

    const definition = await service.saveAssetDefinition({
      type: "pass",
      code: "monthly",
      name: "月卡",
      stackable: false,
      pricingEffectId: "effect-monthly-pass",
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: null,
    });

    expect(definition).toEqual({
      type: "pass",
      code: "monthly",
      name: "月卡",
      stackable: false,
      status: "active",
      pricingEffectId: "effect-monthly-pass",
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: null,
    });
  });

  it("rejects asset definitions bound to archived pricing effects", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
      pricingEffects: new MemoryPricingEffectRepository([
        {
          id: "effect-old",
          name: "旧活动",
          type: "discount",
          scope: "unified",
          value: 100,
          consumable: true,
          limitPerDay: null,
          activeAt: null,
          expiresAt: null,
          status: "archived",
          config: null,
        },
      ]),
    });

    await expect(
      service.saveAssetDefinition({
        type: "coupon",
        code: "old",
        name: "旧活动券",
        stackable: true,
        pricingEffectId: "effect-old",
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "PRICING_EFFECT_ARCHIVED",
    });
  });

  it("archives asset definitions without deleting referenced definitions", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
    });
    await service.saveAssetDefinition({
      type: "title",
      code: "event.badge",
      name: "Event badge",
      stackable: false,
      metadata: null,
    });

    await expect(
      service.archiveAssetDefinition({
        type: "title",
        code: "event.badge",
      }),
    ).resolves.toEqual({
      type: "title",
      code: "event.badge",
      name: "Event badge",
      stackable: false,
      status: "archived",
      metadata: null,
    });
    await expect(service.listAssetDefinitions()).resolves.toEqual([
      {
        type: "title",
        code: "event.badge",
        name: "Event badge",
        stackable: false,
        status: "archived",
        metadata: null,
      },
    ]);
  });

  it("restores archived asset definitions without recreating them", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
    });
    await assetDefinitions.save({
      type: "coupon",
      code: "summer",
      name: "Summer coupon",
      stackable: true,
      status: "archived",
      metadata: null,
    });

    await expect(
      service.restoreAssetDefinition({
        type: "coupon",
        code: "summer",
      }),
    ).resolves.toEqual({
      type: "coupon",
      code: "summer",
      name: "Summer coupon",
      stackable: true,
      status: "active",
      metadata: null,
    });
    await expect(service.listAssetDefinitions()).resolves.toEqual([
      {
        type: "coupon",
        code: "summer",
        name: "Summer coupon",
        stackable: true,
        status: "active",
        metadata: null,
      },
    ]);
  });

  it("rejects saving over archived asset definitions until staff restores them", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
    });
    const archived: AssetDefinition = {
      type: "coupon",
      code: "summer",
      name: "Summer coupon",
      stackable: true,
      status: "archived",
      metadata: null,
    };
    await assetDefinitions.save(archived);

    await expect(
      service.saveAssetDefinition({
        type: "coupon",
        code: "summer",
        name: "Summer coupon renewed",
        stackable: true,
        status: "active",
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "ASSET_DEFINITION_ARCHIVED",
    });
    expect(assetDefinitions.saved).toEqual([archived]);
  });

  it("does not archive system asset definitions used as settlement anchors", async () => {
    const assetDefinitions = new MemoryAssetDefinitionRepository();
    const service = createStaffAssetDefinitionService({
      assetDefinitions,
    });
    await service.saveAssetDefinition({
      type: "currency",
      code: "paid",
      name: "余额",
      stackable: true,
      status: "active",
      metadata: {
        system: true,
        displayUnit: "JPY",
      },
    });

    await expect(
      service.archiveAssetDefinition({
        type: "currency",
        code: "paid",
      }),
    ).rejects.toMatchObject({
      code: "SYSTEM_ASSET_DEFINITION_CANNOT_BE_ARCHIVED",
    });
    await expect(service.listAssetDefinitions()).resolves.toEqual([
      {
        type: "currency",
        code: "paid",
        name: "余额",
        stackable: true,
        status: "active",
        metadata: {
          system: true,
          displayUnit: "JPY",
        },
      },
    ]);
  });
});

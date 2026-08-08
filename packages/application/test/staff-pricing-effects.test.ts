import { describe, expect, it } from "bun:test";
import type { PricingEffect, PricingEffectRepository } from "@prism/core";
import { createStaffPricingEffectService } from "../src/index";

class MemoryPricingEffectRepository implements PricingEffectRepository {
  saved: PricingEffect[] = [];

  async save(effect: PricingEffect): Promise<void> {
    this.saved = [effect, ...this.saved.filter((existing) => existing.id !== effect.id)];
  }

  async findById(effectId: string): Promise<PricingEffect | null> {
    return this.saved.find((effect) => effect.id === effectId) ?? null;
  }

  async listAll(): Promise<PricingEffect[]> {
    return [...this.saved].sort((a, b) => a.id.localeCompare(b.id));
  }
}

describe("createStaffPricingEffectService", () => {
  it("saves reusable pricing effects that assets can bind by id", async () => {
    const pricingEffects = new MemoryPricingEffectRepository();
    const service = createStaffPricingEffectService({
      pricingEffects,
      id: () => "effect-1",
    });

    const effect = await service.savePricingEffect({
      name: "月卡免时费",
      type: "free",
      scope: "session",
      value: null,
      consumable: false,
      limitPerDay: null,
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      config: {
        applicableSessionLabels: ["music"],
      },
    });

    expect(effect).toEqual({
      id: "effect-1",
      name: "月卡免时费",
      type: "free",
      scope: "session",
      value: null,
      consumable: false,
      limitPerDay: null,
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      status: "active",
      config: {
        applicableSessionLabels: ["music"],
      },
    });
    await expect(service.listPricingEffects()).resolves.toEqual([effect]);
  });

  it("archives and restores pricing effects without deleting asset bindings", async () => {
    const pricingEffects = new MemoryPricingEffectRepository();
    const service = createStaffPricingEffectService({
      pricingEffects,
      id: () => "unused",
    });
    await pricingEffects.save({
      id: "effect-1",
      name: "活动抵扣",
      type: "discount",
      scope: "unified",
      value: 500,
      consumable: true,
      limitPerDay: 1,
      activeAt: null,
      expiresAt: null,
      status: "active",
      config: null,
    });

    await expect(service.archivePricingEffect({ effectId: "effect-1" })).resolves.toMatchObject({
      id: "effect-1",
      status: "archived",
    });
    await expect(service.restorePricingEffect({ effectId: "effect-1" })).resolves.toMatchObject({
      id: "effect-1",
      status: "active",
    });
  });
});

import { PrismDomainError } from "@prism/core";
import type { AssetDefinition, AssetDefinitionRepository, PricingEffectRepository } from "@prism/core";

export type StaffSaveAssetDefinitionInput = AssetDefinition;

export type StaffAssetDefinitionServiceDependencies = {
  assetDefinitions: AssetDefinitionRepository;
  pricingEffects?: PricingEffectRepository;
};

export type StaffAssetDefinitionService = {
  saveAssetDefinition(input: StaffSaveAssetDefinitionInput): Promise<AssetDefinition>;
  archiveAssetDefinition(input: { type: string; code: string }): Promise<AssetDefinition>;
  restoreAssetDefinition(input: { type: string; code: string }): Promise<AssetDefinition>;
  listAssetDefinitions(): Promise<AssetDefinition[]>;
};

export function createStaffAssetDefinitionService(
  dependencies: StaffAssetDefinitionServiceDependencies,
): StaffAssetDefinitionService {
  return {
    async saveAssetDefinition(input) {
      const existing = await dependencies.assetDefinitions.findByCode(input.type, input.code);
      if ((existing?.status ?? "active") === "archived") {
        throw new PrismDomainError("Asset definition has been archived.", "ASSET_DEFINITION_ARCHIVED");
      }
      if (input.pricingEffectId && dependencies.pricingEffects) {
        const effect = await dependencies.pricingEffects.findById(input.pricingEffectId);
        if (!effect) {
          throw new PrismDomainError("Pricing effect not found.", "PRICING_EFFECT_NOT_FOUND");
        }
        if (effect.status === "archived") {
          throw new PrismDomainError("Pricing effect has been archived.", "PRICING_EFFECT_ARCHIVED");
        }
      }
      const definition: AssetDefinition = {
        type: input.type,
        code: input.code,
        name: input.name,
        stackable: input.stackable,
        status: input.status ?? "active",
        ...(input.pricingEffectId !== undefined ? { pricingEffectId: input.pricingEffectId } : {}),
        ...(input.pricingEffect !== undefined ? { pricingEffect: input.pricingEffect } : {}),
        ...(input.activeAt !== undefined ? { activeAt: input.activeAt } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        metadata: input.metadata,
      };

      await dependencies.assetDefinitions.save(definition);
      return definition;
    },

    async archiveAssetDefinition(input) {
      const existing = await dependencies.assetDefinitions.findByCode(input.type, input.code);
      if (!existing) {
        throw new PrismDomainError("Asset definition not found.", "ASSET_DEFINITION_NOT_FOUND");
      }
      if (existing.metadata?.system === true) {
        throw new PrismDomainError(
          "System asset definitions cannot be archived.",
          "SYSTEM_ASSET_DEFINITION_CANNOT_BE_ARCHIVED",
        );
      }
      const archived: AssetDefinition = {
        ...existing,
        status: "archived",
      };
      await dependencies.assetDefinitions.save(archived);
      return archived;
    },

    async restoreAssetDefinition(input) {
      const existing = await dependencies.assetDefinitions.findByCode(input.type, input.code);
      if (!existing) {
        throw new PrismDomainError("Asset definition not found.", "ASSET_DEFINITION_NOT_FOUND");
      }
      const restored: AssetDefinition = {
        ...existing,
        status: "active",
      };
      await dependencies.assetDefinitions.save(restored);
      return restored;
    },

    async listAssetDefinitions() {
      return dependencies.assetDefinitions.listAll();
    },
  };
}

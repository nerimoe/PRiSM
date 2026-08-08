import {
  isActiveInWindow,
  type AssetDefinition,
  type AssetDefinitionRepository,
  type AssetEffectProvider,
  type ChargeItem,
  type PricingEffectScope,
  type PricingEffectType,
  type SettlementAdjustment,
} from "@prism/core";

export type AssetSettlementEffectConfig = {
  type: PricingEffectType;
  scope?: PricingEffectScope;
  value?: number | null;
  consumable?: boolean;
  limitPerDay?: number | null;
  startDate?: string;
  endDate?: string;
  daysOfWeek?: number[];
  applicableSessionLabels?: string[];
  applicablePricingConfigIds?: string[];
  applicableRuleIds?: string[];
};

export function createAssetDefinitionEffectProvider(
  assetDefinitions: AssetDefinitionRepository,
): AssetEffectProvider {
  return {
    id: "asset-definition.metadata-effects",
    async apply(context) {
      if (context.subtotal <= 0) return [];

      const adjustments: SettlementAdjustment[] = [];
      let remainingSubtotal = context.subtotal;
      const timeZone = context.timeZone ?? "Asia/Shanghai";
      const definitions = new Map(
        (await assetDefinitions.listAll()).map((definition) => [
          assetDefinitionKey(definition.type, definition.code),
          definition,
        ]),
      );

      for (const holding of context.assetHoldings) {
        if (remainingSubtotal <= 0) break;
        const definition = definitions.get(assetDefinitionKey(holding.assetType, holding.assetCode));
        if (!definition || definition.status === "archived" || !isActiveInWindow(definition, context.session.startedAt)) {
          continue;
        }

        const config = resolveAssetDefinitionEffectConfig(definition, context.session.startedAt);
        if (!config || config.scope === "unified") continue;
        if (!isAssetEffectConfigAvailable(config, context.session.startedAt, timeZone)) continue;
        if (
          config.applicableSessionLabels?.length
          && (!context.session.label || !config.applicableSessionLabels.includes(context.session.label))
        ) {
          continue;
        }

        let eligibleSubtotal = remainingSubtotal;
        if (config.applicablePricingConfigIds?.length || config.applicableRuleIds?.length) {
          const eligibleCharges = context.chargeItems.filter((item) =>
            isChargeItemEligibleForAssetEffect(item, config)
          );
          eligibleSubtotal = Math.min(
            remainingSubtotal,
            eligibleCharges.reduce((sum, item) => sum + item.amount, 0),
          );
        }
        if (eligibleSubtotal <= 0) continue;

        if (config.limitPerDay) {
          const today = calendarDayAt(context.session.startedAt, timeZone);
          const source = assetDefinitionEffectSource(holding.assetType, holding.assetCode);
          const usesToday = (context.pastAppliedAdjustments ?? [])
            .filter((adjustment) => adjustment.source === source)
            .filter((adjustment) => calendarDayAt(adjustment.sessionStartedAt, timeZone) === today)
            .length;
          if (usesToday >= config.limitPerDay) continue;
        }

        const discountAmount = calculateAssetEffectDiscount(eligibleSubtotal, config);
        if (discountAmount <= 0) continue;
        adjustments.push({
          id: `${context.session.id}:asset-definition:${holding.assetType}:${holding.assetCode}:${config.type}`,
          source: assetDefinitionEffectSource(holding.assetType, holding.assetCode),
          label: definition.name,
          amount: -discountAmount,
        });
        remainingSubtotal -= discountAmount;
      }

      return adjustments;
    },
  };
}

export function resolveAssetDefinitionEffectConfig(
  definition: AssetDefinition,
  at: Date,
): AssetSettlementEffectConfig | null {
  const pricingEffect = definition.pricingEffect;
  if (pricingEffect) {
    if (pricingEffect.status === "archived" || !isActiveInWindow(pricingEffect, at)) return null;
    return {
      ...((pricingEffect.config ?? {}) as Omit<AssetSettlementEffectConfig, "type">),
      type: pricingEffect.type,
      scope: pricingEffect.scope,
      value: pricingEffect.value,
      consumable: pricingEffect.consumable,
      limitPerDay: pricingEffect.limitPerDay,
    };
  }

  return null;
}

export function isAssetEffectConfigAvailable(
  config: AssetSettlementEffectConfig,
  at: Date,
  timeZone: string,
): boolean {
  const today = calendarDayAt(at, timeZone);
  if (config.startDate && today < config.startDate) return false;
  if (config.endDate && today > config.endDate) return false;
  if (config.daysOfWeek?.length) {
    const currentDay = weekdayAt(at, timeZone);
    if (currentDay === null || !config.daysOfWeek.includes(currentDay)) return false;
  }
  return true;
}

export function calculateAssetEffectDiscount(
  subtotal: number,
  config: AssetSettlementEffectConfig,
): number {
  if (config.type === "free") return subtotal;
  if (config.type === "discount") return Math.min(subtotal, config.value ?? 0);
  if (config.type === "percentage-discount") {
    return Math.round(subtotal * ((config.value ?? 0) / 100));
  }
  return 0;
}

export function isChargeItemEligibleForAssetEffect(
  item: ChargeItem,
  config: AssetSettlementEffectConfig,
): boolean {
  const history = item.pricingHistory;
  if (!history) return false;
  if (
    config.applicablePricingConfigIds?.length
    && !config.applicablePricingConfigIds.includes(history.pricingConfigId)
  ) {
    return false;
  }
  if (config.applicableRuleIds?.length && !config.applicableRuleIds.includes(history.ruleId)) {
    return false;
  }
  return true;
}

export function calendarDayAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  const day = parts.find((part) => part.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

export function assetDefinitionEffectSource(assetType: string, assetCode: string): string {
  return assetCode.startsWith(`${assetType}.`) ? assetCode : `${assetType}.${assetCode}`;
}

function weekdayAt(date: Date, timeZone: string): number | null {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[weekday] ?? null;
}

function assetDefinitionKey(assetType: string, assetCode: string): string {
  return `${assetType}\u0000${assetCode}`;
}

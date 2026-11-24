import { buildPricingRelationGraph, relationsOf, buildPriorityTimePricingTimeline, buildTimeCapPricingTimeline, convertPricingRuleClock, PrismDomainError, quantizePricingProvider, validatePricingConfig } from "@prism/core";
import type {
  PricingConfig,
  PricingConfigKind,
  PricingConfigRelations,
  PricingConfigRepository,
  PriorityTimePricingTimeline,
} from "@prism/core";

export type StaffCreatePricingConfigInput = {
  kind: PricingConfigKind;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
  /** Only `time.priority` plans may declare relations. */
  relations?: PricingConfigRelations;
};

export type StaffUpdatePricingConfigInput = {
  pricingConfigId: string;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
  /** Omitted keeps the plan's current relations. */
  relations?: PricingConfigRelations;
};

export type StaffPricingServiceDependencies = {
  pricingConfigs: PricingConfigRepository;
  /** What else bills through a plan (resource groups, resources, the shop default), by display name. */
  planUsers?(planId: string): Promise<string[]>;
  getDefaultTimeZone?: () => Promise<string | undefined>;
  id: () => string;
  now: () => Date;
};

export type StaffPricingService = {
  createPricingConfig(input: StaffCreatePricingConfigInput): Promise<PricingConfig>;
  updatePricingConfig(input: StaffUpdatePricingConfigInput): Promise<PricingConfig>;
  archivePricingConfig(input: { pricingConfigId: string }): Promise<PricingConfig>;
  restorePricingConfig(input: { pricingConfigId: string }): Promise<PricingConfig>;
  listPricingConfigs(): Promise<PricingConfig[]>;
  getPricingTimeline(input: { pricingConfigId: string; localDate: string }): Promise<PriorityTimePricingTimeline>;
  previewPricingTimeline(input: {
    provider:
      | Extract<PricingConfig, { kind: "time.priority" }>["provider"]
      | Extract<PricingConfig, { kind: "time.cap" }>["provider"];
    localDate: string;
    displayTimeZone?: string;
  }): Promise<PriorityTimePricingTimeline>;
};

export function createStaffPricingService(dependencies: StaffPricingServiceDependencies): StaffPricingService {
  return {
    async createPricingConfig(input) {
      const now = dependencies.now();
      const base = {
        id: dependencies.id(),
        name: input.name,
        enabled: input.enabled,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      // Spending history is keyed by the provider ID, so a provider never goes without one.
      const provider = { ...input.provider, id: input.provider.id || base.id } as typeof input.provider;
      assertNoNewDateTimeRange(provider, null);
      const config = withRelations(await createPricingConfigForKind(input.kind, provider, base, dependencies), input.relations);

      validatePricingConfig(config);
      await assertRelationGraphHolds(config, dependencies);
      await dependencies.pricingConfigs.save(config);
      return await dependencies.pricingConfigs.findById(config.id) ?? config;
    },

    async updatePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      const status = existing.status ?? "active";
      assertNoNewDateTimeRange(input.provider, existing);

      const config = withRelations(
        await createPricingConfigForKind(
          existing.kind,
          input.provider,
          {
            id: existing.id,
            name: input.name,
            enabled: status === "archived" ? false : input.enabled,
            status,
            createdAt: existing.createdAt,
            updatedAt: dependencies.now(),
          },
          dependencies,
        ),
        input.relations ?? (existing.kind === "time.priority" ? existing.relations : undefined),
      );

      validatePricingConfig(config);
      await assertRelationGraphHolds(config, dependencies);
      await dependencies.pricingConfigs.save(config);
      return await dependencies.pricingConfigs.findById(config.id) ?? config;
    },

    async archivePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      // A plan something still bills through cannot go away: the resource or
      // the plan requiring it would fail for every player who scans.
      const requiredBy = (await dependencies.pricingConfigs.listAll())
        .filter((config) => config.id !== existing.id && (config.status ?? "active") !== "archived")
        .filter((config) => relationsOf(config).requires.includes(existing.id))
        .map((config) => `规则「${config.name}」`);
      const users = [...requiredBy, ...((await dependencies.planUsers?.(existing.id)) ?? [])];
      if (users.length) {
        throw new PrismDomainError(`${users.join("、")}仍在使用这条规则，请先改掉再归档。`, "PRICING_CONFIG_IN_USE");
      }
      const archived: PricingConfig = {
        ...existing,
        enabled: false,
        status: "archived",
        updatedAt: dependencies.now(),
      };
      await dependencies.pricingConfigs.save(archived);
      return await dependencies.pricingConfigs.findById(archived.id) ?? archived;
    },

    async restorePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      const restored: PricingConfig = {
        ...existing,
        enabled: false,
        status: "active",
        updatedAt: dependencies.now(),
      };
      await dependencies.pricingConfigs.save(restored);
      return await dependencies.pricingConfigs.findById(restored.id) ?? restored;
    },

    async listPricingConfigs() {
      return dependencies.pricingConfigs.listAll();
    },

    async getPricingTimeline(input) {
      const config = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!config) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      if (config.kind !== "time.priority") {
        throw new PrismDomainError("Pricing config does not have a time timeline.", "PRICING_CONFIG_TIMELINE_NOT_SUPPORTED");
      }
      return buildPriorityTimePricingTimeline({
        localDate: input.localDate,
        config: config.provider,
        displayTimeZone: await dependencies.getDefaultTimeZone?.(),
      });
    },

    async previewPricingTimeline(input) {
      if ("includedPricingConfigIds" in input.provider) {
        return buildTimeCapPricingTimeline({
          localDate: input.localDate,
          config: quantizePricingProvider(await withUtcCapClock(input.provider, dependencies, input.localDate)),
          displayTimeZone: input.displayTimeZone ?? await dependencies.getDefaultTimeZone?.() ?? input.provider.timeZone,
        });
      }
      return buildPriorityTimePricingTimeline({
        localDate: input.localDate,
        config: quantizePricingProvider(await withUtcPricingClock(input.provider, dependencies, input.localDate)),
        displayTimeZone: input.displayTimeZone ?? await dependencies.getDefaultTimeZone?.() ?? input.provider.timeZone,
      });
    },
  };
}

export type PricingConfigDraft = {
  id: string;
  kind: PricingConfigKind;
  name: string;
  enabled: boolean;
  status?: "active" | "archived";
  provider: PricingConfig["provider"];
  relations?: PricingConfigRelations;
};

/**
 * A plan as the editor sends it (clocks in the shop's zone, prices in yuan),
 * stored the way a save stores it: UTC clocks, whole cents, relations checked
 * against the kind. Used for plans held in a scheduled change, which are saved
 * later in one go. An archived plan is never enabled.
 */
export async function normalizePricingConfigDraft(
  draft: PricingConfigDraft,
  dependencies: Pick<StaffPricingServiceDependencies, "now"> & {
    existing?: PricingConfig | null;
    /** Read-only simulation may normalize historical schedules that still hold retired dateTimeRange periods. */
    allowLegacyDateTimeRange?: boolean;
  },
): Promise<PricingConfig> {
  const status = draft.status ?? "active";
  const now = dependencies.now();
  const provider = { ...draft.provider, id: draft.provider.id || draft.id } as PricingConfig["provider"];
  if (!dependencies.allowLegacyDateTimeRange) assertNoNewDateTimeRange(provider, dependencies.existing ?? null);
  const config = withRelations(
    await createPricingConfigForKind(
      draft.kind,
      provider,
      {
        id: draft.id,
        name: draft.name,
        enabled: status === "archived" ? false : draft.enabled,
        status,
        createdAt: dependencies.existing?.createdAt ?? now,
        updatedAt: now,
      },
      { ...dependencies, pricingConfigs: undefined as never, id: () => draft.id },
    ),
    draft.relations,
  );
  return config;
}

/**
 * A period with an absolute start and end (`dateTimeRange`) only comes from
 * prism-neo imports; when a price list changes from a date on, that is a
 * scheduled change. A save may keep such a period exactly as stored, but not
 * add one or move its dates.
 */
export function assertNoNewDateTimeRange(provider: PricingConfig["provider"], existing: PricingConfig | null): void {
  if (!("rules" in provider)) return;
  const stored = new Map<string, string>();
  if (existing && "rules" in existing.provider) {
    for (const rule of existing.provider.rules) {
      if (rule.dateTimeRange) stored.set(rule.id, dateTimeRangeKey(rule.dateTimeRange));
    }
  }
  for (const rule of provider.rules as ReadonlyArray<{ id: string; dateTimeRange?: { start: Date | string; end: Date | string } }>) {
    if (!rule.dateTimeRange) continue;
    if (stored.get(rule.id) !== dateTimeRangeKey(rule.dateTimeRange))
      throw new PrismDomainError(
        "时段不能再设置生效与结束时间，请用调价计划安排从某个时刻起生效的价目。",
        "PRICING_RULE_DATE_TIME_RANGE_RETIRED",
      );
  }
}

function dateTimeRangeKey(range: { start: Date | string; end: Date | string }): string {
  return `${new Date(range.start).toISOString()}/${new Date(range.end).toISOString()}`;
}

function withRelations(config: PricingConfig, relations: PricingConfigRelations | undefined): PricingConfig {
  if (!relations) return config;
  if (config.kind !== "time.priority") {
    if (relations.requires.length === 0 && relations.conflicts.length === 0) return config;
    throw new PrismDomainError("只有计时方案可以设置依赖与互斥。", "PRICING_RELATION_UNSUPPORTED_KIND");
  }
  return { ...config, relations: { requires: [...relations.requires], conflicts: [...relations.conflicts] } };
}

/**
 * Rebuilds the shop's relation graph with this config in place. Self or unknown
 * references, cycles and contradictions are refused when saved, so a plan that
 * can never start never reaches a player.
 */
async function assertRelationGraphHolds(config: PricingConfig, dependencies: StaffPricingServiceDependencies): Promise<void> {
  const others = (await dependencies.pricingConfigs.listAll()).filter((candidate) => candidate.id !== config.id);
  buildPricingRelationGraph([...others, config]);
}

async function createPricingConfigForKind(
  kind: PricingConfigKind,
  provider: PricingConfig["provider"],
  base: Omit<PricingConfig, "kind" | "provider">,
  dependencies: StaffPricingServiceDependencies,
): Promise<PricingConfig> {
  switch (kind) {
    case "time.priority":
      if (
        !("rules" in provider) ||
        "includedPricingConfigIds" in provider ||
        provider.rules.some((rule) => !("pricing" in rule))
      ) {
        throw new PrismDomainError("Time priority pricing requires time rules.", "INVALID_TIME_PRIORITY_PROVIDER");
      }
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(
          await withUtcPricingClock(
            provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
            dependencies,
          ),
        ),
      };
    case "time.cap":
      if (
        !("rules" in provider) ||
        provider.rules.some((rule) => "pricing" in rule || !("priceCap" in rule))
      ) {
        throw new PrismDomainError("封顶规则的每个时段只需要封顶金额，不能带单价。", "INVALID_TIME_CAP_PROVIDER");
      }
      // A cap across plans holds every time plan; it no longer names any.
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(
          await withUtcCapClock(
            { ...(provider as Extract<PricingConfig, { kind: "time.cap" }>["provider"]), includedPricingConfigIds: [] },
            dependencies,
          ),
        ),
      };
    case "charge.fixed":
      if (!("amount" in provider)) {
        throw new PrismDomainError("Fixed charge pricing requires an amount.", "INVALID_FIXED_CHARGE_PROVIDER");
      }
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(provider),
      };
  }
}

async function withUtcPricingClock(
  provider: Extract<PricingConfig, { kind: "time.priority" }>["provider"],
  dependencies: StaffPricingServiceDependencies,
  referenceDate = dependencies.now().toISOString().slice(0, 10),
): Promise<Extract<PricingConfig, { kind: "time.priority" }>["provider"]> {
  const { historyProviderId, ...editedProvider } = provider;
  const timeZone = provider.timeZone ?? "UTC";
  return {
    ...editedProvider,
    timeZone: "UTC",
    rules: provider.rules.map(rule => {
      const { historyRuleId, anchorAt, ...editedRule } = rule;
      return convertPricingRuleClock(editedRule, timeZone, "UTC", referenceDate);
    }),
  };
}

async function withUtcCapClock(
  provider: Extract<PricingConfig, { kind: "time.cap" }>["provider"],
  dependencies: StaffPricingServiceDependencies,
  referenceDate = dependencies.now().toISOString().slice(0, 10),
): Promise<Extract<PricingConfig, { kind: "time.cap" }>["provider"]> {
  const timeZone = provider.timeZone ?? "UTC";
  return {
    ...provider,
    timeZone: "UTC",
    rules: provider.rules.map(rule => {
      const { historyRuleId, anchorAt, ...editedRule } = rule;
      return convertPricingRuleClock(editedRule, timeZone, "UTC", referenceDate);
    }),
  };
}

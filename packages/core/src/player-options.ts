export type PlayerOptionKey = "excludeFromReports" | "privacyMode";

export type PlayerOptionDefinition = {
  key: PlayerOptionKey;
  label: string;
  description: string;
  /** Whether this option is exposed and editable on the player frontend. */
  playerVisible: boolean;
  defaultValue: boolean;
};

export const playerOptionsRegistry: Readonly<Record<PlayerOptionKey, PlayerOptionDefinition>> = {
  excludeFromReports: {
    key: "excludeFromReports",
    label: "排除经营统计",
    description: "不计入经营统计与默认结账列表。",
    playerVisible: false,
    defaultValue: false,
  },
  privacyMode: {
    key: "privacyMode",
    label: "隐私模式",
    description: "开启后，机器人在群播报与查人列表中隐藏你的昵称。",
    playerVisible: true,
    defaultValue: false,
  },
};

export const playerOptionDefinitions: readonly PlayerOptionDefinition[] = [
  playerOptionsRegistry.privacyMode,
  playerOptionsRegistry.excludeFromReports,
];

export type PlayerOptionsShopContext = {
  privacyModeEnabled: boolean;
};

export type PlayerOptionsValues = {
  excludeFromReports: boolean;
  privacyMode: boolean;
};

export function isPlayerOptionKey(value: string): value is PlayerOptionKey {
  return Object.hasOwn(playerOptionsRegistry, value);
}

/** Whether an option is visible and editable to players under this shop's settings. */
export function isPlayerVisibleOption(
  key: PlayerOptionKey,
  shopContext: PlayerOptionsShopContext,
): boolean {
  const definition = playerOptionsRegistry[key];
  if (!definition?.playerVisible) return false;
  if (key === "privacyMode") return shopContext.privacyModeEnabled;
  return true;
}

export function visiblePlayerOptionDefinitions(
  shopContext: PlayerOptionsShopContext,
): PlayerOptionDefinition[] {
  return playerOptionDefinitions.filter((definition) =>
    isPlayerVisibleOption(definition.key, shopContext),
  );
}

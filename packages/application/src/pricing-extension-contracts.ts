export type StaffPricingExtension = {
  id: string;
  name: string;
  kind: "pricing" | "asset-effect" | "workflow";
  summary: string;
  status: "enabled" | "disabled";
  configuredBy: "plugin" | "staff-web";
  capabilities: readonly string[];
  configurationStatus?: "ready" | "needs-setup";
  requiredAssets?: readonly StaffPricingExtensionRequiredAsset[];
};

export type StaffPricingExtensionRequiredAsset = {
  type: string;
  code: string;
  name: string;
  status?: "ready" | "missing" | "archived";
};

export type StaffPricingExtensionProvider =
  | readonly StaffPricingExtension[]
  | (() => Promise<readonly StaffPricingExtension[]>);

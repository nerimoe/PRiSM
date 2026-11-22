import type { Resource } from "../../api";
import type { Settings } from "../BillingPages";
import { resourceCapabilities, isUnconfigured } from "./resource-capabilities";

/** How a player proves who they are before entering or using a guarded device. */
export type IdentityPolicy = "web" | "bot" | "existing";

export const identityPolicy = (
  settings: Pick<Settings, "identityBindingRequired" | "autoRegister">,
): IdentityPolicy =>
  !settings.identityBindingRequired
    ? "web"
    : settings.autoRegister
      ? "bot"
      : "existing";

export const identityPolicySettings = (policy: IdentityPolicy) =>
  policy === "web"
    ? { identityBindingRequired: false }
    : { identityBindingRequired: true, autoRegister: policy === "bot" };

/**
 * How the shop takes money. A shop with a front desk always takes payment
 * there; one without may still have staff, but they do not handle money.
 * "devices" shops have no plan on any resource yet: they bill elsewhere and
 * use PRiSM only to run devices. It is a description, not a switch.
 */
export type OperatingMode = "devices" | "self" | "desk";

export const operatingMode = (
  input: { billing: boolean; cashierEnabled: boolean },
): OperatingMode =>
  !input.billing ? "devices" : input.cashierEnabled ? "desk" : "self";

export type SetupResourceGroup = {
  id: string;
  defaultPricingConfigId: string | null;
  enabled?: boolean;
};

/**
 * Whether any resource bills: a resource group (the default group's plan is
 * the shop default) or a resource of its own has a plan.
 */
export const shopBills = (
  groups: { defaultPricingConfigId: string | null }[],
  machines: Pick<Resource, "pricingConfigOverrideId">[],
) => groups.some((group) => !!group.defaultPricingConfigId) || machines.some((machine) => !!machine.pricingConfigOverrideId);

/**
 * Whether a single resource actually starts a billing plan when used: either it
 * has its own override plan, or its group is enabled and has a default plan.
 */
export const resourceBilled = (
  machine: Pick<Resource, "resourceGroupId" | "pricingConfigOverrideId">,
  groups: readonly SetupResourceGroup[],
): boolean => {
  if (machine.pricingConfigOverrideId) return true;
  const group = groups.find((g) => g.id === (machine.resourceGroupId ?? "default"));
  return !!group && group.enabled !== false && !!group.defaultPricingConfigId;
};

export type SetupSignals = {
  settings: Settings;
  /** Whether any resource bills; see `shopBills`. */
  billing: boolean;
  machines: Resource[];
  groups?: readonly SetupResourceGroup[];
  ttLock: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    appAccount?: string;
  } | null;
  /** Players of a billing shop; device-only shops do not keep a roster. */
  players: { walletTotal: number }[] | null;
  /** Redeem codes that can still be used. */
  redeemCodes: number;
  /** A HINATA reader is authorized in this browser; `null` when WebHID is absent. */
  reader: boolean | null;
  members: number;
  presents: number;
  defaultPresent: boolean;
  /** The owner said they printed the codes and tried one; nothing records it. */
  trialConfirmed: boolean;
};

export type SetupStepId =
  | "pricing"
  | "identity"
  | "prepaid"
  | "reader"
  | "staff"
  | "devices"
  | "door"
  | "trial";

export type SetupStep = { id: SetupStepId; done: boolean };

export type SetupStatus = {
  mode: OperatingMode;
  billing: boolean;
  steps: SetupStep[];
  complete: boolean;
  /** Why billing is not ready: no balance asset. */
  pricingProblem: "assets" | null;
  /** Why front-desk billing is not ready: missing/disabled desk resource or unbilled desk resource. */
  deskProblem: "missing" | "unbilled" | null;
  devices: number;
  unconfigured: number;
  doorDevices: number;
  identity: IdentityPolicy;
  identityMatters: boolean;
  botIssued: boolean;
  botConnected: boolean;
  botAnnounceGroups: number;
  ioMissingToken: number;
  ioE2ee: number;
  ioExternal: number;
  coinIncomplete: number;
  bindingPrompt: string;
  ttLockReady: boolean;
  players: number;
  fundedPlayers: number;
  redeemCodes: number;
  reader: boolean | null;
  members: number;
  presents: number;
  defaultPresent: boolean;
  locationEnabled: boolean;
};

/**
 * Derive the shop's setup checklist from data the admin already reads. A step
 * is listed only when a real player would be stuck without it, and the list
 * follows how the shop takes money.
 */
export function setupStatus(signals: SetupSignals): SetupStatus {
  const { settings, machines } = signals;
  const mode = operatingMode({ billing: signals.billing, cashierEnabled: settings.cashierEnabled });
  const billing = mode !== "devices";
  const shopResources = machines.filter((machine) => !machine.bot);
  const groups = signals.groups ?? [];
  const caps = shopResources.map(resourceCapabilities);
  const unconfigured = shopResources.filter(
    (machine) => isUnconfigured(machine) && !resourceBilled(machine, groups),
  ).length;
  const doorDevices = caps.filter((c) => c.door).length;
  const activeBots = machines.filter((machine) => machine.enabled && machine.bot && machine.hasBotToken);
  const botConnected = activeBots.some((machine) => machine.botOnline === true || !!machine.botLastUsedAt);
  const botAnnounceGroups = activeBots.reduce(
    (sum, machine) => sum + (machine.bot?.announceGroups?.length ?? 0),
    0,
  );
  const enabledShop = shopResources.filter((machine) => !!machine.enabled);
  const ioMissingToken = enabledShop.filter(
    (machine) =>
      resourceCapabilities(machine).hinata_io &&
      machine.relayConnection === "embedded" &&
      machine.hasRelayToken === false,
  ).length;
  const ioE2ee = enabledShop.filter(
    (machine) =>
      resourceCapabilities(machine).hinata_io &&
      machine.relayConnection === "embedded" &&
      machine.relayE2ee === true,
  ).length;
  const ioExternal = enabledShop.filter(
    (machine) =>
      resourceCapabilities(machine).hinata_io &&
      machine.relayConnection !== "embedded",
  ).length;
  const coinIncomplete = enabledShop.filter(
    (machine) => !!machine.coin && !machine.coin.keyId,
  ).length;
  const identity = identityPolicy(settings);
  const ttLock = signals.ttLock;
  const ttLockReady = !!(
    ttLock?.clientId &&
    ttLock.clientSecret &&
    (ttLock.accessToken || ttLock.appAccount)
  );
  // The server asks for a shop player on every billed device, and on doors
  // and mahjong tables everywhere.
  const identityMatters = billing || caps.some((c) => c.door || c.mahjong);
  const players = signals.players ?? [];
  const fundedPlayers = players.filter((player) => player.walletTotal > 0).length;
  const steps: SetupStep[] = [];
  const configuration = settings.billingConfiguration;
  // Some resource already has a plan, so pricing is ready once players have a
  // balance to pay from.
  const pricingProblem =
    !billing || !configuration || configuration.balanceAssetsReady ? null : "assets" as const;
  const desk = settings.cashierResourceId
    ? shopResources.find((machine) => machine.id === settings.cashierResourceId && !!machine.enabled)
    : undefined;
  const deskProblem: SetupStatus["deskProblem"] =
    mode !== "desk"
      ? null
      : !desk
        ? "missing"
        : signals.groups !== undefined && !resourceBilled(desk, groups)
          ? "unbilled"
          : null;
  if (billing)
    steps.push({ id: "pricing", done: !!configuration && !pricingProblem && !deskProblem });
  if (mode === "desk") {
    steps.push({ id: "reader", done: signals.reader === true });
    steps.push({ id: "staff", done: signals.members > 1 });
  }
  if (identityMatters)
    steps.push({ id: "identity", done: identity === "web" || botConnected });
  if (mode === "self")
    steps.push({ id: "prepaid", done: signals.redeemCodes > 0 || fundedPlayers > 0 });
  steps.push({ id: "devices", done: shopResources.length > 0 && unconfigured === 0 });
  if (doorDevices) steps.push({ id: "door", done: ttLockReady });
  steps.push({
    id: "trial",
    done: signals.trialConfirmed || (billing && players.length > 0),
  });
  return {
    mode,
    billing,
    steps,
    complete: steps.every((step) => step.done),
    pricingProblem,
    deskProblem,
    devices: shopResources.length,
    unconfigured,
    doorDevices,
    identity,
    identityMatters,
    botIssued: activeBots.length > 0,
    botConnected,
    botAnnounceGroups,
    ioMissingToken,
    ioE2ee,
    ioExternal,
    coinIncomplete,
    bindingPrompt: settings.botContact ?? "",
    ttLockReady,
    players: players.length,
    fundedPlayers,
    redeemCodes: signals.redeemCodes,
    reader: signals.reader,
    members: signals.members,
    presents: signals.presents,
    defaultPresent: signals.defaultPresent,
    locationEnabled: settings.locationEnabled,
  };
}

import { describe, expect, it } from "vitest";
import type { Resource } from "../../api";
import type { Settings } from "../BillingPages";
import {
  identityPolicy,
  identityPolicySettings,
  operatingMode,
  resourceBilled,
  setupStatus,
  shopBills,
  type SetupSignals,
} from "./setup-guide";

const machine = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "机台",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  mahjong: null,
  coinKey: 0,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
});

const ready = { ready: true, balanceAssetsReady: true };

const settings = (over: Partial<Settings> = {}): Settings => ({
  cashierEnabled: false,
  autoRegister: true,
  identityBindingRequired: true,
  locationEnabled: false,
  checkinGeo: false,
  checkoutGeo: false,
  machineGeo: false,
  botContact: "",
  ...over,
});

const signals = (over: Partial<SetupSignals> = {}): SetupSignals => ({
  settings: settings(),
  billing: false,
  machines: [],
  ttLock: null,
  players: null,
  redeemCodes: 0,
  reader: null,
  members: 1,
  presents: 0,
  defaultPresent: false,
  trialConfirmed: false,
  ...over,
});

const ids = (status: ReturnType<typeof setupStatus>) => status.steps.map((step) => `${step.id}:${step.done ? "done" : "todo"}`);
const bot = (over: Partial<Resource> = {}) => machine({
  id: "bot", hasBotToken: true, botLastUsedAt: "2026-10-20T00:00:00Z",
  bot: {
    playerCommands: "all", readOnlyNotice: "", staffCommands: true, powerOffStaffOnly: false,
    doorResourceId: null, receiptsToStaff: false, doorPasswordOnEntry: false, announceGroups: [],
    idleReminderMinutes: 5,
  },
  ...over,
});

describe("setup guide", () => {
  it("maps the two identity switches to the policies and back", () => {
    for (const policy of ["web", "bot", "existing"] as const) {
      expect(identityPolicy({ ...settings(), ...identityPolicySettings(policy) })).toBe(policy);
    }
    expect(identityPolicy(settings({ identityBindingRequired: false, autoRegister: false }))).toBe("web");
  });

  it("reads the operating mode from billing and the front desk", () => {
    expect(operatingMode({ billing: false, cashierEnabled: false })).toBe("devices");
    expect(operatingMode({ billing: true, cashierEnabled: false })).toBe("self");
    expect(operatingMode({ billing: true, cashierEnabled: true })).toBe("desk");
  });

  it("asks a device-only shop only for devices and a trial", () => {
    const status = setupStatus(signals());
    expect(status.mode).toBe("devices");
    expect(ids(status)).toEqual(["devices:todo", "trial:todo"]);
  });

  it("asks a device-only shop about identity once a door needs a shop player", () => {
    const status = setupStatus(signals({ machines: [machine({ ttlockLockId: 7 })] }));
    expect(ids(status)).toEqual(["identity:todo", "devices:done", "door:todo", "trial:todo"]);
  });

  it("walks a self-service shop through pricing, identity, prepaid balance, devices and a trial", () => {
    const status = setupStatus(signals({ billing: true, settings: settings({ billingConfiguration: ready }), players: [] }));
    expect(status.mode).toBe("self");
    expect(ids(status)).toEqual(["pricing:done", "identity:todo", "prepaid:todo", "devices:todo", "trial:todo"]);
  });

  it("counts prepaid balance as ready once a code can be sold or a player holds balance", () => {
    const base = { billing: true, settings: settings({ billingConfiguration: ready }) };
    const prepaid = (over: Partial<SetupSignals>) => setupStatus(signals({ ...base, ...over })).steps.find((s) => s.id === "prepaid")!.done;
    expect(prepaid({ players: [] })).toBe(false);
    expect(prepaid({ players: [], redeemCodes: 3 })).toBe(true);
    expect(prepaid({ players: [{ walletTotal: 5 }] })).toBe(true);
  });

  it("walks a front-desk shop through the reader and staff instead of prepaid balance", () => {
    const desk = machine({ id: "desk-1", name: "前台" });
    const groups = [{ id: "default", defaultPricingConfigId: "p1", enabled: true }];
    const status = setupStatus(signals({
      billing: true,
      settings: settings({ cashierEnabled: true, cashierResourceId: "desk-1", billingConfiguration: ready }),
      machines: [desk],
      groups,
      players: [],
      reader: false,
    }));
    expect(status.mode).toBe("desk");
    expect(status.deskProblem).toBeNull();
    expect(ids(status)).toEqual(["pricing:done", "reader:todo", "staff:todo", "identity:todo", "devices:done", "trial:todo"]);
    const ready2 = setupStatus(signals({
      billing: true,
      settings: settings({ cashierEnabled: true, cashierResourceId: "desk-1", billingConfiguration: ready }),
      machines: [desk],
      groups,
      players: [], reader: true, members: 2,
    }));
    expect(ready2.steps.filter((s) => s.id === "reader" || s.id === "staff").every((s) => s.done)).toBe(true);
  });

  it("flags missing or unbilled front-desk resources on the pricing step", () => {
    const desk = machine({ id: "desk-1", name: "前台" });
    const missing = setupStatus(signals({
      billing: true,
      settings: settings({ cashierEnabled: true, cashierResourceId: null, billingConfiguration: ready }),
      machines: [desk],
      groups: [{ id: "default", defaultPricingConfigId: "p1", enabled: true }],
    }));
    expect(missing.deskProblem).toBe("missing");
    expect(missing.steps.find((s) => s.id === "pricing")?.done).toBe(false);

    const disabled = setupStatus(signals({
      billing: true,
      settings: settings({ cashierEnabled: true, cashierResourceId: "desk-1", billingConfiguration: ready }),
      machines: [machine({ id: "desk-1", name: "前台", enabled: false })],
      groups: [{ id: "default", defaultPricingConfigId: "p1", enabled: true }],
    }));
    expect(disabled.deskProblem).toBe("missing");

    const unbilled = setupStatus(signals({
      billing: true,
      settings: settings({ cashierEnabled: true, cashierResourceId: "desk-1", billingConfiguration: ready }),
      machines: [desk],
      groups: [{ id: "default", defaultPricingConfigId: null, enabled: true }],
    }));
    expect(unbilled.deskProblem).toBe("unbilled");
    expect(unbilled.steps.find((s) => s.id === "pricing")?.done).toBe(false);
  });

  it("does not count a bot alone as a shop resource and allows billed QR-only resources", () => {
    const botOnly = setupStatus(signals({ machines: [bot()] }));
    expect(botOnly.devices).toBe(0);
    expect(botOnly.steps.find((s) => s.id === "devices")?.done).toBe(false);

    const freeQr = machine({ id: "qr-free", name: "休息区" });
    const billedGroup = [{ id: "default", defaultPricingConfigId: "p1", enabled: true }];
    const freeGroup = [{ id: "default", defaultPricingConfigId: null, enabled: true }];
    expect(resourceBilled(freeQr, freeGroup)).toBe(false);
    expect(resourceBilled(freeQr, billedGroup)).toBe(true);
    expect(resourceBilled(machine({ id: "qr-own", pricingConfigOverrideId: "vip" }), freeGroup)).toBe(true);

    const withFreeQr = setupStatus(signals({ machines: [freeQr], groups: freeGroup }));
    expect(withFreeQr.unconfigured).toBe(1);
    expect(withFreeQr.steps.find((s) => s.id === "devices")?.done).toBe(false);

    const withBilledQr = setupStatus(signals({
      billing: true,
      settings: settings({ billingConfiguration: ready }),
      machines: [freeQr],
      groups: billedGroup,
    }));
    expect(withBilledQr.unconfigured).toBe(0);
    expect(withBilledQr.steps.find((s) => s.id === "devices")?.done).toBe(true);
  });

  it("reports hardware and bot diagnostics only for enabled resources", () => {
    const status = setupStatus(signals({
      machines: [
        bot({
          bot: {
            playerCommands: "all", readOnlyNotice: "", staffCommands: true, powerOffStaffOnly: false,
            doorResourceId: null, receiptsToStaff: false, doorPasswordOnEntry: false,
            announceGroups: [{ id: "g1", name: "群", to: ["onebot:1"], events: {}, templates: {} }],
            idleReminderMinutes: 5,
          },
        }),
        machine({ id: "io-e2ee", hasHinata: true, relayConnection: "embedded", hasRelayToken: true, relayE2ee: true }),
        machine({ id: "io-notoken", hasHinata: true, relayConnection: "embedded", hasRelayToken: false }),
        machine({ id: "io-ext", hasHinata: true, relayConnection: "external" }),
        machine({ id: "coin-nokey", coin: { method: "key", keyId: null, cap: null, afterSwipe: false } }),
        machine({ id: "io-disabled", enabled: false, hasHinata: true, relayConnection: "embedded", hasRelayToken: false, relayE2ee: true }),
      ],
    }));
    expect(status.botAnnounceGroups).toBe(1);
    expect(status.ioE2ee).toBe(1);
    expect(status.ioMissingToken).toBe(1);
    expect(status.ioExternal).toBe(1);
    expect(status.coinIncomplete).toBe(1);
    expect(status.steps.find((s) => s.id === "devices")?.done).toBe(true);
  });

  it("reads bot setup from enabled resources with an active, used credential", () => {
    const base = { billing: true, settings: settings(), players: [] };
    const status = (machines: Resource[]) => setupStatus(signals({ ...base, machines }));
    expect(status([bot()])).toMatchObject({ botIssued: true, botConnected: true });
    expect(status([bot()]).steps.find((s) => s.id === "identity")!.done).toBe(true);
    expect(status([bot({ botLastUsedAt: null })])).toMatchObject({ botIssued: true, botConnected: false });
    expect(status([bot({ botLastUsedAt: null, botOnline: true })]).botConnected).toBe(true);
    expect(status([bot({ botOnline: false })]).botConnected).toBe(true);
    expect(status([bot({ botLastUsedAt: null, botOnline: null })]).botConnected).toBe(false);
    for (const resource of [bot({ enabled: false }), bot({ hasBotToken: false }), bot({ bot: null })]) {
      expect(status([resource])).toMatchObject({ botIssued: false, botConnected: false });
      expect(status([resource]).steps.find((s) => s.id === "identity")!.done).toBe(false);
    }
    expect(status([bot({ hasBotToken: false, botOnline: true })]).botConnected).toBe(false);
    expect(status([bot({ enabled: false }), bot({ id: "other-bot" })]).botConnected).toBe(true);
  });

  it("explains why billing is not ready: only a missing balance asset stops it", () => {
    const problem = (balanceAssetsReady: boolean) =>
      setupStatus(signals({
        billing: true,
        settings: settings({ billingConfiguration: { ready: balanceAssetsReady, balanceAssetsReady } }),
      })).pricingProblem;
    expect(problem(false)).toBe("assets");
    // Which resources bill is set on groups; there is no default plan to check.
    expect(problem(true)).toBeNull();
  });

  it("bills wherever a group or a resource has a plan, with no shop-wide switch", () => {
    const free = { defaultPricingConfigId: null };
    expect(shopBills([free], [machine()])).toBe(false);
    expect(shopBills([free, { defaultPricingConfigId: "night" }], [])).toBe(true);
    expect(shopBills([free], [machine({ pricingConfigOverrideId: "vip" })])).toBe(true);
  });

  it("completes a configured self-service shop once someone has played", () => {
    const status = setupStatus(signals({
      billing: true, settings: settings({ billingConfiguration: ready }),
      machines: [bot(), machine({ homeAssistant: { url: "http://ha", entityId: "switch.a" } })],
      players: [{ walletTotal: 10 }],
    }));
    expect(status.complete).toBe(true);
  });
});

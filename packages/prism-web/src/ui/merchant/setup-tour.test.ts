import { describe, expect, it } from "vitest";
import type { Resource } from "../../api";
import english from "../../locales/en.json";
import type { Settings } from "../BillingPages";
import { setupStatus, type SetupSignals } from "./setup-guide";
import {
  buildTourSteps,
  findTourStepIndex,
  isStepDone,
  tourRouteParts,
} from "./setup-tour";

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
  table: null,
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

const bot = (over: Partial<Resource> = {}) =>
  machine({
    id: "bot",
    hasBotToken: true,
    botLastUsedAt: "2026-10-20T00:00:00Z",
    bot: {
      playerCommands: "all",
      readOnlyNotice: "",
      staffCommands: true,
      powerOffStaffOnly: false,
      doorResourceId: null,
      doorPasswordOnEntry: false,
      announceGroups: [],
      idleReminderMinutes: 5,
    },
    ...over,
  });

describe("setup tour", () => {
  it("builds a concise device-only tour and skips billing/prepaid steps", () => {
    const status = setupStatus(signals());
    const ids = buildTourSteps(status).map((s) => s.id);
    expect(ids).toEqual([
      "resources-group",
      "resources-add",
      "qr-trial",
      "dashboard-overview",
    ]);
  });

  it("walks self-service shops through resources, pricing, bot, prepaid gifts/codes, trial, and dashboard", () => {
    const status = setupStatus(
      signals({
        billing: true,
        settings: settings({ billingConfiguration: ready }),
        players: [],
      }),
    );
    const steps = buildTourSteps(status);
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      "resources-group",
      "resources-add",
      "pricing-plans",
      "pricing-bindings",
      "identity-policy",
      "identity-bot-add",
      "prepaid-gift",
      "prepaid-code",
      "qr-trial",
      "dashboard-overview",
    ]);
    expect(steps.find((s) => s.id === "resources-group")?.diagram).toBe("store-hierarchy");
    expect(steps.find((s) => s.id === "pricing-bindings")?.diagram).toBe("store-example-override");
  });

  it("walks front-desk shops through reader, staff, and missing-asset or desk-resource recovery", () => {
    const missingDesk = setupStatus(
      signals({
        billing: true,
        settings: settings({
          cashierEnabled: true,
          cashierResourceId: null,
          billingConfiguration: ready,
          identityBindingRequired: false,
        }),
        machines: [machine({ id: "desk-1", name: "前台" })],
        groups: [{ id: "default", defaultPricingConfigId: "p1", enabled: true }],
        reader: false,
      }),
    );
    const deskIds = buildTourSteps(missingDesk).map((s) => s.id);
    expect(deskIds).toContain("pricing-desk-resource");
    expect(deskIds).toContain("cashier-reader");
    expect(deskIds).toContain("staff-invite");
    expect(deskIds).not.toContain("prepaid-gift");
    expect(deskIds).not.toContain("identity-bot-add");

    const missingAssets = setupStatus(
      signals({
        billing: true,
        settings: settings({
          billingConfiguration: { ready: false, balanceAssetsReady: false },
          identityBindingRequired: false,
        }),
        players: [],
      }),
    );
    expect(buildTourSteps(missingAssets).map((s) => s.id)).toContain("pricing-assets");
  });

  it("includes TTLock step only when door devices exist", () => {
    const withDoor = setupStatus(
      signals({ machines: [machine({ ttlockLockId: 12 }), bot()] }),
    );
    const ids = buildTourSteps(withDoor).map((s) => s.id);
    expect(ids).toContain("door-ttlock");
    expect(ids).not.toContain("identity-bot-add");
  });

  it("picks the starting step by stepId, setupStep, or first incomplete checklist item", () => {
    const status = setupStatus(
      signals({
        billing: true,
        settings: settings({ billingConfiguration: ready }),
        machines: [machine({ homeAssistant: { url: "http://ha", entityId: "switch.a" } })],
        players: [],
      }),
    );
    const steps = buildTourSteps(status);
    expect(steps[findTourStepIndex(steps, { stepId: "prepaid-code" })]!.id).toBe("prepaid-code");
    expect(steps[findTourStepIndex(steps, { setupStep: "prepaid" })]!.id).toBe("prepaid-gift");
    // pricing & devices are done; identity is first incomplete checklist item
    expect(steps[findTourStepIndex(steps, { fromIncomplete: true, status })]!.id).toBe("identity-policy");
    expect(isStepDone(steps.find((s) => s.id === "resources-add")!, status)).toBe(true);
    expect(isStepDone(steps.find((s) => s.id === "identity-policy")!, status)).toBe(false);
  });

  it("parses relative merchant routes with and without query strings", () => {
    expect(tourRouteParts("my shop", "resources")).toEqual({
      pathname: "/merchant/my%20shop/resources",
      search: "",
      full: "/merchant/my%20shop/resources",
    });
    expect(tourRouteParts("shop-1", "assets?tab=gifts")).toEqual({
      pathname: "/merchant/shop-1/assets",
      search: "?tab=gifts",
      full: "/merchant/shop-1/assets?tab=gifts",
    });
  });

  it("provides English localization keys for every generated tour text", () => {
    const scenarios = [
      setupStatus(signals()),
      setupStatus(
        signals({
          billing: true,
          settings: settings({
            billingConfiguration: { ready: false, balanceAssetsReady: false },
          }),
          machines: [machine({ ttlockLockId: 1 })],
          players: [],
        }),
      ),
      setupStatus(
        signals({
          billing: true,
          settings: settings({
            cashierEnabled: true,
            cashierResourceId: null,
            billingConfiguration: ready,
          }),
          machines: [machine({ id: "desk-1" })],
          groups: [{ id: "default", defaultPricingConfigId: "p1", enabled: true }],
          reader: false,
        }),
      ),
    ];

    const missing: string[] = [];
    for (const status of scenarios) {
      for (const step of buildTourSteps(status)) {
        for (const text of [
          step.chapter,
          step.title,
          step.concept,
          step.action,
          ...(step.modalHint ? [step.modalHint.title, step.modalHint.body] : []),
        ]) {
          if (!(text in english)) missing.push(text);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

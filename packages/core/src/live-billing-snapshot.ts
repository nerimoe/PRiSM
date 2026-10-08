import type { AssetDefinition } from "./assets";
import type { AssetHolding } from "./assets";
import type { Cents } from "./money";
import type { PricingConfig, PricingRelease } from "./pricing-config";
import type { Session } from "./session";
import type { PastAppliedAdjustment } from "./settlement";

/** Read-only engine inputs; money is stored in minor units and all instants are UTC. */
export type LiveBillingSnapshot = {
  version: 1;
  capturedAt: Date;
  assetDefinitions: AssetDefinition[];
  currentPricingConfigs: PricingConfig[];
  pricingReleases: PricingRelease[];
  players: Array<{
    playerId: string;
    sessions: Session[];
    holdings: AssetHolding[];
    pastAppliedAdjustments: PastAppliedAdjustment[];
    pricingPaidHistory: Record<string, Cents>;
    capPaidHistory: Record<string, Cents>;
  }>;
};

/**
 * How a HINATA IO tells who is at its cabinet.
 *
 * - The game took a card (`card.consumed`): the card's owner occupies the
 *   cabinet, for physical cards on its reader and cards the platform sent
 *   alike, once occupancy verifies its owner is billing for this resource.
 *   A card the game never took tells nothing, so neither does a swipe
 *   requested through the platform. A card nobody bound here tells nothing
 *   either: the cabinet stays as it is.
 * - A coin requested through the platform for a player (`coinOccupancy`):
 *   that player occupies it. The cabinet's own coin count cannot say whose
 *   coin it was.
 *
 * Switching a cabinet on, or keeping it from idling, says nothing about who
 * plays; those only hold off the idle power-off.
 */
import type { OccupancyProvider } from "../occupancy/providers.js";

export const hinataOccupancy: OccupancyProvider = {
  capability: "hinata_io",
  authority: 10,
  // One provider decides a resource, so the IO also reads its coins (`coinOccupancy` alone does without an IO).
  fromAction: (input) => coinOccupancy.fromAction!(input),
  fromSignal({ name, playerId }) {
    if (!playerId) return null;
    if (name === "card.consumed") return { kind: "occupy", playerId };
    return null;
  },
};

/** A coin requested through the platform for a player: that player occupies the cabinet. */
export const coinOccupancy: OccupancyProvider = {
  capability: "coin",
  authority: 5,
  fromAction({ action, playerId }) {
    if (!playerId) return null;
    return action === "coin" ? { kind: "occupy", playerId } : null;
  },
};

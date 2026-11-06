import { describe, expect, it } from "bun:test";
import { cabinetChanges, type CabinetBooks } from "../src/resources/capabilities/cabinet.js";

/** Books of a maimai cabinet (one shared coin slot), with only what a test varies. */
function books(credit: number, counters: Partial<CabinetBooks["bookkeeping"]> = {}, remain = 0): CabinetBooks {
  return {
    revision: 1,
    readAtMs: 0,
    players: [{ credit, remain }, { credit, remain }],
    bookkeeping: { totalCoin: 218, coinCredit: 59, serviceCredit: 0, emoneyCredit: 0, totalCredit: 59, ...counters },
    creditConfig: { cost: [1, 1, 1, 1, 1, 1, 1, 1] },
  };
}

describe("what changed at a cabinet between two reads of its books", () => {
  it("says nothing when nothing moved", () => {
    expect(cabinetChanges(books(4), books(4))).toEqual([]);
  });

  it("tells a coin, whatever came of it", () => {
    expect(cabinetChanges(books(4), books(5, { totalCoin: 219, coinCredit: 60, totalCredit: 60 }))).toEqual([
      { type: "cabinet.coin", detail: { coins: 1, credit: 5 } },
    ]);
    // The platform does not judge whether a coin became a credit: the player sees that at the cabinet.
    expect(cabinetChanges(books(24), books(24, { totalCoin: 219 }))).toEqual([
      { type: "cabinet.coin", detail: { coins: 1, credit: 24 } },
    ]);
  });

  it("tells credits spent, and counts what was given in the same gap", () => {
    expect(cabinetChanges(books(4), books(3))).toEqual([{ type: "cabinet.consumed", detail: { credits: 1, credit: 3 } }]);
    // A read missed in between: a coin went in and a game started. Nothing is lost.
    expect(cabinetChanges(books(4), books(4, { totalCoin: 219, coinCredit: 60, totalCredit: 60 }))).toEqual([
      { type: "cabinet.coin", detail: { coins: 1, credit: 4 } },
      { type: "cabinet.consumed", detail: { credits: 1, credit: 4 } },
    ]);
    // Service credits are given too.
    expect(cabinetChanges(books(0), books(0, { serviceCredit: 1, totalCredit: 60 }))).toEqual([
      { type: "cabinet.consumed", detail: { credits: 1, credit: 0 } },
    ]);
  });

  it("reads a counter going down as the books being cleared, and nothing else", () => {
    expect(cabinetChanges(books(4), books(2, { totalCoin: 0, coinCredit: 0, totalCredit: 0 }))).toEqual([
      { type: "cabinet.reset", detail: { credit: 2 } },
    ]);
  });
});

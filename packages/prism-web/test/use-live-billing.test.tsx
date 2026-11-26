import { expect, test } from "bun:test";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { useLiveBilling } from "../src/ui/merchant/use-live-billing";
import type { LivePlayer } from "../src/ui/merchant/shared";

test("dashboard summary updates reuse the player list for the same billing snapshot", () => {
  const players: LivePlayer[] = [];
  const snapshot = {};
  function DashboardProbe() {
    const current = useLiveBilling(players, snapshot).players;
    const [previous, setPrevious] = useState<LivePlayer[] | null>(null);
    if (previous === null) setPrevious(current);
    else expect(current).toBe(previous);
    return null;
  }
  renderToString(<DashboardProbe />);
});

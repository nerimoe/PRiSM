import {
  createLiveBillingCalculator,
  hydrateLiveBillingSnapshot,
  type LivePlayerView,
} from "@prism/application";

type Request =
  | { type: "init"; snapshot: unknown; players: LivePlayerView[] }
  | { type: "calculate"; playerIds: string[] };
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (message: {
    playerId?: string;
    player?: LivePlayerView;
    error?: string;
  }) => void;
};
let calculator: ReturnType<typeof createLiveBillingCalculator> | undefined;
let queue: string[] = [];
let running = false;

async function drain() {
  if (running || !calculator) return;
  running = true;
  try {
    while (queue.length) {
      const playerId = queue.shift()!;
      try {
        const player = await calculator.calculatePlayer(playerId);
        if (player.estimatedTotal === null)
          scope.postMessage({ playerId, error: "账单预估失败，请刷新后重试" });
        else scope.postMessage({ playerId, player });
      } catch {
        scope.postMessage({ playerId, error: "账单预估失败，请刷新后重试" });
      }
      // Let selection/retry messages update the queue between players.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    running = false;
  }
}

scope.onmessage = (event) => {
  if (event.data.type === "init") {
    try {
      calculator = createLiveBillingCalculator(
        hydrateLiveBillingSnapshot(event.data.snapshot),
        event.data.players,
      );
    } catch {
      scope.postMessage({ error: "计费数据加载失败，请刷新后重试" });
    }
  } else {
    queue = [...new Set([...event.data.playerIds, ...queue])];
    void drain();
  }
};

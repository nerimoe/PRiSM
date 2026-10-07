import { useEffect, useRef, useState } from "react";
import type { LivePlayer } from "./shared";

/** A new API snapshot replaces the worker; stale calculations cannot update the new list. */
export function useLiveBilling(
  players: LivePlayer[],
  snapshot: unknown,
  selectedId?: string,
) {
  const worker = useRef<Worker | null>(null);
  const completed = useRef(new Set<string>());
  const [result, setResult] = useState<{
    source: LivePlayer[];
    quotes: Map<string, LivePlayer>;
    error?: string;
  }>({ source: players, quotes: new Map() });
  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    completed.current = new Set();
    const source = players;
    let instance: Worker;
    try {
      instance = new Worker(
        new URL("../../live-billing.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      setResult({
        source,
        quotes: new Map(),
        error: "计费数据加载失败，请刷新后重试",
      });
      return;
    }
    worker.current = instance;
    setResult({ source, quotes: new Map() });
    instance.onmessage = (
      event: MessageEvent<{
        playerId?: string;
        player?: LivePlayer;
        error?: string;
      }>,
    ) => {
      if (!active) return;
      const { playerId, player, error } = event.data;
      if (!playerId) {
        setResult((current) =>
          active && current.source === source ? { ...current, error } : current,
        );
        return;
      }
      completed.current.add(playerId);
      setResult((current) => {
        if (!active || current.source !== source) return current;
        const base = source.find((row) => row.playerId === playerId);
        if (!base) return current;
        const quotes = new Map(current.quotes);
        quotes.set(playerId, {
          ...base,
          ...player,
          identities: base.identities,
          quoteState: error ? "error" : "ready",
          quoteError: error,
        });
        return { source, quotes };
      });
    };
    instance.onerror = () => {
      if (active)
        setResult((current) => ({
          ...current,
          ...(active && current.source === source
            ? { error: "计费数据加载失败，请刷新后重试" }
            : {}),
        }));
    };
    instance.postMessage({
      type: "init",
      snapshot,
      players: players.map((player) => ({ ...player, identities: [] })),
    });
    instance.postMessage({
      type: "calculate",
      playerIds: [
        selectedId,
        ...players.map((player) => player.playerId),
      ].filter(Boolean),
    });
    return () => {
      active = false;
      instance.terminate();
      if (worker.current === instance) worker.current = null;
    };
    // Selection prioritizes the existing worker without recreating the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, snapshot]);
  useEffect(() => {
    if (selectedId && !completed.current.has(selectedId))
      worker.current?.postMessage({
        type: "calculate",
        playerIds: [selectedId],
      });
  }, [selectedId]);
  return {
    players: snapshot
      ? players.map((player) =>
          result.source === players && result.quotes.has(player.playerId)
            ? result.quotes.get(player.playerId)!
            : {
                ...player,
                quoteState:
                  result.source === players && result.error
                    ? ("error" as const)
                    : ("loading" as const),
                quoteError: result.error,
              },
        )
      : players,
  };
}

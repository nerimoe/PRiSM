import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allPageBlocks, walkPageBlocks, type PageBlock, type PageButtonWait, type PageCelebration, type PageCode } from "@prism/page-protocol";
import { api, ApiError, type Notice } from "../../api";
import { operationLocation, shopApi } from "../BillingPages";
import { useInlineNotice, useNotice } from "../NoticeProvider";
import { ACTION_RETRY, pendingOperations, StillRunning, withRetries, type ActionAnswer } from "../player-page";
import { localNote } from "./notices";

export type Act = (action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean) => Promise<ActionAnswer>;

const hasButton = (blocks: PageBlock[], id: string) =>
  walkPageBlocks(blocks).some((block) => block.kind === "button" && block.id === id);

/** Doing what the page offers: what is running, what came back and where it shows. */
export function usePageActions({ blocks, act, onExpired, onRefresh, onCelebrate, cardsBusy, disabled = false }: {
  blocks: PageBlock[];
  act: Act;
  onExpired: () => void;
  onRefresh: () => void;
  onCelebrate?: (celebration: PageCelebration, answer: ActionAnswer) => void;
  cardsBusy: boolean;
  disabled?: boolean;
}) {
  const showNotice = useNotice();
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [code, setCode] = useState<PageCode | null>(null);
  const [waiting, setWaiting] = useState<(PageButtonWait & { id: string }) | null>(null);
  const [note, showNote] = useInlineNotice();
  const [noteAt, setNoteAt] = useState("");
  /** A field asked this button to be pressed, as if tapped (so its confirm still asks). */
  const [pressRequest, setPressRequest] = useState<{ id: string; n: number } | null>(null);
  const press = useCallback((id: string) => setPressRequest((prev) => ({ id, n: (prev?.n ?? 0) + 1 })), []);
  const showAt = useCallback((id: string, next: Notice) => { setNoteAt(id); showNote(next); }, [showNote]);
  const blocked = !!busy || cardsBusy || disabled;

  const waitingOnPage = !!waiting && hasButton(blocks, waiting.id);
  useEffect(() => { if (waiting && !waitingOnPage) setWaiting(null); }, [waiting, waitingOnPage]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(null);
      showAt(waiting.id, localNote(waiting.timeoutMessage));
    }, waiting.ms);
    return () => clearTimeout(timer);
  }, [waiting, showAt]);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  /** Runs an action for the block `id`; its outcome shows under that block. */
  async function run(id: string, action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean, wait?: PageButtonWait) {
    if (blocked) return;
    const handlers = { onExpired, onRefresh };
    setBusy({ id, action });
    if (noteAt === id) showNote(null);
    try {
      const answer = await act(action, payload, needsLocation);
      for (const notice of answer.notices) {
        if (notice.display === "inline") showAt(id, notice);
        else showNotice(notice, handlers);
      }
      if (answer.code) setCode(answer.code);
      if (answer.ok && answer.celebration) onCelebrate?.(answer.celebration, answer);
      if (wait && answer.ok && hasButton(allPageBlocks(answer.page), id)) setWaiting({ id, ...wait });
    } catch (caught) {
      const notice = showNotice(caught, handlers);
      if (notice.display === "inline") showAt(id, notice);
    } finally {
      setBusy(null);
    }
  }

  return {
    run,
    press,
    pressRequest,
    busy,
    blocked,
    waitingId: waiting?.id ?? null,
    code,
    noteFor: (id: string) => (noteAt === id ? note : null),
  };
}

export type PageActions = ReturnType<typeof usePageActions>;

/** Dispatches a shop- or sheet-level server page action with location + idempotent retry handling. */
export function useShopPageAct(
  shopCode: string,
  view: string,
  onAnswer: (answer: ActionAnswer) => void,
  options?: {
    onPendingChange?: (pending: boolean) => void;
    onBeforeAct?: () => void;
  },
): Act {
  const unanswered = useMemo(() => pendingOperations(`shop:${shopCode}`), [shopCode]);
  const latest = useRef({ onAnswer, options });
  latest.current = { onAnswer, options };

  return useCallback(
    async (action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean): Promise<ActionAnswer> => {
      latest.current.options?.onBeforeAct?.();
      latest.current.options?.onPendingChange?.(true);
      // The same action is one operation whichever view it was pressed on.
      const key = `${action}:${JSON.stringify(payload ?? null)}`;
      const operationId = unanswered.take(key);
      try {
        const location = await operationLocation(needsLocation);
        const answer = await withRetries(
          async (signal) => {
            const result = await api<ActionAnswer>(shopApi(shopCode, "player/action"), {
              method: "POST",
              signal,
              body: JSON.stringify({ view, operationId, action, payload, location }),
            });
            if (result.notices.some((notice) => notice.code === "OPERATION_PENDING")) throw new StillRunning();
            return result;
          },
          { ...ACTION_RETRY },
        );
        unanswered.settle(key);
        latest.current.onAnswer(answer);
        return answer;
      } catch (caught) {
        unanswered.settleOnError(key, caught);
        throw caught;
      } finally {
        latest.current.options?.onPendingChange?.(false);
      }
    },
    [shopCode, view, unanswered],
  );
}

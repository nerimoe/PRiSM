import { useCallback, useEffect, useState } from "react";
import { walkPageBlocks, type PageBlock, type PageButtonWait, type PageCode } from "@prism/page-protocol";
import type { Notice } from "../../api";
import { useInlineNotice, useNotice } from "../NoticeProvider";
import type { ActionAnswer } from "../player-page";
import { localNote } from "./notices";

export type Act = (action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean) => Promise<ActionAnswer>;

const hasButton = (blocks: PageBlock[], id: string) =>
  walkPageBlocks(blocks).some((block) => block.kind === "button" && block.id === id);

/** Doing what the page offers: what is running, what came back and where it shows. */
export function usePageActions({ blocks, act, onExpired, onRefresh, cardsBusy }: {
  blocks: PageBlock[];
  act: Act;
  onExpired: () => void;
  onRefresh: () => void;
  cardsBusy: boolean;
}) {
  const showNotice = useNotice();
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [code, setCode] = useState<PageCode | null>(null);
  const [waiting, setWaiting] = useState<(PageButtonWait & { id: string }) | null>(null);
  const [note, showNote] = useInlineNotice();
  const [noteAt, setNoteAt] = useState("");
  const showAt = useCallback((id: string, next: Notice) => { setNoteAt(id); showNote(next); }, [showNote]);
  const blocked = !!busy || cardsBusy;

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
      if (wait && answer.ok && hasButton(answer.page.blocks, id)) setWaiting({ id, ...wait });
    } catch (caught) {
      const notice = showNotice(caught, handlers);
      if (notice.display === "inline") showAt(id, notice);
    } finally {
      setBusy(null);
    }
  }

  return {
    run,
    busy,
    blocked,
    waitingId: waiting?.id ?? null,
    code,
    noteFor: (id: string) => (noteAt === id ? note : null),
  };
}

export type PageActions = ReturnType<typeof usePageActions>;

import { useEffect, useRef, useState } from "react";
import type { PageCards } from "@prism/page-protocol";
import type { Notice } from "../../../api";
import { useNotice } from "../../NoticeProvider";
import { usePageContext } from "../page-context";

/** A swipe's outcome on its row: the card's part, then the coin's, each with its own level. */
export type SwipeFeedback = { cardId: string; parts: Pick<Notice, "level" | "body">[] };

export function useCardSwipe({ block, onRefused }: {
  block: PageCards;
  onRefused: () => void;
}) {
  const { actions, act, refresh: onRefresh, onExpired } = usePageContext();
  const showNotice = useNotice();
  const [swiping, setSwiping] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SwipeFeedback | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** Shown for a few seconds; the page stays usable meanwhile. */
  const showFeedback = (next: SwipeFeedback | null) => {
    clearTimeout(timer.current);
    setFeedback(next);
    if (next) timer.current = setTimeout(() => setFeedback(null), next.parts[0]?.level === "success" ? 3000 : 5000);
  };

  const swipe = async (cardId: string) => {
    if (swiping || actions.busy) return;
    setSwiping(cardId);
    showFeedback(null);
    try {
      const answer = await act(block.action, { cardId }, block.needsLocation);
      // The row carries the outcome; only a problem that needs the player interrupts.
      const inline = answer.notices.filter((notice) => notice.display === "inline");
      if (inline.length) showFeedback({ cardId, parts: inline });
      for (const notice of answer.notices) if (notice.display !== "inline") showNotice(notice, { onExpired, onRefresh });
      // A refused swipe may mean the card is gone.
      if (!answer.ok) onRefused();
    } catch (caught) {
      const notice = showNotice(caught, { onExpired, onRefresh, retry: () => void swipe(cardId) });
      if (notice.display === "inline") showFeedback({ cardId, parts: [notice] });
    } finally {
      setSwiping(null);
    }
  };

  return { swiping, feedback, swipe };
}

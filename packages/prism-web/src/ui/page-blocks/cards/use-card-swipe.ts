import { useEffect, useRef, useState } from "react";
import type { PageCards } from "@prism/page-protocol";
import type { Notice } from "../../../api";
import { useNotice } from "../../NoticeProvider";
import { noticeLasts } from "../notices";
import { usePageContext } from "../page-context";

/** A swipe's outcome on its row: the card's part, then the coin's, each with its own level. */
export type SwipeFeedback = { cardId: string; parts: Pick<Notice, "level" | "body" | "durationMs">[] };

/** The row as a whole reads as its worst part: an error, else news, else a success. */
export const worstLevel = (parts: Pick<Notice, "level">[]): Notice["level"] =>
  parts.some((part) => part.level === "error") ? "error" : parts.some((part) => part.level === "info") ? "info" : "success";

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

  /** News fades; a row with an error keeps it until the next swipe. The page stays usable meanwhile. */
  const showFeedback = (next: SwipeFeedback | null) => {
    clearTimeout(timer.current);
    setFeedback(next);
    const durations = next?.parts.map((part) => part.durationMs !== undefined ? part.durationMs : noticeLasts(part.level));
    const lasts = durations?.length && durations.every((duration) => duration !== null)
      ? Math.max(...durations as number[]) : null;
    if (lasts) timer.current = setTimeout(() => setFeedback(null), lasts);
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

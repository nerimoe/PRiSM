import { createContext, useContext } from "react";
import type { Page, PageTarget } from "@prism/page-protocol";
import type { Act, PageActions } from "./use-page-actions";
import type { PageForm } from "./use-page-form";

/** What every block on a drawn page can reach. */
export type PageContextValue = {
  page: Page;
  ticket: string;
  form: PageForm;
  actions: PageActions;
  /** A card swipe calls this itself: its outcome shows on the card's row, not under the block. */
  act: Act;
  /** Reads the page again. */
  refresh: () => void;
  /** Goes up when a player waiting to add a card should ask what became of it. */
  cardAsks: number;
  onExpired: () => void;
  /** A card swipe or a card being read: nothing else can be done meanwhile. */
  setCardsBusy: (busy: boolean) => void;
  /** Adding a card takes the place of what is done with one. */
  addingCard: boolean;
  setAddingCard: (adding: boolean) => void;
  /** While set, the page is that block alone and every other one stays off it. */
  soleBlockId: string | null;
  setSoleBlockId: (id: string | null) => void;
  openTarget?: (target: PageTarget) => void;
  loadMore?: (blockId: string, target: PageTarget) => void;
  loadingMoreId?: string | null;
  noticeAboveButton?: boolean;
};

export const PageContext = createContext<PageContextValue | null>(null);

export function usePageContext() {
  const value = useContext(PageContext);
  if (!value) throw new Error("page blocks are drawn only inside PlayerPageBlocks");
  return value;
}

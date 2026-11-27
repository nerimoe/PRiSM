import { useEffect, useRef, useState, type ReactNode } from "react";
import { allPageBlocks, type Page, type PageCelebration, type PageTarget } from "@prism/page-protocol";
import { BlockList } from "./page-blocks/BlockView";
import { PageContext } from "./page-blocks/page-context";
import { usePageActions, type Act } from "./page-blocks/use-page-actions";
import { usePageForm } from "./page-blocks/use-page-form";
import type { ActionAnswer } from "./player-page";
import { SessionPasskeySetup } from "./SessionPasskeySetup";

/**
 * Draws the page. Only what the player is in the middle of is kept here; each
 * kind of block is its own component in `page-blocks/`.
 */
export function PlayerPageBlocks({
  page,
  ticket = "",
  act,
  read,
  cardAsks = 0,
  onExpired = () => {},
  openTarget,
  loadMore,
  loadingMoreId,
  loadMoreError,
  onCelebrate,
  onBusyChange,
  disabled = false,
  bodyClassName = "device-controls",
  bodyPrefix,
  footerClassName,
  wrapPasskey = true,
}: {
  page: Page;
  ticket?: string;
  act: Act;
  read: () => Promise<void>;
  cardAsks?: number;
  onExpired?: () => void;
  openTarget?: (target: PageTarget) => void;
  loadMore?: (blockId: string, target: PageTarget) => void;
  loadingMoreId?: string | null;
  loadMoreError?: { blockId: string; message: string } | null;
  onCelebrate?: (celebration: PageCelebration, answer: ActionAnswer) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  bodyClassName?: string;
  bodyPrefix?: ReactNode;
  footerClassName?: string;
  wrapPasskey?: boolean;
}) {
  const [cardsBusy, setCardsBusy] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [soleBlockId, setSoleBlockId] = useState<string | null>(null);
  const refresh = () => void read();
  const blocks = allPageBlocks(page);
  const form = usePageForm(blocks);
  const actions = usePageActions({ blocks, act, onExpired, onRefresh: refresh, onCelebrate, cardsBusy, disabled });

  useEffect(() => {
    onBusyChange?.(!!actions.busy);
  }, [actions.busy, onBusyChange]);
  // An error stays until the player acts again, and editing a field is acting.
  const { dropError } = actions;
  // By content: a page that comes back after an action rebuilds the values object.
  const typedNow = JSON.stringify(form.values);
  const typed = useRef(typedNow);
  useEffect(() => {
    if (typed.current === typedNow) return;
    typed.current = typedNow;
    dropError();
  }, [typedNow, dropError]);

  const contextValue = {
    page, ticket, form, actions, act, refresh, cardAsks, onExpired,
    setCardsBusy, addingCard, setAddingCard, soleBlockId, setSoleBlockId,
    openTarget, loadMore, loadingMoreId, loadMoreError,
  };

  const footerBlocks = page.footer && page.footer.length > 0 && (
    <PageContext.Provider value={{ ...contextValue, noticeAboveButton: true }}>
      <BlockList blocks={page.footer} depth={0} />
    </PageContext.Provider>
  );

  const drawn = (
    <PageContext.Provider value={contextValue}>
      <div className={bodyClassName}>
        {bodyPrefix}
        <BlockList blocks={page.blocks} depth={0} />
      </div>
      {footerBlocks && (
        footerClassName ? <footer className={footerClassName}>{footerBlocks}</footer> : footerBlocks
      )}
    </PageContext.Provider>
  );
  // Binding a passkey is offered once there is something to protect.
  return wrapPasskey && page.offerPasskeySetup ? <SessionPasskeySetup>{drawn}</SessionPasskeySetup> : drawn;
}

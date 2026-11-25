import { useState } from "react";
import type { Page } from "@prism/page-protocol";
import { BlockList } from "./page-blocks/BlockView";
import { PageContext } from "./page-blocks/page-context";
import { usePageActions, type Act } from "./page-blocks/use-page-actions";
import { usePageForm } from "./page-blocks/use-page-form";
import { SessionPasskeySetup } from "./SessionPasskeySetup";

/**
 * Draws the page. Only what the player is in the middle of is kept here; each
 * kind of block is its own component in `page-blocks/`.
 */
export function PlayerPageBlocks({ page, ticket, act, read, cardAsks, onExpired }: {
  page: Page;
  ticket: string;
  act: Act;
  read: () => Promise<void>;
  cardAsks: number;
  onExpired: () => void;
}) {
  const [cardsBusy, setCardsBusy] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [soleBlockId, setSoleBlockId] = useState<string | null>(null);
  const refresh = () => void read();
  const form = usePageForm(page.blocks);
  const actions = usePageActions({ blocks: page.blocks, act, onExpired, onRefresh: refresh, cardsBusy });

  const drawn = (
    <PageContext.Provider value={{
      page, ticket, form, actions, act, refresh, cardAsks, onExpired,
      setCardsBusy, addingCard, setAddingCard, soleBlockId, setSoleBlockId,
    }}>
      <div className="device-controls">
        <BlockList blocks={page.blocks} depth={0} />
      </div>
    </PageContext.Provider>
  );
  // Binding a passkey is offered once there is something to protect.
  return page.offerPasskeySetup ? <SessionPasskeySetup>{drawn}</SessionPasskeySetup> : drawn;
}

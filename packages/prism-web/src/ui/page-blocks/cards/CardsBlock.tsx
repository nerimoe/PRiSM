import { useEffect, useLayoutEffect } from "react";
import { Loader2, Plus } from "lucide-react";
import type { PageCards } from "@prism/page-protocol";
import { useI18n } from "../../../i18n";
import { usePageContext } from "../page-context";
import { CardActions } from "./CardActions";
import { CardCapturePanel } from "./CardCapturePanel";
import { CardList } from "./CardList";
import { useCardCapture } from "./use-card-capture";
import { useCardSwipe } from "./use-card-swipe";
import { usePlayerCards } from "./use-player-cards";

/** The player's cards, swiping one, and adding one at the reader. */
export function CardsBlock({ block }: { block: PageCards }) {
  const { errorText } = useI18n();
  const { ticket, cardAsks, actions, setCardsBusy, setAddingCard, setSoleBlockId } = usePageContext();
  const { cards, loading, loadError, reload } = usePlayerCards();
  const { capture, capturing, start, cancel, dismiss } = useCardCapture({ block, ticket, cardAsks, onAdded: reload });
  const { swiping, feedback, swipe } = useCardSwipe({ block, onRefused: reload });
  const captureUi = block.captureUi;
  const canCapture = block.capture && !!captureUi;
  const failed = !capture && !loading && loadError !== null;

  useEffect(() => { setCardsBusy(!!swiping || capturing); }, [swiping, capturing, setCardsBusy]);
  useEffect(() => { setAddingCard(!!capture); }, [capture, setAddingCard]);
  // Without the cards the page offers nothing but reading them again; set before paint so nothing else flashes by.
  useLayoutEffect(() => { setSoleBlockId(failed ? block.id : null); }, [failed, block.id, setSoleBlockId]);
  useEffect(() => () => {
    setCardsBusy(false);
    setAddingCard(false);
    setSoleBlockId(null);
  }, [setCardsBusy, setAddingCard, setSoleBlockId]);

  const disabled = !block.enabled || !!actions.busy || !!swiping;
  if (failed)
    return (
      <section className="text-center" role="status">
        <h2 className="text-xl font-semibold">{block.loadError.title}</h2>
        <p className="session-subtitle">{errorText(loadError)}</p>
        <CardActions actions={block.loadError.actions} firstMargin="mt-6" onReload={reload} />
      </section>
    );
  return (
    <section>
      <div className="session-task device-card-heading">
        <h2>{capture && captureUi ? captureUi.title : block.title}</h2>
        {!capture && canCapture && (
          <button type="button" className="card-capture-add" aria-label={captureUi.addLabel} disabled={disabled} onClick={start}>
            <Plus size={22} aria-hidden="true" />
          </button>
        )}
      </div>
      {capture && captureUi ? (
        <CardCapturePanel capture={capture} ui={captureUi} onCancel={cancel} onDone={dismiss} />
      ) : (
        <fieldset disabled={disabled}>
          {loading ? (
            <div className="flex justify-center" role="status" aria-label={block.loadingLabel}>
              <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            </div>
          ) : cards.length ? (
            <CardList block={block} cards={cards} swiping={swiping} feedback={feedback} disabled={disabled} onSwipe={(id) => void swipe(id)} />
          ) : (
            <div className="text-center">
              <p className="session-subtitle">{block.empty.text}</p>
              <CardActions actions={block.empty.actions} firstMargin="mt-4" onCapture={canCapture ? start : undefined} onReload={reload} />
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}

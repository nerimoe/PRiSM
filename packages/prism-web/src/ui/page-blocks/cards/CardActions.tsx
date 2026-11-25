import type { PageCardsAction } from "@prism/page-protocol";

/** The buttons the page offers when there is no card to show. `onCapture` is absent where no card can be added. */
export function CardActions({ actions, firstMargin, onCapture, onReload }: {
  actions: PageCardsAction[];
  firstMargin: string;
  onCapture?: () => void;
  onReload: () => void;
}) {
  return <>{actions.map((item, index) => {
    const run = item.action === "cards.capture" ? onCapture : item.action === "cards.reload" ? onReload : undefined;
    // An action this version does not know yet is left out.
    if (!run) return null;
    return (
      <button
        key={item.id}
        type="button"
        className={`session-action${item.style === "primary" ? " primary" : ""} ${index === 0 ? firstMargin : "mt-4"} w-full`}
        onClick={run}
      >
        {item.label}
      </button>
    );
  })}</>;
}

import { ChevronRight, Loader2 } from "lucide-react";
import type { PageCards } from "@prism/page-protocol";
import type { Card } from "../../../api";
import { FeedbackIcon } from "../notices";
import type { SwipeFeedback } from "./use-card-swipe";

export function CardList({ block, cards, swiping, feedback, disabled, onSwipe }: {
  block: PageCards;
  cards: Card[];
  swiping: string | null;
  feedback: SwipeFeedback | null;
  disabled: boolean;
  onSwipe: (cardId: string) => void;
}) {
  return (
    <div className="credential-list">
      {cards.map((card) => {
        const active = swiping === card.id;
        const done = feedback?.cardId === card.id ? feedback : null;
        return (
          <button
            key={card.id}
            className="credential-row"
            disabled={disabled}
            data-active={active}
            data-feedback={done ? done.parts[0]?.level : undefined}
            onClick={() => onSwipe(card.id)}
          >
            <span className="min-w-0">
              <span className="credential-name">{card.label}</span>
              <span className="credential-detail" aria-live={active ? "polite" : "off"}>
                {done
                  ? done.parts.map((part, index) => <span key={index} className="credential-feedback-part" data-level={part.level}>{part.body}</span>)
                  : active ? block.swipingLabel : block.endingTemplate.replace("{digits}", card.accessCode.slice(-4))}
              </span>
            </span>
            {done ? <FeedbackIcon level={done.parts[0]?.level ?? "success"} />
              : active ? <Loader2 size={20} className="animate-spin text-mint" />
              : <ChevronRight size={20} className="text-ink/30" />}
          </button>
        );
      })}
    </div>
  );
}

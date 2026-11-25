import { Loader2 } from "lucide-react";
import type { PageCardsCapture } from "@prism/page-protocol";
import { FeedbackIcon } from "../notices";
import type { CardCapture } from "./use-card-capture";

export function CardCapturePanel({ capture, ui, onCancel, onDone }: {
  capture: NonNullable<CardCapture>;
  ui: PageCardsCapture;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <div className="card-capture" role="status" aria-live="polite">
      {capture.phase === "done" ? (
        <>
          <FeedbackIcon level={capture.level} />
          <p className="session-subtitle">{capture.message}</p>
          <button type="button" className="session-action" onClick={onDone}>{ui.doneLabel}</button>
        </>
      ) : (
        <>
          <Loader2 size={28} className="animate-spin text-mint" aria-hidden="true" />
          <p className="session-subtitle">{capture.phase === "starting" ? ui.startingText : ui.waitingText}</p>
          <button type="button" className="session-action" onClick={onCancel}>{ui.cancelLabel}</button>
        </>
      )}
    </div>
  );
}

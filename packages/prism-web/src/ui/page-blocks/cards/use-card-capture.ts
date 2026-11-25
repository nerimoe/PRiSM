import { useCallback, useEffect, useRef, useState } from "react";
import type { PageCards } from "@prism/page-protocol";
import { Api } from "../../../api";
import { useI18n } from "../../../i18n";
import { operationLocation } from "../../BillingPages";

export type CardCapture =
  | { phase: "starting" | "waiting" }
  | { phase: "done"; level: "success" | "error"; message: string }
  | null;

/** Adding a card at the cabinet's reader: opening a window, waiting for the card and giving up. */
export function useCardCapture({ block, ticket, cardAsks, onAdded }: {
  block: PageCards;
  ticket: string;
  /** Goes up when the platform says the reader has a card. */
  cardAsks: number;
  onAdded: () => void;
}) {
  const { errorText } = useI18n();
  const [capture, setCapture] = useState<CardCapture>(null);
  const captureUi = block.captureUi;
  const captureRun = useRef(0);
  /** The window open on the reader, so giving up can close it: left open, it adds the next card to this player. */
  const openCapture = useRef<string | null>(null);
  const cancelCapture = useCallback(() => {
    captureRun.current += 1;
    const id = openCapture.current;
    openCapture.current = null;
    // If this fails, the window closes by itself within seconds.
    if (id) void Api.cancelCardCapture(id, ticket).catch(() => {});
  }, [ticket]);
  /** While waiting for the reader: asks what became of the card. */
  const askCapture = useRef<(() => void) | null>(null);
  useEffect(() => { askCapture.current?.(); }, [cardAsks]);
  const waitingForCard = capture?.phase === "waiting";
  const leftPageText = captureUi?.leftPageText ?? "";
  useEffect(() => {
    if (!waitingForCard) return;
    const left = () => {
      if (document.visibilityState !== "hidden") return;
      cancelCapture();
      setCapture({ phase: "done", level: "error", message: leftPageText });
    };
    left();
    document.addEventListener("visibilitychange", left);
    return () => document.removeEventListener("visibilitychange", left);
  }, [waitingForCard, cancelCapture, leftPageText]);

  // Leaving the page gives the window up.
  useEffect(() => () => cancelCapture(), [cancelCapture]);

  /**
   * What became of the card, asked when told the reader has one, after a lost connection comes
   * back, and once at the end of the window. Null when a newer attempt or a cancel took over.
   */
  const captureOutcome = (captureId: string, expiresAt: string, current: () => boolean) =>
    new Promise<Awaited<ReturnType<typeof Api.cardCaptureResult>>["status"] | null>((resolve, reject) => {
      let asking = false;
      let again = false;
      let ended = false;
      const finish = (status: Awaited<ReturnType<typeof Api.cardCaptureResult>>["status"] | null) => {
        clearTimeout(timer);
        if (askCapture.current === ask) askCapture.current = null;
        resolve(status);
      };
      const ask = () => {
        if (!current()) return finish(null);
        if (asking) {
          again = true;
          return;
        }
        asking = true;
        Api.cardCaptureResult(captureId, ticket)
          .then(({ status }) => {
            asking = false;
            if (status !== "waiting") finish(status);
            else if (ended) finish("expired");
            else if (again) {
              again = false;
              ask();
            }
          })
          .catch((caught) => {
            asking = false;
            // An earlier ask can fail on a bad network; the next one says the same.
            if (ended) {
              clearTimeout(timer);
              reject(caught);
            } else if (again) {
              again = false;
              ask();
            }
          });
      };
      const timer = setTimeout(() => {
        ended = true;
        ask();
      }, Math.max(0, Date.parse(expiresAt) + 2000 - Date.now()));
      askCapture.current = ask;
      // The card may have been read before this answer got here.
      ask();
    });

  /** Opens a short window and waits for the reader to report the card. A newer attempt or a cancel stops an older one waiting. */
  const startCapture = async () => {
    if (!block.capture || !captureUi) return;
    const run = ++captureRun.current;
    const current = () => captureRun.current === run;
    setCapture({ phase: "starting" });
    try {
      const location = await operationLocation(block.needsLocation);
      const started = await Api.startCardCapture({ ticket, location });
      if (!current()) {
        void Api.cancelCardCapture(started.captureId, ticket).catch(() => {});
        return;
      }
      openCapture.current = started.captureId;
      setCapture({ phase: "waiting" });
      const status = await captureOutcome(started.captureId, started.expiresAt, current);
      if (status === null || !current()) return;
      openCapture.current = null;
      const added = status === "added" || status === "bound" || status === "exists";
      const outcomes = captureUi.outcomes;
      setCapture({
        phase: "done",
        level: added ? "success" : "error",
        message: added ? outcomes.added
          : status === "taken" ? outcomes.taken
          : status === "unsupported" ? outcomes.unsupported
          : outcomes.expired,
      });
      if (added) onAdded();
    } catch (caught) {
      if (current()) {
        openCapture.current = null;
        setCapture({ phase: "done", level: "error", message: errorText(caught instanceof Error ? caught.message : "请检查网络后重试") });
      }
    }
  };

  return {
    capture,
    capturing: capture?.phase === "starting" || capture?.phase === "waiting",
    start: () => void startCapture(),
    cancel: () => { cancelCapture(); setCapture(null); },
    dismiss: () => setCapture(null),
  };
}

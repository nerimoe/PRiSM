import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowRight, Check, Coins, DoorOpen, Info, Loader2, Lock, Plus, Power, RefreshCw, X } from "lucide-react";
import { allPageBlocks, buildButtonPayload, canSubmitButton, type PageButton, type PageButtonIcon } from "@prism/page-protocol";
import { billTime } from "../bill-time";
import { PlayerDialog } from "../PlayerAccount";
import { InlineNoticeLine, NoticeIcon } from "./notices";
import { usePageContext } from "./page-context";

const ICONS: Record<PageButtonIcon, typeof Coins> = {
  coin: Coins,
  power: Power,
  door: DoorOpen,
  plus: Plus,
  refresh: RefreshCw,
  check: Check,
  lock: Lock,
  info: Info,
  warning: AlertTriangle,
  close: X,
  "arrow-right": ArrowRight,
};

export function ButtonBlock({ block }: { block: PageButton }) {
  const { page, form, actions, addingCard, noticeAboveButton } = usePageContext();
  // Asked here, so a button that leaves the page takes its question with it.
  const [confirming, setConfirming] = useState(false);
  const pressRef = useRef<() => void>(() => {});
  const handled = useRef(actions.pressRequest?.n ?? 0);
  useEffect(() => {
    const request = actions.pressRequest;
    if (!request || request.id !== block.id || request.n === handled.current) return;
    handled.current = request.n;
    pressRef.current();
  }, [actions.pressRequest, block.id]);
  if (addingCard && block.hideDuringCapture) return null;

  const Icon = block.icon ? ICONS[block.icon] : null;
  const pressing = actions.busy?.id === block.id || actions.waitingId === block.id;
  const note = actions.noteFor(block.id);
  const onButton = block.answerOnButton ? note : null;
  const { code } = actions;
  const label = block.enabled && onButton ? onButton.body : code && block.againLabel ? block.againLabel : block.label;
  const style = block.style ? ` ${block.style}` : "";
  const blocks = allPageBlocks(page);
  const ready = canSubmitButton(block, blocks, form.values);
  const submit = () =>
    void actions.run(block.id, block.action, buildButtonPayload(block, blocks, form.values), block.needsLocation, block.wait);
  const pressButton = () => (block.confirm ? setConfirming(true) : submit());
  pressRef.current = pressButton;

  return (
    <div className="grid gap-3">
      {code && block.againLabel && (
        <div className="door-password">
          <h2>{code.title}</h2>
          <output className="select-all">{code.value}</output>
          <small>{code.expiresLabel} {billTime(code.expiresAt).time}</small>
          <p>{code.hint}</p>
        </div>
      )}
      {!block.answerOnButton && noticeAboveButton && note && <InlineNoticeLine note={note} />}
      <button
        className={`session-action${style}`}
        data-level={onButton?.level}
        disabled={actions.blocked || pressing || !ready || !!onButton}
        aria-live={block.answerOnButton ? "polite" : undefined}
        onClick={pressButton}
      >
        {pressing ? <Loader2 size={22} className="animate-spin" />
          : onButton ? <NoticeIcon level={onButton.level} size={22} />
          : Icon ? <Icon size={22} /> : null}{" "}
        {label}
      </button>
      {!block.answerOnButton && !noticeAboveButton && note && <InlineNoticeLine note={note} />}
      {/* Outside the page's grid, whose heading styles would reach into the dialog. */}
      {confirming && block.confirm && createPortal(
        <PlayerDialog title={block.confirm.title} dismissDisabled={!!actions.busy} onClose={() => setConfirming(false)}>
          <div className="page-confirm">
            <p>{block.confirm.body}</p>
            <div className="page-confirm-actions">
              <button type="button" className="session-action" disabled={!!actions.busy} onClick={() => setConfirming(false)}>
                {block.confirm.cancelLabel}
              </button>
              <button
                type="button"
                className={`session-action ${block.confirm.destructive ? "destructive solid" : "primary"}`}
                disabled={actions.blocked || !ready}
                onClick={() => { setConfirming(false); submit(); }}
              >
                {block.confirm.confirmLabel}
              </button>
            </div>
          </div>
        </PlayerDialog>,
        document.body,
      )}
    </div>
  );
}

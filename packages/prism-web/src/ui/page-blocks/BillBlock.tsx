import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PageBill } from "@prism/page-protocol";
import { previewFromBillingInputs } from "../../browser-billing";
import { BillTimeline, BillTotal, type BillPreview } from "../BillTimeline";
import { displayDateTime } from "../bill-time";
import { usePageContext } from "./page-context";

export function BillBlock({ block }: { block: PageBill }) {
  const { refresh } = usePageContext();
  const [computed, setComputed] = useState<BillPreview | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (block.mode === "settled" || !block.billingInputs) {
      setComputed(null);
      setError(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setError(false);
    previewFromBillingInputs(block.billingInputs, controller.signal)
      .then((result) => {
        if (!cancelled) setComputed(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [block.mode, block.billingInputs]);

  if (block.mode === "settled") {
    const settled = (block.preview as BillPreview | undefined) ?? null;
    return (
      <div className="grid gap-5">
        <div className="receipt-status">
          <span aria-hidden="true">✓</span>
          <div>
            <h2>{block.labels.settledTitle}</h2>
            {block.settledAt && <p>{displayDateTime(block.settledAt, block.timeZone)}</p>}
          </div>
        </div>
        {settled && <BillTotal preview={settled} labels={block.labels} />}
        {block.balanceAfter != null && (
          <div className="receipt-balance">
            <span>{block.labels.balanceAfterLabel}</span>
            <strong>{block.balanceAfter.toFixed(2)}</strong>
          </div>
        )}
        {settled && <BillTimeline preview={settled} timeZone={block.timeZone} labels={block.labels} />}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="text-coral">
        {block.labels.estimateError}
        {/* The inputs may be what is broken: read the page again for fresh ones. */}
        <button type="button" className="ml-3 underline" onClick={refresh}>
          {block.labels.retryLabel}
        </button>
      </div>
    );
  }

  const live = block.billingInputs ? computed : ((block.preview as BillPreview | undefined) ?? null);
  if (!live) {
    return <Loader2 className="mx-auto animate-spin" size={24} />;
  }

  return (
    <div className="grid gap-5">
      <BillTotal preview={live} labels={block.labels} />
      <BillTimeline preview={live} timeZone={block.timeZone} labels={block.labels} />
    </div>
  );
}

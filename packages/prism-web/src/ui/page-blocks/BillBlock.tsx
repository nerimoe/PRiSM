import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PageBill } from "@prism/page-protocol";
import { previewFromBillingInputs } from "../../browser-billing";
import { BillTimeline, BillTotal, type BillPreview } from "../BillTimeline";
import { displayDateTime } from "../bill-time";

export function BillBlock({ block }: { block: PageBill }) {
  const [computed, setComputed] = useState<BillPreview | null>(() =>
    block.mode === "settled" || !block.billingInputs ? ((block.preview as BillPreview | undefined) ?? null) : null,
  );
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (block.mode === "settled" || !block.billingInputs) {
      setComputed((block.preview as BillPreview | undefined) ?? null);
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
  }, [block.mode, block.billingInputs, block.preview, attempt]);

  if (block.mode === "settled") {
    const settled = computed;
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
        <button type="button" className="ml-3 underline" onClick={() => setAttempt((v) => v + 1)}>
          {block.labels.retryLabel}
        </button>
      </div>
    );
  }

  if (!computed) {
    return <Loader2 className="mx-auto animate-spin" size={24} />;
  }

  return (
    <div className="grid gap-5">
      <BillTotal preview={computed} labels={block.labels} />
      <BillTimeline preview={computed} timeZone={block.timeZone} labels={block.labels} />
    </div>
  );
}

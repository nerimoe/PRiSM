import { useCallback, useEffect, useMemo, useState } from "react";
import { reconcileFieldValues, type PageBlock, type PageFieldValue } from "@prism/page-protocol";

/** What the player has typed, picked or ticked, keyed by block id. */
export function usePageForm(blocks: PageBlock[]) {
  const [edits, setEdits] = useState<Record<string, PageFieldValue>>({});
  const values = useMemo(() => reconcileFieldValues(blocks, edits), [blocks, edits]);
  // Prune field values once a field leaves the page so coming back starts fresh.
  useEffect(() => {
    setEdits((current) => {
      const next = reconcileFieldValues(blocks, current);
      const keys = Object.keys(current);
      return keys.length === Object.keys(next).length && keys.every((key) => current[key] === next[key]) ? current : next;
    });
  }, [blocks]);
  const setValue = useCallback(
    (id: string, value: PageFieldValue) => setEdits((current) => ({ ...reconcileFieldValues(blocks, current), [id]: value })),
    [blocks],
  );
  return { values, setValue };
}

export type PageForm = ReturnType<typeof usePageForm>;

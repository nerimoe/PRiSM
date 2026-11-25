import { useCallback, useEffect, useState } from "react";
import { Api, ApiError, type Card } from "../../../api";

/** The player's cards. They are not part of the page: they are read here. */
export function usePlayerCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoading(true);
    Api.cards()
      .then((result) => { if (!cancelled) setCards(result.cards.filter((card) => !card.disabledAt)); })
      .catch((caught) => { if (!cancelled) setLoadError(caught instanceof ApiError ? caught.message : "请检查网络后重试"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { cards, loading, loadError, reload };
}

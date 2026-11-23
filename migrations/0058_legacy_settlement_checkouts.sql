-- Imports made after 0013 could still create item settlements without checkouts.
-- Reconstruct one bill per legacy settlement; do not rewrite existing bills.
INSERT INTO player_checkouts (shop_id, id, player_id, subtotal, total, status, settled_at)
SELECT st.shop_id, 'legacy:checkout:' || st.id, s.player_id,
       st.subtotal, MAX(0, st.total), 'settled', st.settled_at
FROM settlements st
JOIN sessions s ON s.shop_id = st.shop_id AND s.id = st.session_id
WHERE st.checkout_id IS NULL AND st.status = 'settled'
ON CONFLICT(shop_id, id) DO NOTHING;

UPDATE settlements
SET checkout_id = 'legacy:checkout:' || id
WHERE checkout_id IS NULL AND status = 'settled'
  AND EXISTS (
    SELECT 1 FROM player_checkouts c
    JOIN sessions s ON s.shop_id = c.shop_id AND s.player_id = c.player_id
    WHERE c.shop_id = settlements.shop_id
      AND c.id = 'legacy:checkout:' || settlements.id
      AND s.id = settlements.session_id
      AND c.settled_at = settlements.settled_at
  );

-- Existing machine IDs and QR links become the logical device identity.
ALTER TABLE machines ADD COLUMN kind TEXT NOT NULL DEFAULT 'machine' CHECK (kind IN ('machine','door'));
ALTER TABLE machines ADD COLUMN ha_binding_encrypted TEXT;
ALTER TABLE machines ADD COLUMN ttlock_lock_id INTEGER;
ALTER TABLE machines ADD COLUMN coin_key INTEGER NOT NULL DEFAULT 32;
ALTER TABLE machines ADD COLUMN coin_after_swipe INTEGER NOT NULL DEFAULT 0 CHECK (coin_after_swipe IN (0,1));
ALTER TABLE player_operations ADD COLUMN device_id TEXT REFERENCES machines(id);
CREATE INDEX player_operations_device ON player_operations(shop_id,device_id,created_at);

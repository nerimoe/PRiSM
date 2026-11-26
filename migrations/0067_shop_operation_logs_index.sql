-- Speed up shop-wide operation history queries across all resources and non-resource shop events.
CREATE INDEX IF NOT EXISTS device_events_shop_occurred ON device_events(shop_id, occurred_at, id);

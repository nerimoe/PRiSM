-- Device-free check-in turned out to be the wrong shape: entry should prove physical
-- presence, and only a machine ticket does that. The shop link is a read-and-settle
-- surface instead, so drop the opt-in that briefly supported it. Column added by 0023 in
-- the same unreleased change, which this removes without touching the shipped history.
ALTER TABLE shop_billing_settings DROP COLUMN remote_entry_enabled;

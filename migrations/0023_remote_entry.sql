-- Device-free check-in: a shop may allow players to start an entry session from the
-- standalone shop page (for example the PRiSM Link App Clip deep link) instead of
-- scanning a machine QR code. Off by default so existing shops keep requiring a ticket.
ALTER TABLE shop_billing_settings ADD COLUMN remote_entry_enabled INTEGER NOT NULL DEFAULT 0 CHECK(remote_entry_enabled IN (0,1));

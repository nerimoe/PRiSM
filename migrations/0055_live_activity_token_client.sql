-- Which install shows each Live Activity (the app's `x-prism-client-id`). The phone that
-- entered a visit starts its own activity and is not pushed one at once; when it shows none
-- for the visit after a grace period, it is pushed a start like every other phone.
ALTER TABLE live_activity_tokens ADD COLUMN client_id TEXT;

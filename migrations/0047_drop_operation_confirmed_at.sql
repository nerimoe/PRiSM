-- An operation no longer records when the device confirmed it. What a request
-- asked for and what the device then did are kept apart: the request has its
-- own outcome (the call to the hardware), and what really happened is an event
-- of its own. Nothing linked them except this column, which only a card swipe
-- ever filled in and nothing read.
ALTER TABLE device_operations DROP COLUMN confirmed_at;

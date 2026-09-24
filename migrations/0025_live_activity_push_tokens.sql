-- Remote Live Activity delivery: the iOS app (or App Clip) starts a store visit Live
-- Activity with `pushType: .token` and reports the resulting per-activity APNs token
-- here, so a store session started or settled on ANY channel (player app, admin
-- console, shop bot) can update that phone's Dynamic Island without the app running.
--
-- Rows are keyed per activity rather than per device: a player may hold several
-- activities (app and App Clip are separate targets), and an activity id is what APNs
-- addresses. `session_id` is the store session the activity currently shows and is
-- cleared on settlement, so a stale row can never push an `end` for a later visit.
-- `attributes_json` keeps the ActivityAttributes the activity was created with.
CREATE TABLE live_activity_tokens (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  activity_id TEXT NOT NULL,
  token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  bundle_id TEXT NOT NULL,
  session_id TEXT,
  attributes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, user_id, activity_id)
);

CREATE INDEX idx_live_activity_tokens_session ON live_activity_tokens(shop_id, session_id);

CREATE INDEX idx_live_activity_tokens_user ON live_activity_tokens(shop_id, user_id);

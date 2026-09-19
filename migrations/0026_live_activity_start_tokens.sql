-- Push-to-start token registrations for ActivityKit:
-- A player registers their device/installation-level push-to-start token once they
-- log in on a supported iOS client (full app or App Clip). When a store session is
-- created from ANY channel (staff console, shop bot, integration) while the app is
-- not running, PRiSM pushes an APNs event=start to all active start tokens for that
-- user so the Dynamic Island / Live Activity appears automatically.
--
-- Keyed per (user_id, client_id) so a single user can have multiple devices and
-- both the full app and App Clip on the same phone without collision.
CREATE TABLE live_activity_start_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox', 'production')),
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(user_id, client_id)
);

CREATE INDEX idx_live_activity_start_tokens_user ON live_activity_start_tokens(user_id);
CREATE INDEX idx_live_activity_start_tokens_token ON live_activity_start_tokens(token);

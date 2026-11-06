-- How scanned pages fared on players' own networks: one row per visit, updated as
-- the visit goes on. Which network it was is kept, whose phone it was is not.
CREATE TABLE page_reports (
  id TEXT PRIMARY KEY,
  reported_at TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  client TEXT NOT NULL,
  asn INTEGER,
  as_organization TEXT,
  country TEXT,
  colo TEXT,
  open_ms INTEGER,
  open_failed INTEGER NOT NULL DEFAULT 0,
  document_ms INTEGER,
  document_connect_ms INTEGER,
  api_connect_ms INTEGER,
  reads INTEGER NOT NULL DEFAULT 0,
  read_failures INTEGER NOT NULL DEFAULT 0,
  read_ms INTEGER NOT NULL DEFAULT 0,
  read_max_ms INTEGER NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0,
  action_failures INTEGER NOT NULL DEFAULT 0,
  action_ms INTEGER NOT NULL DEFAULT 0,
  action_max_ms INTEGER NOT NULL DEFAULT 0,
  socket_connect_ms INTEGER,
  socket_drops INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_page_reports_reported_at ON page_reports(reported_at);

/**
 * Every change to a shop's price list (its plans and which plan each resource
 * group, resource and table uses), past and scheduled. Shared by fresh SQLite
 * databases and migration 0064. See docs/pricing-changes.md.
 *
 * An applied change points at the pricing release it produced (plans live in
 * the immutable versions) and keeps the bindings, which are not versioned. A
 * pending change keeps its whole target price list until it applies.
 */
export const pricingChangeSchema = [
  `CREATE TABLE IF NOT EXISTS pricing_changes (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','cancelled','failed')),
  source TEXT NOT NULL CHECK (source IN ('edit','schedule','restore','import','history')),
  effective_at TEXT,
  applied_at TEXT,
  release_id TEXT,
  bindings_json TEXT,
  target_json TEXT,
  restored_from TEXT,
  notes_json TEXT,
  note TEXT,
  error_code TEXT,
  actor_id TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_changes_pending_at ON pricing_changes(shop_id, effective_at) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_pricing_changes_due ON pricing_changes(status, effective_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pricing_changes_timeline ON pricing_changes(shop_id, applied_at)`,
  // History before this table existed: one entry per release, without bindings
  // or who made it. Only for shops that have no entries yet.
  `INSERT OR IGNORE INTO pricing_changes(shop_id,id,status,source,applied_at,release_id,created_at,updated_at)
 SELECT r.shop_id, 'history-' || r.id, 'applied', 'history', r.created_at, r.id, r.created_at, r.created_at
 FROM pricing_releases r
 WHERE NOT EXISTS (SELECT 1 FROM pricing_changes c WHERE c.shop_id = r.shop_id AND c.source <> 'history')`,
] as const;

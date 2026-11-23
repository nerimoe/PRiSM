-- Rename the underlying `mahjong` capability and `mahjong_seats` table to `table` and `table_seats`.

DROP TRIGGER IF EXISTS shop_export_mahjong_seats_insert;
DROP TRIGGER IF EXISTS shop_export_mahjong_seats_update;
DROP TRIGGER IF EXISTS shop_export_mahjong_seats_delete;
DROP TRIGGER IF EXISTS shop_import_target_mahjong_seats_insert;
DROP TRIGGER IF EXISTS shop_import_target_mahjong_seats_update;
DROP TRIGGER IF EXISTS shop_import_target_mahjong_seats_delete;
DROP INDEX IF EXISTS mahjong_seats_device;

ALTER TABLE mahjong_seats RENAME TO table_seats;
CREATE INDEX IF NOT EXISTS table_seats_device ON table_seats(machine_id);

CREATE TRIGGER IF NOT EXISTS shop_export_table_seats_insert BEFORE INSERT ON table_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS shop_export_table_seats_update BEFORE UPDATE ON table_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS shop_export_table_seats_delete BEFORE DELETE ON table_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_import_target_table_seats_insert
AFTER INSERT ON table_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_table_seats_update
AFTER UPDATE ON table_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_table_seats_delete
AFTER DELETE ON table_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;

UPDATE device_capabilities SET capability = 'table' WHERE capability = 'mahjong';
UPDATE resource_occupancies SET source = 'table' WHERE source = 'mahjong';
UPDATE device_operations SET capability = 'table' WHERE capability = 'mahjong';
UPDATE device_operations SET action = 'table.' || substr(action, 9) WHERE action LIKE 'mahjong.%';
UPDATE device_events SET capability = 'table' WHERE capability = 'mahjong';
UPDATE device_events SET name = 'table.' || substr(name, 9) WHERE name LIKE 'mahjong.%';
UPDATE device_state SET capability = 'table' WHERE capability = 'mahjong';
UPDATE sessions
SET metadata_json = json_remove(
  json_set(metadata_json, '$.tableDeviceId', json_extract(metadata_json, '$.mahjongDeviceId')),
  '$.mahjongDeviceId'
)
WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.mahjongDeviceId') IS NOT NULL;

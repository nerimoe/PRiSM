DROP TRIGGER IF EXISTS pricing_config_version_insert;

DROP TRIGGER IF EXISTS pricing_config_version_update;

DROP TRIGGER IF EXISTS pricing_config_version_delete;

DROP TRIGGER IF EXISTS pricing_timezone_insert;

DROP TRIGGER IF EXISTS pricing_timezone_update;

CREATE TRIGGER pricing_config_version_insert AFTER INSERT ON pricing_configs
 BEGIN INSERT INTO pricing_config_versions(shop_id,version_id,config_id,version,kind, name, enabled, status, provider_json, created_at, updated_at)
 SELECT NEW.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),NEW.id,
 COALESCE((SELECT MAX(version) FROM pricing_config_versions WHERE shop_id=NEW.shop_id AND config_id=NEW.id),0)+1,
 NEW.kind, NEW.name, NEW.enabled, NEW.status, NEW.provider_json, NEW.created_at, NEW.updated_at;
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
 SELECT v.version_id FROM pricing_config_versions v JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
 WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
 ORDER BY v.config_id)), 'UTC', strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER pricing_config_version_update AFTER UPDATE ON pricing_configs
 WHEN OLD.kind IS NOT NEW.kind OR OLD.name IS NOT NEW.name OR OLD.enabled IS NOT NEW.enabled
 OR OLD.status IS NOT NEW.status OR OLD.provider_json IS NOT NEW.provider_json
 BEGIN INSERT INTO pricing_config_versions(shop_id,version_id,config_id,version,kind, name, enabled, status, provider_json, created_at, updated_at)
 SELECT NEW.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),NEW.id,
 COALESCE((SELECT MAX(version) FROM pricing_config_versions WHERE shop_id=NEW.shop_id AND config_id=NEW.id),0)+1,
 NEW.kind, NEW.name, NEW.enabled, NEW.status, NEW.provider_json, NEW.created_at, NEW.updated_at;
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
 SELECT v.version_id FROM pricing_config_versions v JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
 WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
 ORDER BY v.config_id)), 'UTC', strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER pricing_config_version_delete AFTER DELETE ON pricing_configs
 BEGIN
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT OLD.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
 SELECT v.version_id FROM pricing_config_versions v JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
 WHERE v.shop_id=OLD.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
 ORDER BY v.config_id)), 'UTC', strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TABLE IF NOT EXISTS prism_data_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

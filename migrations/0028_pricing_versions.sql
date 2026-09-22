CREATE TABLE IF NOT EXISTS pricing_config_versions (
 shop_id TEXT NOT NULL, version_id TEXT NOT NULL, config_id TEXT NOT NULL, version INTEGER NOT NULL,
 kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, status TEXT NOT NULL,
 provider_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,version_id), UNIQUE(shop_id,config_id,version));

CREATE TABLE IF NOT EXISTS pricing_releases (
 shop_id TEXT NOT NULL, id TEXT NOT NULL, version_ids_json TEXT NOT NULL, time_zone TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(shop_id,id));

CREATE TABLE IF NOT EXISTS pricing_release_heads (
 shop_id TEXT PRIMARY KEY, release_id TEXT NOT NULL,
 FOREIGN KEY(shop_id,release_id) REFERENCES pricing_releases(shop_id,id));

CREATE TABLE IF NOT EXISTS session_pricing_releases (
 shop_id TEXT NOT NULL, session_id TEXT NOT NULL, release_id TEXT NOT NULL,
 PRIMARY KEY(shop_id,session_id),
 FOREIGN KEY(shop_id,session_id) REFERENCES sessions(shop_id,id),
 FOREIGN KEY(shop_id,release_id) REFERENCES pricing_releases(shop_id,id));

INSERT INTO pricing_config_versions(shop_id,version_id,config_id,version,kind, name, enabled, status, provider_json, created_at, updated_at)
 SELECT c.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),c.id,1,c.kind, c.name, c.enabled, c.status, c.provider_json, c.created_at, c.updated_at
 FROM pricing_configs c WHERE NOT EXISTS(SELECT 1 FROM pricing_config_versions v WHERE v.shop_id=c.shop_id AND v.config_id=c.id);

INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT s.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM pricing_config_versions v WHERE v.shop_id=s.shop_id),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=s.shop_id AND key='venue.operations'),
 (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=s.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM (SELECT shop_id FROM pricing_configs UNION SELECT shop_id FROM sessions) s
 WHERE NOT EXISTS(SELECT 1 FROM pricing_release_heads h WHERE h.shop_id=s.shop_id);

INSERT OR IGNORE INTO pricing_release_heads SELECT shop_id,id FROM pricing_releases;

INSERT OR IGNORE INTO session_pricing_releases
 SELECT s.shop_id,s.id,h.release_id FROM sessions s JOIN pricing_release_heads h ON h.shop_id=s.shop_id
 WHERE s.payment_status='unpaid';

CREATE TRIGGER IF NOT EXISTS pricing_config_version_insert AFTER INSERT ON pricing_configs
 BEGIN INSERT INTO pricing_config_versions(shop_id, version_id, config_id, version, kind, name, enabled, status, provider_json, created_at, updated_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))), NEW.id,
 COALESCE((SELECT MAX(version) FROM pricing_config_versions WHERE shop_id=NEW.shop_id AND config_id=NEW.id),0)+1,
 NEW.kind, NEW.name, NEW.enabled, NEW.status, NEW.provider_json, NEW.created_at, NEW.updated_at; 
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
   SELECT v.version_id FROM pricing_config_versions v
   JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
   WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
   ORDER BY v.config_id)),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='venue.operations'),
          (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER IF NOT EXISTS pricing_config_version_update AFTER UPDATE ON pricing_configs
 WHEN OLD.kind IS NOT NEW.kind OR OLD.name IS NOT NEW.name OR OLD.enabled IS NOT NEW.enabled
 OR OLD.status IS NOT NEW.status OR OLD.provider_json IS NOT NEW.provider_json
 BEGIN INSERT INTO pricing_config_versions(shop_id, version_id, config_id, version, kind, name, enabled, status, provider_json, created_at, updated_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))), NEW.id,
 COALESCE((SELECT MAX(version) FROM pricing_config_versions WHERE shop_id=NEW.shop_id AND config_id=NEW.id),0)+1,
 NEW.kind, NEW.name, NEW.enabled, NEW.status, NEW.provider_json, NEW.created_at, NEW.updated_at; 
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
   SELECT v.version_id FROM pricing_config_versions v
   JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
   WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
   ORDER BY v.config_id)),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='venue.operations'),
          (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER IF NOT EXISTS pricing_config_version_delete AFTER DELETE ON pricing_configs
 BEGIN 
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT OLD.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
   SELECT v.version_id FROM pricing_config_versions v
   JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
   WHERE v.shop_id=OLD.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
   ORDER BY v.config_id)),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=OLD.shop_id AND key='venue.operations'),
          (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=OLD.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER IF NOT EXISTS pricing_timezone_insert
 AFTER INSERT ON app_settings WHEN NEW.key IN ('store.profile','venue.operations')
 AND json_extract(NEW.value_json,'$.timeZone') IS NOT NULL
 BEGIN 
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
   SELECT v.version_id FROM pricing_config_versions v
   JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
   WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
   ORDER BY v.config_id)),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='venue.operations'),
          (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER IF NOT EXISTS pricing_timezone_update
 AFTER UPDATE ON app_settings WHEN NEW.key IN ('store.profile','venue.operations')
 AND json_extract(OLD.value_json,'$.timeZone') IS NOT json_extract(NEW.value_json,'$.timeZone')
 BEGIN 
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
 (SELECT json_group_array(version_id) FROM (
   SELECT v.version_id FROM pricing_config_versions v
   JOIN pricing_configs c ON c.shop_id=v.shop_id AND c.id=v.config_id
   WHERE v.shop_id=NEW.shop_id AND v.version=(SELECT MAX(x.version) FROM pricing_config_versions x WHERE x.shop_id=v.shop_id AND x.config_id=v.config_id)
   ORDER BY v.config_id)),
 COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='venue.operations'),
          (SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=NEW.shop_id AND key='store.profile'),'UTC'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
 INSERT INTO pricing_release_heads(shop_id,release_id)
 SELECT shop_id,id FROM pricing_releases WHERE rowid=last_insert_rowid()
 ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id; END;

CREATE TRIGGER IF NOT EXISTS session_pricing_bind AFTER INSERT ON sessions
 WHEN NEW.payment_status='unpaid'
 BEGIN
 INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at)
 SELECT NEW.shop_id,(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()%4)+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),'[]','UTC',NEW.started_at
 WHERE NOT EXISTS(SELECT 1 FROM pricing_release_heads WHERE shop_id=NEW.shop_id);
 INSERT OR IGNORE INTO pricing_release_heads SELECT shop_id,id FROM pricing_releases WHERE shop_id=NEW.shop_id;
 INSERT INTO session_pricing_releases(shop_id,session_id,release_id)
 SELECT NEW.shop_id,NEW.id,COALESCE(
 (SELECT b.release_id FROM sessions s JOIN session_pricing_releases b ON b.shop_id=s.shop_id AND b.session_id=s.id
 WHERE s.shop_id=NEW.shop_id AND s.player_id=NEW.player_id AND s.payment_status='unpaid'
 ORDER BY s.started_at,s.id LIMIT 1),
 (SELECT release_id FROM pricing_release_heads WHERE shop_id=NEW.shop_id));
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pricing_configs WHERE shop_id=NEW.shop_id)
 AND EXISTS(SELECT 1 FROM json_each(NEW.pricing_config_ids_json) selected
 WHERE selected.value != 'default' AND NOT EXISTS(
 SELECT 1 FROM session_pricing_releases b JOIN pricing_releases r ON r.shop_id=b.shop_id AND r.id=b.release_id
 JOIN pricing_config_versions v ON v.shop_id=r.shop_id AND v.version_id IN (SELECT value FROM json_each(r.version_ids_json))
 WHERE b.shop_id=NEW.shop_id AND b.session_id=NEW.id AND v.config_id=selected.value
 AND v.enabled=1 AND v.status='active' AND v.kind!='time.cap'))
 THEN RAISE(ABORT,'PRICING_CONFIG_NOT_IN_RELEASE') END;
 END;

CREATE TRIGGER IF NOT EXISTS pricing_config_versions_immutable_update
 BEFORE UPDATE ON pricing_config_versions BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS pricing_config_versions_immutable_delete
 BEFORE DELETE ON pricing_config_versions BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS pricing_releases_immutable_update
 BEFORE UPDATE ON pricing_releases BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS pricing_releases_immutable_delete
 BEFORE DELETE ON pricing_releases BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS session_pricing_releases_immutable_update
 BEFORE UPDATE ON session_pricing_releases BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS session_pricing_releases_immutable_delete
 BEFORE DELETE ON session_pricing_releases BEGIN SELECT RAISE(ABORT,'Pricing versions and bindings are immutable'); END;

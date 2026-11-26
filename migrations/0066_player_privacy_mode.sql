ALTER TABLE players ADD COLUMN privacy_mode INTEGER NOT NULL DEFAULT 0 CHECK (privacy_mode IN (0, 1));

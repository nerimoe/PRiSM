ALTER TABLE players ADD COLUMN report_excluded INTEGER NOT NULL DEFAULT 0 CHECK (report_excluded IN (0, 1));

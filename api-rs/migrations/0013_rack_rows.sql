-- Racks in rows: an optional row label (A, B, …) and a position in the row,
-- so a room's racks can be drawn side by side in the order they stand.
-- Racks without a row are shown after the rows, by code.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; sqlx records which migrations
-- have run, so these ALTERs run exactly once per database.

ALTER TABLE racks ADD COLUMN row_label TEXT
    CHECK (row_label IS NULL OR (length(row_label) BETWEEN 1 AND 16));
ALTER TABLE racks ADD COLUMN row_position INTEGER
    CHECK (row_position IS NULL OR row_position BETWEEN 1 AND 999);

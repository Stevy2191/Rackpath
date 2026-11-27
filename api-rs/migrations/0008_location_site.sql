-- Rackpath v2: an optional site on each location, to group a campus's
-- buildings (each location is one building). Only for grouping and display:
-- paths, permissions and moves don't use it.
-- (SQLite has no ADD COLUMN IF NOT EXISTS; sqlx records applied migrations,
-- so this runs once per database.)
ALTER TABLE locations ADD COLUMN site TEXT CHECK (site IS NULL OR length(site) BETWEEN 1 AND 100);

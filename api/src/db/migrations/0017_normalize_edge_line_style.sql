-- Consolidate the old "animate" toggle and the "default"/"dotted" line
-- styles into the three-option line_style control (solid, dashed,
-- animated) used by the link properties panel.
UPDATE topology_edges SET line_style = 'animated' WHERE animate = TRUE AND line_style NOT IN ('dashed', 'animated');
UPDATE topology_edges SET line_style = 'dashed' WHERE line_style = 'dotted';
UPDATE topology_edges SET line_style = 'solid' WHERE line_style = 'default';
ALTER TABLE topology_edges MODIFY COLUMN line_style VARCHAR(20) NOT NULL DEFAULT 'solid';

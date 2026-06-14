-- Rack Builder: "Add Custom Device" items are rack_slots rows with
-- item_type = 'custom-device' and device_id = NULL. item_label holds the
-- custom name; these two new columns hold the device-type label shown in the
-- picker and the swatch color used to render the item with a dashed border.
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS custom_type VARCHAR(50) NULL AFTER item_label;
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS color VARCHAR(20) NULL AFTER custom_type;

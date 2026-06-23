-- UPS runtime capacity tracking. Stores per-device classification (ups/ebm),
-- UPS power specs and runtime values, and EBM extension data. Separate from
-- the outlet management system (capacity_va, outlet_groups, etc.).

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS device_type        VARCHAR(20)  DEFAULT NULL AFTER capacity_w,
  ADD COLUMN IF NOT EXISTS ups_va_rating      INT          DEFAULT NULL AFTER device_type,
  ADD COLUMN IF NOT EXISTS ups_watt_rating    INT          DEFAULT NULL AFTER ups_va_rating,
  ADD COLUMN IF NOT EXISTS ups_runtime_full   INT          DEFAULT NULL AFTER ups_watt_rating,
  ADD COLUMN IF NOT EXISTS ups_runtime_half   INT          DEFAULT NULL AFTER ups_runtime_full,
  ADD COLUMN IF NOT EXISTS ups_max_ebm_slots  INT          DEFAULT NULL AFTER ups_runtime_half,
  ADD COLUMN IF NOT EXISTS ebm_connected_ups_id INT        DEFAULT NULL AFTER ups_max_ebm_slots,
  ADD COLUMN IF NOT EXISTS ebm_runtime_full   INT          DEFAULT NULL AFTER ebm_connected_ups_id,
  ADD COLUMN IF NOT EXISTS ebm_runtime_half   INT          DEFAULT NULL AFTER ebm_runtime_full;

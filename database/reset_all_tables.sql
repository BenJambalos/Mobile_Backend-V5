-- =====================================================================
-- reset_all_tables.sql  -  DELETES EVERYTHING in the HyQual tables.
--
-- Use it only to start over (for example a half-loaded seed on a test
-- database). It drops the HyQual tables, not the database itself, so it
-- works on Railway where the database is called "railway".
--
-- Afterwards run schema.sql again (and seed_data.sql if you want demo data).
-- NEVER run this on a database that holds real farm data.
-- =====================================================================
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS
  activity_logs,
  device_maintenance,
  device_status,
  early_warning_notifications,
  parameter_thresholds,
  password_resets,
  water_quality_forecasts,
  water_quality_readings,
  monitoring_devices,
  ponds,
  aquaculture_farms,
  user_profiles,
  accounts;
SET FOREIGN_KEY_CHECKS = 1;

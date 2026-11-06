-- =====================================================================
-- 005_notification_measured_value.sql
--
-- ADDITIVE ONLY and safe to run twice. Adds ONE nullable column so a
-- parameter alert can carry the number that triggered it (e.g. 4.4 for a
-- dissolved-oxygen alert) as data, instead of only inside the message text.
-- The mobile Notifications screen shows it as "Measured value".
--
--   early_warning_notifications.measured_value  DECIMAL(10,3) NULL
--
-- Nothing is dropped, renamed or rewritten. Existing alerts keep NULL and
-- still display from their message text. The backend feature-detects this
-- column, so it keeps working whether or not the migration has run yet.
--
--     node scripts/run_sql.js database/migrations/005_notification_measured_value.sql
-- =====================================================================

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'measured_value') = 0,
  'ALTER TABLE early_warning_notifications ADD COLUMN measured_value DECIMAL(10,3) NULL DEFAULT NULL',
  'SELECT ''notifications: measured_value already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'notifications.measured_value' AS object_name, COUNT(*) AS present
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications' AND column_name = 'measured_value';
-- present must be 1.

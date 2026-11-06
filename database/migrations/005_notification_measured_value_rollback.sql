-- Undo migration 005. Removes only the measured_value column (the numbers it
-- held are lost; the alert message text still contains them).
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'measured_value') > 0,
  'ALTER TABLE early_warning_notifications DROP COLUMN measured_value',
  'SELECT ''notifications: measured_value already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SELECT 'rollback of 005 finished' AS info;

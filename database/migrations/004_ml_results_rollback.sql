-- =====================================================================
-- 004_ml_results_rollback.sql  -  undo migration 004
--
-- WARNING: this DELETES every saved ML risk result and ML job-run log and
-- removes the two notification columns. It does NOT touch
-- water_quality_readings or water_quality_forecasts rows (only the extra
-- indexes on forecasts are removed). Notifications that the ML service
-- created stay in the table; they simply lose their `source` marker.
--
-- Before running: STOP the ML service (or set SCHEDULER_ENABLED=false and
-- redeploy) so it does not recreate rows mid-rollback.
--
--     node scripts/run_sql.js database/migrations/004_ml_results_rollback.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1. notifications: foreign key, index, columns (FK first: it needs the index)
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND constraint_name = 'fk_early_warnings_risk_result') > 0,
  'ALTER TABLE early_warning_notifications DROP FOREIGN KEY fk_early_warnings_risk_result',
  'SELECT ''notifications: foreign key already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND index_name = 'idx_notifications_pond_source_open') > 0,
  'ALTER TABLE early_warning_notifications DROP INDEX idx_notifications_pond_source_open',
  'SELECT ''notifications: lookup index already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'risk_result_id') > 0,
  'ALTER TABLE early_warning_notifications DROP COLUMN risk_result_id',
  'SELECT ''notifications: risk_result_id already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'source') > 0,
  'ALTER TABLE early_warning_notifications DROP COLUMN source',
  'SELECT ''notifications: source already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. forecasts: extra indexes only (rows are left alone)
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_forecasts'
      AND index_name = 'uq_forecast_pond_param_target') > 0,
  'ALTER TABLE water_quality_forecasts DROP INDEX uq_forecast_pond_param_target',
  'SELECT ''forecasts: unique key already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_forecasts'
      AND index_name = 'idx_forecast_pond_param_created') > 0,
  'ALTER TABLE water_quality_forecasts DROP INDEX idx_forecast_pond_param_created',
  'SELECT ''forecasts: batch index already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. the new tables
DROP TABLE IF EXISTS ml_job_runs;
DROP TABLE IF EXISTS risk_classification_results;

SELECT 'rollback of 004 finished' AS info;

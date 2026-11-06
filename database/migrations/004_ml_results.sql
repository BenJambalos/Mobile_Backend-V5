-- =====================================================================
-- 004_ml_results.sql  -  storage for the Python ML service
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or rewritten, and no row in
-- water_quality_readings is touched. Safe to run more than once.
--
-- Run it with the same helper you used for migrations 001-003:
--     node scripts/run_sql.js database/migrations/004_ml_results.sql
-- (Back up first - see the "BACKUP" note in the ML service README.)
--
-- What it adds
--   1. risk_classification_results  one Random Forest + hybrid result per
--                                   source reading (UNIQUE source_reading_id)
--   2. ml_job_runs                  one row per scheduler / manual job run,
--                                   so you can see the last successful run
--   3. water_quality_forecasts      UNIQUE (pond_id, parameter, predicted_for)
--                                   so re-running a forecast job updates
--                                   rows instead of duplicating them, plus
--                                   an index for "latest forecast batch"
--   4. early_warning_notifications  two NULLABLE columns, `source` and
--                                   `risk_result_id`, so an alert raised by
--                                   the ML service is identifiable and
--                                   traceable to the result that caused it.
--                                   Existing INSERTs (ingest.js,
--                                   deviceHealth.js) name their columns, so
--                                   they keep working unchanged.
--
-- Part 3 needs the existing forecast rows to be free of duplicates. If
-- duplicates exist the unique key is SKIPPED and this script says so; see
-- the query printed at the end and clean them up before re-running.
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. risk_classification_results
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_classification_results (
  result_id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  farm_id                  INT NOT NULL,
  pond_id                  INT NOT NULL,
  source_reading_id        BIGINT NOT NULL,                    -- the reading this result was computed from
  reading_recorded_at      TIMESTAMP NOT NULL,                 -- copy of that reading's recorded_at (UTC)
  risk_class               ENUM('Low', 'Moderate', 'High') NOT NULL,
  prob_low                 DECIMAL(6,5) DEFAULT NULL,          -- Random Forest class probabilities (0..1)
  prob_moderate            DECIMAL(6,5) DEFAULT NULL,
  prob_high                DECIMAL(6,5) DEFAULT NULL,
  water_quality_condition  ENUM('Normal', 'Abnormal') NOT NULL,   -- project Healthy/Conditional/Unhealthy bands
  forecast_trend           ENUM('Stable', 'Improving', 'Deteriorating') DEFAULT NULL,  -- NULL = no usable forecast
  hybrid_status            ENUM('Normal', 'Warning', 'Critical') NOT NULL,
  details_json             JSON DEFAULT NULL,                  -- per-parameter status, per-parameter trend, notes
  model_version            VARCHAR(40) NOT NULL,
  calculated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_risk_source_reading (source_reading_id),
  KEY idx_risk_pond_time (pond_id, reading_recorded_at),
  KEY idx_risk_farm_time (farm_id, calculated_at),
  CONSTRAINT fk_risk_results_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_risk_results_pond FOREIGN KEY (pond_id)
    REFERENCES ponds (pond_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_risk_results_reading FOREIGN KEY (source_reading_id)
    REFERENCES water_quality_readings (reading_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2. ml_job_runs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ml_job_runs (
  run_id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_name         VARCHAR(30) NOT NULL,                       -- 'risk' | 'forecast'
  trigger_source   VARCHAR(20) NOT NULL DEFAULT 'scheduler',   -- 'scheduler' | 'manual'
  started_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at      TIMESTAMP NULL DEFAULT NULL,
  status           ENUM('running', 'success', 'partial', 'failed', 'skipped') NOT NULL DEFAULT 'running',
  ponds_seen       INT NOT NULL DEFAULT 0,
  ponds_processed  INT NOT NULL DEFAULT 0,
  rows_written     INT NOT NULL DEFAULT 0,
  message          TEXT DEFAULT NULL,
  KEY idx_ml_job_runs_name_time (job_name, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 3. water_quality_forecasts: duplicate protection + latest-batch index
-- ---------------------------------------------------------------------
SET @dups = (
  SELECT COUNT(*) FROM (
    SELECT 1 FROM water_quality_forecasts
    GROUP BY pond_id, parameter, predicted_for HAVING COUNT(*) > 1
  ) d
);

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_forecasts'
      AND index_name = 'uq_forecast_pond_param_target') > 0,
  'SELECT ''forecasts: unique key already present'' AS info',
  IF(@dups > 0,
     'SELECT ''forecasts: unique key SKIPPED because duplicate rows exist - see query at the end of this file'' AS warning',
     'ALTER TABLE water_quality_forecasts ADD UNIQUE KEY uq_forecast_pond_param_target (pond_id, parameter, predicted_for)'));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_forecasts'
      AND index_name = 'idx_forecast_pond_param_created') = 0,
  'ALTER TABLE water_quality_forecasts ADD KEY idx_forecast_pond_param_created (pond_id, parameter, created_at)',
  'SELECT ''forecasts: batch index already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 4. early_warning_notifications: source + risk_result_id
-- ---------------------------------------------------------------------
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'source') = 0,
  'ALTER TABLE early_warning_notifications ADD COLUMN source VARCHAR(30) NULL DEFAULT NULL',
  'SELECT ''notifications: source already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND column_name = 'risk_result_id') = 0,
  'ALTER TABLE early_warning_notifications ADD COLUMN risk_result_id BIGINT NULL DEFAULT NULL',
  'SELECT ''notifications: risk_result_id already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND index_name = 'idx_notifications_pond_source_open') = 0,
  'ALTER TABLE early_warning_notifications ADD KEY idx_notifications_pond_source_open (pond_id, source, is_resolved)',
  'SELECT ''notifications: lookup index already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications'
      AND constraint_name = 'fk_early_warnings_risk_result') = 0,
  'ALTER TABLE early_warning_notifications ADD CONSTRAINT fk_early_warnings_risk_result FOREIGN KEY (risk_result_id) REFERENCES risk_classification_results (result_id) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT ''notifications: foreign key already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- Verification (read-only)
-- ---------------------------------------------------------------------
SELECT 'risk_classification_results' AS object_name, COUNT(*) AS present
  FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'risk_classification_results'
UNION ALL SELECT 'ml_job_runs', COUNT(*)
  FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'ml_job_runs'
UNION ALL SELECT 'uq_forecast_pond_param_target', COUNT(DISTINCT index_name)
  FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'water_quality_forecasts' AND index_name = 'uq_forecast_pond_param_target'
UNION ALL SELECT 'notifications.source', COUNT(*)
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications' AND column_name = 'source'
UNION ALL SELECT 'notifications.risk_result_id', COUNT(*)
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'early_warning_notifications' AND column_name = 'risk_result_id';
-- Every row above should show present = 1.

-- If the unique key was skipped, list the duplicates (keep one row of each,
-- delete the others by forecast_id, then run this file again):
--   SELECT pond_id, parameter, predicted_for, COUNT(*) AS copies, GROUP_CONCAT(forecast_id) AS forecast_ids
--   FROM water_quality_forecasts GROUP BY pond_id, parameter, predicted_for HAVING COUNT(*) > 1;

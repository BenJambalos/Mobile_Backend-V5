-- =====================================================================
-- HyQual database schema
-- =====================================================================
-- This is YOUR schema (from ERD2.mwb) with a small number of corrections,
-- each marked with a "-- CORRECTION:" comment explaining exactly what
-- changed and why. Everything NOT marked is copied through unchanged —
-- your table names, column names, types, ENUM values, and cascade rules
-- were already correct and are kept as-is.
--
-- Summary of corrections for this version:
--   A. device_status is one-to-one with monitoring_devices (UNIQUE device_id).
--   B. water_quality_readings stores pond_id for historical pond attribution.
--   C. device_status.last_seen_at = last time the device talked to the API
--      (status heartbeat, reading upload or config poll). The API derives
--      ONLINE/OFFLINE from it at read time, so a powered-off ESP32 shows
--      OFFLINE even though it could not send a goodbye message.
--   D. monitoring_devices.assigned_at = when the device entered its CURRENT
--      pond, and UNIQUE(pond_id) = at most ONE device per pond (a pond that
--      shared two devices used to appear twice in the Ponds list).
--   For an EXISTING database run migrations/002_device_status_and_reading_pond.sql
--   and then migrations/003_one_device_per_pond.sql instead of this file.
--
-- Summary of original project corrections (7 total):
--   1. water_quality_forecasts: forecast is now tied to a POND, not just
--      a farm. Your farms have multiple ponds, so "farm_id" alone can't
--      tell you which pond a forecast is for.
--   2. early_warning_notifications: same problem — added pond_id (+
--      optional device_id/parameter) so alerts can say WHICH pond.
--   3. early_warning_notifications: added is_read. You already had
--      is_resolved, but that means "the water-quality issue was fixed" —
--      it's a different thing from "the farmer has seen this alert",
--      which the app's Notifications screen needs.
--   4. early_warning_notifications: added title + recommended_action so
--      the notification detail screen has a short headline separate
--      from the long message, plus guidance text.
--   5. monitoring_devices: added device_key, so the physical ESP32 unit
--      has a credential to authenticate with when it POSTs sensor
--      readings (without this, anyone could push fake readings to any
--      device_id).
--   6. NEW small table password_resets, for the "Forgot password" flow.
--   7. accounts: role gains 'super_admin'; status gains 'pending' and
--      'rejected' (default 'pending') for Super Admin account approval.
--      Existing 'active' = APPROVED. See migrations/001_account_approval.sql
--      for the ALTER to run on an already-populated database.
--
-- Run this whole file against an empty schema, then run seed_data.sql.
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- accounts
-- CORRECTION 7: role + 'super_admin'; status + 'pending', 'rejected' and
-- the default is now 'pending' (new registrations wait for a Super Admin).
-- API mapping: pending=PENDING, active=APPROVED, rejected=REJECTED.
-- Admin and Super Admin accounts do not need a farm record; only farm_owner
-- accounts should own rows in aquaculture_farms.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  account_id     INT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(50) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('admin', 'farm_owner', 'super_admin') NOT NULL DEFAULT 'farm_owner',   -- CORRECTION 7
  status         ENUM('active', 'disabled', 'suspended', 'pending', 'rejected') NOT NULL DEFAULT 'pending', -- CORRECTION 7
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- user_profiles  (unchanged from your ERD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      INT AUTO_INCREMENT PRIMARY KEY,
  account_id   INT NOT NULL,
  first_name   VARCHAR(50) NOT NULL,
  middle_name  VARCHAR(50) DEFAULT NULL,
  last_name    VARCHAR(50) NOT NULL,
  email        VARCHAR(100) NOT NULL,
  phone        VARCHAR(20) DEFAULT NULL,
  UNIQUE KEY account_id (account_id),
  UNIQUE KEY email (email),
  CONSTRAINT fk_user_profiles_account FOREIGN KEY (account_id)
    REFERENCES accounts (account_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- aquaculture_farms  (unchanged from your ERD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture_farms (
  farm_id       INT AUTO_INCREMENT PRIMARY KEY,
  owner_id      INT NOT NULL,
  farm_name     VARCHAR(100) NOT NULL,
  street        VARCHAR(100) DEFAULT NULL,
  barangay      VARCHAR(100) DEFAULT NULL,
  municipality  VARCHAR(100) DEFAULT NULL,
  province      VARCHAR(100) DEFAULT NULL,
  zip_code      VARCHAR(10) DEFAULT NULL,
  location      TEXT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY fk_aquaculture_farms_owner (owner_id),
  CONSTRAINT fk_aquaculture_farms_owner FOREIGN KEY (owner_id)
    REFERENCES accounts (account_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- ponds  (unchanged from your ERD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ponds (
  pond_id     INT AUTO_INCREMENT PRIMARY KEY,
  farm_id     INT NOT NULL,
  pond_name   VARCHAR(100) NOT NULL,
  volume      DECIMAL(10,2) DEFAULT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_ponds_farm (farm_id),
  CONSTRAINT fk_ponds_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- monitoring_devices
-- CORRECTION 5: added device_key so the physical ESP32 device can
-- authenticate itself when POSTing sensor readings to the API. Nullable
-- because it's generated at registration time (Register Device screen),
-- not chosen up front.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitoring_devices (
  device_id     INT AUTO_INCREMENT PRIMARY KEY,
  farm_id       INT NOT NULL,
  pond_id       INT DEFAULT NULL,
  assigned_at   TIMESTAMP NULL DEFAULT NULL,       -- CORRECTION D: when it entered pond_id
  device_name   VARCHAR(100) NOT NULL,
  status        ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
  device_key    VARCHAR(64) DEFAULT NULL,          -- CORRECTION 5
  installed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_monitoring_devices_farm (farm_id),
  KEY fk_monitoring_devices_pond (pond_id),
  UNIQUE KEY uq_monitoring_devices_pond (pond_id),   -- CORRECTION D: one device per pond (NULLs allowed)
  UNIQUE KEY device_key (device_key),
  CONSTRAINT fk_monitoring_devices_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_monitoring_devices_pond FOREIGN KEY (pond_id)
    REFERENCES ponds (pond_id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- device_status  CURRENT STATE — exactly one row per device.
-- status_id remains a surrogate key for compatibility with existing joins,
-- while UNIQUE(device_id) enforces the one-to-one relationship.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_status (
  status_id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id             INT NOT NULL,
  battery_percentage    DECIMAL(5,2) DEFAULT NULL,
  is_charging           TINYINT(1) DEFAULT 0,
  connectivity_status   ENUM('online', 'offline', 'weak') DEFAULT 'offline',
  signal_strength       VARCHAR(20) DEFAULT NULL,
  active_sensors_count  INT DEFAULT 0,
  recorded_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,   -- when this snapshot was last written
  last_seen_at          TIMESTAMP NULL DEFAULT NULL,           -- CORRECTION C: last contact of ANY kind
  UNIQUE KEY uq_device_status_device (device_id),
  KEY fk_device_status_device (device_id),
  CONSTRAINT fk_device_status_device FOREIGN KEY (device_id)
    REFERENCES monitoring_devices (device_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- device_maintenance  (unchanged from your ERD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_maintenance (
  maintenance_id  INT AUTO_INCREMENT PRIMARY KEY,
  device_id       INT NOT NULL,
  description     TEXT DEFAULT NULL,
  performed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_device_maintenance_device (device_id),
  CONSTRAINT fk_device_maintenance_device FOREIGN KEY (device_id)
    REFERENCES monitoring_devices (device_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- water_quality_readings  HISTORICAL MEASUREMENTS
-- pond_id records the pond where the measurement was taken. This is
-- intentionally separate from monitoring_devices.pond_id, which means
-- the device's CURRENT assignment. A device may move ponds, but old
-- readings must remain attached to their original pond.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS water_quality_readings (
  reading_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id         INT NOT NULL,
  pond_id           INT NOT NULL,
  temperature       DECIMAL(5,2) DEFAULT NULL,
  ph_level          DECIMAL(4,2) DEFAULT NULL,
  dissolved_oxygen  DECIMAL(5,2) DEFAULT NULL,
  salinity          DECIMAL(5,2) DEFAULT NULL,
  recorded_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_device_time (device_id, recorded_at),
  KEY idx_pond_time (pond_id, recorded_at),
  CONSTRAINT fk_water_quality_readings_device FOREIGN KEY (device_id)
    REFERENCES monitoring_devices (device_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_water_quality_readings_pond FOREIGN KEY (pond_id)
    REFERENCES ponds (pond_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- water_quality_forecasts
-- CORRECTION 1: added pond_id (NOT NULL). A forecast is always for one
-- specific pond's parameter — farm_id alone is ambiguous once a farm has
-- more than one pond, which yours do (Pond A, B, C, D...). Kept farm_id
-- too, since it's handy for "all forecasts for this farm" queries
-- without a join, and it's still correct (pond belongs to that farm).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS water_quality_forecasts (
  forecast_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  farm_id          INT NOT NULL,
  pond_id          INT NOT NULL,                    -- CORRECTION 1
  parameter        ENUM('temperature', 'ph', 'dissolved_oxygen', 'salinity') NOT NULL,
  forecast_value   DECIMAL(6,2) NOT NULL,
  predicted_for    TIMESTAMP NOT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_water_quality_forecasts_farm (farm_id),
  KEY fk_water_quality_forecasts_pond (pond_id),
  CONSTRAINT fk_water_quality_forecasts_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_water_quality_forecasts_pond FOREIGN KEY (pond_id)
    REFERENCES ponds (pond_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- parameter_thresholds  (unchanged from your ERD — farm-wide default
-- safe ranges; every pond on the farm uses these unless you later decide
-- to support per-pond overrides)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parameter_thresholds (
  threshold_id  INT AUTO_INCREMENT PRIMARY KEY,
  farm_id       INT NOT NULL,
  parameter     ENUM('temperature', 'ph', 'dissolved_oxygen', 'salinity') NOT NULL,
  min_value     DECIMAL(6,2) DEFAULT NULL,
  max_value     DECIMAL(6,2) DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_parameter_thresholds_farm (farm_id),
  UNIQUE KEY uniq_farm_parameter (farm_id, parameter),
  CONSTRAINT fk_parameter_thresholds_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- early_warning_notifications
-- CORRECTION 2: added pond_id + device_id + parameter, so an alert can
-- say WHICH pond/device/parameter it's about (same farm_id-only problem
-- as forecasts). All three nullable, since a future farm-wide notice
-- (e.g. "app updated") wouldn't have a pond.
-- CORRECTION 3: added is_read. is_resolved = "the underlying water
-- issue was fixed"; is_read = "the farmer opened/saw this alert". The
-- app's Notifications screen needs both, they're not the same thing.
-- CORRECTION 4: added title (short headline, e.g. "Moderate Risk -Low
-- DO") separate from alert_message (the longer description), plus
-- recommended_action for the alert detail screen.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS early_warning_notifications (
  notification_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  farm_id                  INT NOT NULL,
  pond_id                  INT DEFAULT NULL,          -- CORRECTION 2
  device_id                INT DEFAULT NULL,          -- CORRECTION 2
  parameter                ENUM('temperature', 'ph', 'dissolved_oxygen', 'salinity') DEFAULT NULL, -- CORRECTION 2
  title                    VARCHAR(150) NOT NULL,      -- CORRECTION 4
  alert_level              ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  alert_message            TEXT NOT NULL,
  recommended_action       TEXT DEFAULT NULL,          -- CORRECTION 4
  estimated_arrival_time   TIMESTAMP NULL DEFAULT NULL,
  is_resolved              TINYINT(1) DEFAULT 0,
  is_read                  TINYINT(1) NOT NULL DEFAULT 0, -- CORRECTION 3
  created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_early_warnings_farm (farm_id),
  KEY fk_early_warnings_pond (pond_id),
  KEY fk_early_warnings_device (device_id),
  KEY idx_notifications_created (farm_id, created_at),
  CONSTRAINT fk_early_warnings_farm FOREIGN KEY (farm_id)
    REFERENCES aquaculture_farms (farm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_early_warnings_pond FOREIGN KEY (pond_id)
    REFERENCES ponds (pond_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_early_warnings_device FOREIGN KEY (device_id)
    REFERENCES monitoring_devices (device_id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- activity_logs  (unchanged from your ERD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  log_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id          INT NOT NULL,
  action_type         VARCHAR(50) NOT NULL,
  action_description  TEXT DEFAULT NULL,
  logged_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY fk_activity_logs_account (account_id),
  CONSTRAINT fk_activity_logs_account FOREIGN KEY (account_id)
    REFERENCES accounts (account_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- password_resets  — NEW TABLE, not in your original ERD.
-- Needed for the app's "Forgot password?" flow (currently a UI stub).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id  INT NOT NULL,
  token       VARCHAR(128) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  used        TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY token (token),
  KEY fk_password_resets_account (account_id),
  CONSTRAINT fk_password_resets_account FOREIGN KEY (account_id)
    REFERENCES accounts (account_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================================
-- ML service tables (identical to migrations/004_ml_results.sql).
-- Included here so a brand-new database gets them in one step. An existing
-- database should apply migrations/004_ml_results.sql instead; both are
-- idempotent, so running either one on top of the other is harmless.
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

-- =====================================================================
-- Notification measured value (identical to migrations/005_notification_measured_value.sql).
-- Idempotent: safe on a database that already ran the migration.
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

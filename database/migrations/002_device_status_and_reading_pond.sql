-- =====================================================================
-- 002_device_status_and_reading_pond.sql
--
-- For an EXISTING database (local or Railway) that was created before
-- these fixes. A brand-new database does not need this: schema.sql
-- already contains everything below.
--
--   1. device_status  -> exactly ONE row per device (UNIQUE device_id).
--                        Old duplicate rows are collapsed to the newest.
--   2. device_status  -> new column last_seen_at (last contact of any kind),
--                        used by the API to tell ONLINE from OFFLINE.
--   3. water_quality_readings -> new pond_id column: the pond the reading
--                        was TAKEN in. Existing rows are back-filled from
--                        the device's current pond (see warning below).
--
-- Safe to run more than once. Nothing is deleted except the OLDER duplicate
-- device_status snapshots in step 1. Take a Railway backup first if the
-- database holds real data.
--
-- WARNING about step 3: before this migration the database did not record
-- which pond a reading belonged to, so the only possible back-fill is
-- "the pond the device is assigned to right now". If a device was moved
-- between ponds in the past, its OLD readings will be attributed to its
-- CURRENT pond. That is the best information that exists; from now on
-- every new reading carries its own pond_id.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. device_status: one row per device
-- ---------------------------------------------------------------------
DELETE ds FROM device_status ds
JOIN device_status newer
  ON newer.device_id = ds.device_id
 AND (newer.recorded_at > ds.recorded_at
      OR (newer.recorded_at = ds.recorded_at AND newer.status_id > ds.status_id));

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'device_status'
      AND index_name = 'uq_device_status_device') = 0,
  'ALTER TABLE device_status ADD UNIQUE KEY uq_device_status_device (device_id)',
  'SELECT ''device_status: unique key already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- the old (device_id, recorded_at) history index is now redundant
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'device_status'
      AND index_name = 'idx_device_status_time') > 0,
  'ALTER TABLE device_status DROP INDEX idx_device_status_time',
  'SELECT ''device_status: old history index already gone'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 2. device_status.last_seen_at
-- ---------------------------------------------------------------------
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'device_status'
      AND column_name = 'last_seen_at') = 0,
  'ALTER TABLE device_status ADD COLUMN last_seen_at TIMESTAMP NULL DEFAULT NULL AFTER recorded_at',
  'SELECT ''device_status: last_seen_at already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing snapshots: the last time they were written is the best "last seen"
UPDATE device_status SET last_seen_at = recorded_at WHERE last_seen_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. water_quality_readings.pond_id
-- ---------------------------------------------------------------------
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_readings'
      AND column_name = 'pond_id') = 0,
  'ALTER TABLE water_quality_readings ADD COLUMN pond_id INT NULL AFTER device_id',
  'SELECT ''water_quality_readings: pond_id already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE water_quality_readings r
JOIN monitoring_devices d ON d.device_id = r.device_id
SET r.pond_id = d.pond_id
WHERE r.pond_id IS NULL AND d.pond_id IS NOT NULL;

-- Rows whose device has NO pond right now cannot be attributed. They are
-- never deleted here; the NOT NULL + foreign key below are only applied when
-- there are none.
SET @unattributed = (SELECT COUNT(*) FROM water_quality_readings WHERE pond_id IS NULL);

SET @q = IF(@unattributed = 0
  AND (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'water_quality_readings'
          AND column_name = 'pond_id') = 'YES',
  'ALTER TABLE water_quality_readings MODIFY COLUMN pond_id INT NOT NULL',
  'SELECT ''water_quality_readings: NOT NULL step skipped or already done'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'water_quality_readings'
      AND index_name = 'idx_pond_time') = 0,
  'ALTER TABLE water_quality_readings ADD KEY idx_pond_time (pond_id, recorded_at)',
  'SELECT ''water_quality_readings: idx_pond_time already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @q = IF(@unattributed = 0
  AND (SELECT COUNT(*) FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'water_quality_readings'
          AND constraint_name = 'fk_water_quality_readings_pond') = 0,
  'ALTER TABLE water_quality_readings ADD CONSTRAINT fk_water_quality_readings_pond FOREIGN KEY (pond_id) REFERENCES ponds (pond_id) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT ''water_quality_readings: foreign key skipped or already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- Result. unattributed_readings must be 0. If it is not, those rows belong
-- to devices that are currently not assigned to any pond: assign the
-- device to the right pond (or decide what to do with the rows) and run this
-- file again to finish the NOT NULL / foreign key step.
-- ---------------------------------------------------------------------
SELECT @unattributed AS unattributed_readings,
       (SELECT COUNT(*) FROM device_status)                       AS device_status_rows,
       (SELECT COUNT(DISTINCT device_id) FROM device_status)      AS devices_with_status;

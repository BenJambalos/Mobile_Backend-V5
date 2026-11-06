-- =====================================================================
-- 003_one_device_per_pond.sql
--
-- For an EXISTING database (local or Railway). A brand-new database does
-- not need this: schema.sql already contains everything below.
--
-- Fixes "I moved a device to another pond and the app did not update
-- correctly":
--
--   1. monitoring_devices.assigned_at  NEW column = when the device was
--      put into its CURRENT pond. The API uses it to tell "this pond has
--      not received its first reading from the new device yet" (shown as
--      online/waiting) from "this reading is stale data from before the
--      move". Existing rows stay NULL, which the API treats as "legacy:
--      every reading counts as current", so nothing changes for them.
--
--   2. ONE device per pond. Before this, nothing stopped two devices from
--      sharing a pond, and the Ponds list then showed that pond TWICE
--      (once per device). This step:
--         a. finds ponds that currently have more than one device,
--         b. keeps the device that was heard from most recently (by
--            device_status.last_seen_at; a device never heard from loses)
--            and UNASSIGNS the others (their pond_id becomes NULL; the devices
--            and all their readings are kept - re-assign them in the app),
--         c. adds UNIQUE(pond_id). NULLs are allowed many times, so any
--            number of unassigned devices is fine.
--
-- Safe to run more than once. Take a Railway backup first if the database
-- holds real data. Nothing is deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. assigned_at
-- ---------------------------------------------------------------------
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'monitoring_devices'
      AND column_name = 'assigned_at') = 0,
  'ALTER TABLE monitoring_devices ADD COLUMN assigned_at TIMESTAMP NULL DEFAULT NULL AFTER pond_id',
  'SELECT ''monitoring_devices: assigned_at already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 2a/2b. ponds that have several devices: keep the most recently seen one
-- ---------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS tmp_extra_devices;
CREATE TEMPORARY TABLE tmp_extra_devices AS
SELECT d.device_id
FROM monitoring_devices d
LEFT JOIN device_status ds ON ds.device_id = d.device_id
JOIN monitoring_devices k ON k.pond_id = d.pond_id AND k.device_id <> d.device_id
LEFT JOIN device_status ks ON ks.device_id = k.device_id
WHERE d.pond_id IS NOT NULL
  AND (
        COALESCE(ks.last_seen_at, '1970-01-02') > COALESCE(ds.last_seen_at, '1970-01-02')
     OR (COALESCE(ks.last_seen_at, '1970-01-02') = COALESCE(ds.last_seen_at, '1970-01-02')
         AND k.device_id > d.device_id)
      )
GROUP BY d.device_id;

SET @unassigned_duplicates = (SELECT COUNT(*) FROM tmp_extra_devices);

UPDATE monitoring_devices
SET pond_id = NULL, assigned_at = NULL
WHERE device_id IN (SELECT device_id FROM tmp_extra_devices);

DROP TEMPORARY TABLE IF EXISTS tmp_extra_devices;

-- ---------------------------------------------------------------------
-- 2c. UNIQUE(pond_id)
-- ---------------------------------------------------------------------
SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'monitoring_devices'
      AND index_name = 'uq_monitoring_devices_pond') = 0,
  'ALTER TABLE monitoring_devices ADD UNIQUE KEY uq_monitoring_devices_pond (pond_id)',
  'SELECT ''monitoring_devices: unique pond key already present'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- Result: how many devices lost their pond because the pond had two.
-- (0 on a clean database. Re-assign those devices in the app.)
-- ---------------------------------------------------------------------
SELECT @unassigned_duplicates AS devices_unassigned_because_pond_had_two,
       (SELECT COUNT(*) FROM monitoring_devices WHERE pond_id IS NOT NULL) AS devices_still_assigned;

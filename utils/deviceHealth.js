// Device liveness: how the API decides a device is ONLINE or OFFLINE.
//
// A powered-off ESP32 can't announce that it is offline, so "offline" is
// never something the device tells us. Instead every contact (status
// heartbeat, reading upload, config poll) stamps device_status.last_seen_at,
// and a device that has been silent for longer than OFFLINE_AFTER_SECONDS
// is OFFLINE. That is computed when the data is READ (see connectivitySql),
// so it is correct even if the server was restarted or no background job
// has run yet. A background sweep (sweepOfflineDevices) additionally keeps
// the stored value honest and raises one "Device Offline" notification.
const pool = require('../db');

// The ESP32 contacts the API about once a minute. 180 s = three missed
// beats, which tolerates a slow Wi-Fi reconnect without flapping.
const OFFLINE_AFTER_SECONDS = Math.max(30, parseInt(process.env.DEVICE_OFFLINE_AFTER_SECONDS, 10) || 180);

const OFFLINE_TITLE = 'Device Offline';

// SQL expression -> 'online' | 'weak' | 'offline'. `alias` is the alias of a
// (LEFT JOINed) device_status row. COALESCE(last_seen_at, recorded_at) keeps
// older rows (seed data / pre-migration) working until they report again.
function connectivitySql(alias = 'ds') {
  return `(CASE
    WHEN ${alias}.status_id IS NULL THEN 'offline'
    WHEN ${alias}.connectivity_status = 'offline' THEN 'offline'
    WHEN COALESCE(${alias}.last_seen_at, ${alias}.recorded_at) < (NOW() - INTERVAL ${OFFLINE_AFTER_SECONDS} SECOND) THEN 'offline'
    WHEN ${alias}.connectivity_status = 'weak' THEN 'weak'
    ELSE 'online'
  END)`;
}

// SQL expression -> the last time we heard from the device.
function lastContactSql(alias = 'ds') {
  // NULL means the device has never contacted the API. Do not fall back to
  // recorded_at, because registration creates an initial OFFLINE row.
  return `${alias}.last_seen_at`;
}

// "The device just talked to us." Creates the device's single status row if
// it does not exist yet, stamps last_seen_at, brings a device that had been
// flagged offline back online, and closes any open "Device Offline" alert.
async function touchDevice(deviceId, db = pool) {
  await db.query(
    `INSERT INTO device_status (device_id, connectivity_status, last_seen_at)
     VALUES (?, 'online', NOW())
     ON DUPLICATE KEY UPDATE
       last_seen_at = NOW(),
       connectivity_status = IF(connectivity_status = 'offline', 'online', connectivity_status)`,
    [deviceId]
  );
  await db.query(
    `UPDATE early_warning_notifications SET is_resolved = 1
     WHERE device_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0`,
    [deviceId, OFFLINE_TITLE]
  );
}

// Finds devices that went silent, marks them offline, and raises ONE
// "Device Offline" notification per outage (only for devices that are
// assigned to a pond, because a notification belongs to a pond). Returns the
// number of devices that just changed to offline.
async function sweepOfflineDevices(db = pool) {
  const [stale] = await db.query(
    `SELECT md.device_id, md.device_name, md.farm_id, md.pond_id
     FROM device_status ds
     JOIN monitoring_devices md ON md.device_id = ds.device_id
     WHERE ds.connectivity_status <> 'offline'
       AND COALESCE(ds.last_seen_at, ds.recorded_at) < (NOW() - INTERVAL ${OFFLINE_AFTER_SECONDS} SECOND)`
  );

  let changed = 0;
  for (const d of stale) {
    // Re-check the silence inside the UPDATE so a device that reported a
    // millisecond ago is not flagged by a stale SELECT.
    const [r] = await db.query(
      `UPDATE device_status SET connectivity_status = 'offline'
       WHERE device_id = ? AND connectivity_status <> 'offline'
         AND COALESCE(last_seen_at, recorded_at) < (NOW() - INTERVAL ${OFFLINE_AFTER_SECONDS} SECOND)`,
      [d.device_id]
    );
    if (!r.affectedRows) continue;
    changed++;

    if (!d.pond_id) continue;
    const [open] = await db.query(
      `SELECT notification_id FROM early_warning_notifications
       WHERE device_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0 LIMIT 1`,
      [d.device_id, OFFLINE_TITLE]
    );
    if (open.length) continue;
    await db.query(
      `INSERT INTO early_warning_notifications
         (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read)
       VALUES (?, ?, ?, NULL, ?, 'low', ?, ?, 0, 0)`,
      [
        d.farm_id, d.pond_id, d.device_id, OFFLINE_TITLE,
        `${d.device_name} has stopped reporting. No data received from sensor. Check power and connectivity.`,
        "Check the device's solar panel and battery, and confirm it is within Wi-Fi range.",
      ]
    );
  }
  return changed;
}

// Runs the sweep once a minute for the life of the server. Set
// DEVICE_OFFLINE_MONITOR=off to disable it (the read-time OFFLINE
// detection keeps working regardless).
function startOfflineMonitor() {
  if (String(process.env.DEVICE_OFFLINE_MONITOR || '').toLowerCase() === 'off') {
    console.log('Offline monitor: disabled (DEVICE_OFFLINE_MONITOR=off)');
    return null;
  }
  const monitorState = require('./monitorState');
  monitorState.register('deviceOffline', 60);
  const run = async () => {
    const started = Date.now();
    try {
      const changed = await sweepOfflineDevices();
      monitorState.recordRun('deviceOffline', { durationMs: Date.now() - started, result: { markedOffline: changed } });
    } catch (err) {
      console.error('Offline monitor failed:', err.code || err.message);
      monitorState.recordRun('deviceOffline', { durationMs: Date.now() - started, error: err.code || err.message });
    }
  };
  setTimeout(run, 5000).unref();
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  console.log(`Offline monitor: devices silent for ${OFFLINE_AFTER_SECONDS}s are marked offline`);
  return timer;
}

module.exports = {
  OFFLINE_AFTER_SECONDS,
  OFFLINE_TITLE,
  connectivitySql,
  lastContactSql,
  touchDevice,
  sweepOfflineDevices,
  startOfflineMonitor,
};

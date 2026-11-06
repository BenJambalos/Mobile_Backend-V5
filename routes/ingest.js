const express = require('express');
const pool = require('../db');
const { paramStatus } = require('../utils/status');
const { touchDevice } = require('../utils/deviceHealth');
const { hasColumn } = require('../utils/schemaFeatures');
const { resolveStaleAlert } = require('../utils/readingFreshness');

const router = express.Router();

// These endpoints are called BY the physical HyQual devices, not by the
// mobile app, so they authenticate with a device_key (issued when the
// device is registered — see POST /api/devices) instead of a user JWT.
async function resolveDevice(deviceKey) {
  const [rows] = await pool.query(
    `SELECT device_id, farm_id, pond_id FROM monitoring_devices WHERE device_key = ?`,
    [deviceKey]
  );
  return rows[0] || null;
}

const TEMPLATES = {
  dissolved_oxygen: {
    label: 'DO',
    unit: 'mg/L',
    low: {
      title: (crit) => (crit ? 'High Risk -Low Dissolve Oxygen' : 'Moderate Risk -Low DO'),
      message: (v, min) => `DO level at ${v} mg/L, below the safe threshold of \u2265 ${min} mg/L`,
      action: (crit) => crit
        ? 'Run emergency aeration immediately and inspect for the cause of the drop (overstocking, organic buildup, or equipment failure).'
        : 'Increase aeration and re-check dissolved oxygen every 30 minutes until it stabilizes.',
    },
  },
  ph: {
    label: 'pH',
    unit: 'pH',
    low: {
      title: () => 'Low pH',
      message: (v, min) => `pH at ${v}, below the safe threshold of \u2265 ${min}`,
      action: () => 'Monitor pH hourly; consider agricultural lime to raise pH gradually.',
    },
    high: {
      title: () => 'Moderate High ph',
      message: (v, max) => `pH trending toward ${v}, nearing the unsafe threshold of \u2264 ${max}.`,
      action: () => 'Monitor pH hourly and avoid adding lime or other pH-raising treatments until it stabilizes.',
    },
  },
  temperature: {
    label: 'Temperature',
    unit: '\u00b0C',
    high: {
      title: () => 'High Water Temperature',
      message: (v, max) => `Temperature at ${v}\u00b0C, above the safe threshold of \u2264 ${max}\u00b0C`,
      action: () => 'Increase water depth or add shading; avoid feeding during peak heat.',
    },
    low: {
      title: () => 'Low Water Temperature',
      message: (v, min) => `Temperature at ${v}\u00b0C, below the safe threshold of \u2265 ${min}\u00b0C`,
      action: () => 'Reduce water exchange rate and monitor for cold stress.',
    },
  },
  salinity: {
    label: 'Salinity',
    unit: 'ppt',
    high: {
      title: () => 'High Salinity',
      message: (v, max) => `Salinity at ${v} ppt, above the safe threshold of \u2264 ${max} ppt`,
      action: () => 'Add fresh water gradually to dilute salinity.',
    },
    low: {
      title: () => 'Low Salinity',
      message: (v, min) => `Salinity at ${v} ppt, below the safe threshold of \u2265 ${min} ppt`,
      action: () => 'Check for freshwater intrusion or heavy rainfall dilution.',
    },
  },
};

// Alert lifecycle for ONE parameter of ONE pond (QA finding D):
//
//   no open alert + out of range  -> create one (medium = warning, critical)
//   open alert + MORE severe      -> ESCALATE the same alert in place (new level,
//                                    title, text, value; marked unread again and
//                                    moved to the top). Never a second alert.
//   open alert + LESS severe      -> lower it in place (improving, still out of range)
//   open alert + same severity    -> refresh the measured value / text only
//   back in range                 -> resolve ONLY after ALERT_RECOVERY_READINGS
//                                    consecutive in-range readings (default 3,
//                                    about 15 minutes), so a value hovering around
//                                    a limit does not open and close alerts over
//                                    and over.
//   no value for this parameter   -> nothing changes (silence is not recovery)
const ALERT_RECOVERY_READINGS = Math.max(1, parseInt(process.env.ALERT_RECOVERY_READINGS, 10) || 3);
const ALERT_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const READING_COLUMN = { temperature: 'temperature', ph: 'ph_level', dissolved_oxygen: 'dissolved_oxygen', salinity: 'salinity' };

// True when the newest N stored readings of this parameter in this pond are all in range.
async function recoveredEnough(conn, pondId, parameter, t) {
  const col = READING_COLUMN[parameter]; // fixed map, never user input
  const [rows] = await conn.query(
    `SELECT ${col} AS v FROM water_quality_readings WHERE pond_id = ? AND ${col} IS NOT NULL
     ORDER BY recorded_at DESC, reading_id DESC LIMIT ?`,
    [pondId, ALERT_RECOVERY_READINGS]
  );
  return rows.length >= ALERT_RECOVERY_READINGS && rows.every((r) => paramStatus(Number(r.v), t.min, t.max) === 'normal');
}

async function checkThresholdsAndAlert(conn, { farmId, pondId, deviceId, parameter, value, thresholds }) {
  const t = thresholds[parameter];
  if (!t) return;
  const status = paramStatus(value, t.min, t.max);
  if (status === 'unavailable') return;
  const tmpl = TEMPLATES[parameter];
  const direction = t.min !== null && value < t.min ? 'low' : (t.max !== null && value > t.max ? 'high' : null);

  // Find any still-open (unresolved) alert for this pond+parameter.
  const [openAlerts] = await conn.query(
    `SELECT notification_id, alert_level FROM early_warning_notifications
     WHERE pond_id = ? AND parameter = ? AND is_resolved = 0 ORDER BY created_at DESC, notification_id DESC LIMIT 1`,
    [pondId, parameter]
  );

  if (status === 'normal') {
    if (openAlerts.length && await recoveredEnough(conn, pondId, parameter, t)) {
      await conn.query('UPDATE early_warning_notifications SET is_resolved = 1 WHERE notification_id = ?', [openAlerts[0].notification_id]);
    }
    return;
  }

  if (!tmpl || !direction || !tmpl[direction]) return;
  const t2 = tmpl[direction];
  const isCritical = status === 'critical';
  const level = isCritical ? 'critical' : 'medium';
  const bound = direction === 'low' ? t.min : t.max;
  const title = t2.title(isCritical);
  const message = t2.message(value, bound);
  const action = t2.action(isCritical);
  const withValue = await hasColumn('early_warning_notifications', 'measured_value');

  if (!openAlerts.length) {
    await conn.query(
      `INSERT INTO early_warning_notifications
         (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read${withValue ? ', measured_value' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0${withValue ? ', ?' : ''})`,
      [farmId, pondId, deviceId, parameter, title, level, message, action, ...(withValue ? [value] : [])]
    );
    return;
  }

  const open = openAlerts[0];
  const openRank = ALERT_RANK[open.alert_level] ?? 0;
  const sets = ['alert_level = ?', 'title = ?', 'alert_message = ?', 'recommended_action = ?'];
  const params = [level, title, message, action];
  if (withValue) { sets.push('measured_value = ?'); params.push(value); }
  if (ALERT_RANK[level] > openRank) {
    sets.push('is_read = 0', 'created_at = NOW()'); // escalation: shout again, move to the top
  }
  await conn.query(`UPDATE early_warning_notifications SET ${sets.join(', ')} WHERE notification_id = ?`, [...params, open.notification_id]);
}

// ---------------------------------------------------------------------
// Helpers for the two ingest endpoints
// ---------------------------------------------------------------------

// Plausible physical ranges. A value outside its range is a sensor fault
// (a disconnected probe reads 0 or 14000, say), not water chemistry. It is
// stored as NULL for that parameter instead of poisoning averages, charts
// and the ML dataset - and it would overflow the DECIMAL columns anyway.
const RANGES = {
  temperature: [-5, 60],
  phLevel: [0, 14],
  dissolvedOxygen: [0, 30],
  salinity: [0, 100],
};

// Returns { value, ignored } for one measurement. `ignored` is true when a
// value was sent but rejected as not-a-number / out of range.
function cleanMeasurement(raw, key) {
  if (raw === undefined || raw === null || raw === '') return { value: null, ignored: false };
  const n = Number(raw);
  const [lo, hi] = RANGES[key];
  if (!Number.isFinite(n) || n < lo || n > hi) return { value: null, ignored: true };
  return { value: n, ignored: false };
}

// recordedAt = WHEN the reading was taken, as sent by a device that queued
// it on its SD card while offline. Epoch seconds (or ms) or an ISO string.
// Returns { epoch: null } when not supplied (= "now", a live reading).
function parseRecordedAt(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, epoch: null };
  let ms;
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()))) {
    const n = Number(raw);
    ms = n > 1e11 ? n : n * 1000;
  } else if (typeof raw === 'string') {
    ms = Date.parse(raw);
  } else {
    return { ok: false };
  }
  // Before 2020 = a device whose clock never synced (1970); more than 5
  // minutes ahead = a wrong clock. Either would corrupt the time series.
  if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1) || ms > Date.now() + 5 * 60 * 1000) return { ok: false };
  return { ok: true, epoch: Math.floor(ms / 1000) };
}

// Readings older than this are stored (they are history) but do NOT raise
// new alerts: draining a backlog after an outage must not fire hours-old
// "critical" notifications for conditions that may be long over.
const ALERT_FRESH_SECONDS = 10 * 60;

async function currentAssignment(deviceId) {
  const [rows] = await pool.query(
    `SELECT md.device_id, md.farm_id, md.pond_id, p.pond_name
     FROM monitoring_devices md LEFT JOIN ponds p ON p.pond_id = md.pond_id
     WHERE md.device_id = ?`,
    [deviceId]
  );
  return rows[0];
}

// POST /api/ingest/readings
// { deviceKey, temperature, phLevel, dissolvedOxygen, salinity,
//   pondIdAtCapture? (or legacy pondId), <- pond assigned WHEN taken
//   recordedAt? }  <- when it took it (epoch seconds / ISO); omit for "now"
//
// Every stored reading permanently carries the pond it was taken in
// (water_quality_readings.pond_id), independent of where the device is
// assigned later. A device that queued a reading on its SD card while
// offline sends the pondId it had at that moment, so moving the device
// before the backlog uploads cannot re-label old data. Without pondId the
// device's CURRENT pond is used (live readings from older firmware).
router.post('/ingest/readings', async (req, res) => {
  const body = req.body || {};
  const { deviceKey } = body;
  if (!deviceKey) return res.status(401).json({ error: 'deviceKey is required' });

  const device = await resolveDevice(deviceKey);
  if (!device) return res.status(401).json({ error: 'Unknown device key' });

  // ---- which pond does this reading belong to? ----
  let pondId;
  // New ESP32 firmware uses pondIdAtCapture. Accept pondId as a backwards-
  // compatible alias for older firmware. Never replace a captured pond with
  // the device's current assignment when uploading an SD-card backlog.
  const capturedPondId = body.pondIdAtCapture ?? body.pondId;
  if (capturedPondId !== undefined && capturedPondId !== null && capturedPondId !== '') {
    pondId = Number(capturedPondId);
    if (!Number.isInteger(pondId) || pondId <= 0) {
      return res.status(400).json({ error: 'pondId must be a positive integer', code: 'BAD_POND_ID' });
    }
    const [pondRows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [pondId, device.farm_id]);
    if (!pondRows.length) {
      // e.g. the pond was deleted after the reading was queued. Permanent:
      // the device should drop this reading instead of retrying forever.
      return res.status(422).json({ error: 'That pond does not exist in this device\'s farm', code: 'POND_NOT_FOUND' });
    }
  } else {
    if (!device.pond_id) {
      return res.status(409).json({ error: 'Device is not assigned to a pond yet', code: 'DEVICE_UNASSIGNED' });
    }
    pondId = device.pond_id;
  }

  // ---- when was it taken? ----
  // `recordedAt` is the documented field and is validated strictly (422 when
  // wrong). The ESP32 firmware in /esp32 sends the same moment as `createdAt`
  // (ISO-8601 UTC); it is used as a fallback, but leniently: an unusable
  // `createdAt` just means "treat as a live reading" and never rejects the
  // reading, so a device with a bad clock can't get its whole queue stuck.
  let when;
  if (body.recordedAt !== undefined && body.recordedAt !== null && body.recordedAt !== '') {
    when = parseRecordedAt(body.recordedAt);
    if (!when.ok) {
      return res.status(422).json({ error: 'recordedAt is not a valid recent time (device clock not synced?)', code: 'BAD_TIMESTAMP' });
    }
  } else {
    when = parseRecordedAt(body.createdAt);
    if (!when.ok) when = { ok: true, epoch: null };
  }

  // ---- the measurements ----
  const t = cleanMeasurement(body.temperature, 'temperature');
  const ph = cleanMeasurement(body.phLevel, 'phLevel');
  const dox = cleanMeasurement(body.dissolvedOxygen, 'dissolvedOxygen');
  const sal = cleanMeasurement(body.salinity, 'salinity');
  const ignored = [];
  if (t.ignored) ignored.push('temperature');
  if (ph.ignored) ignored.push('phLevel');
  if (dox.ignored) ignored.push('dissolvedOxygen');
  if (sal.ignored) ignored.push('salinity');
  if ([t, ph, dox, sal].every((m) => m.value === null)) {
    return res.status(422).json({ error: 'No usable measurement in this reading', code: 'NO_VALID_VALUES', ignored });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // A device that lost the server's reply re-sends the same reading. Only
    // possible to recognise when the device supplies the time it was taken.
    if (when.epoch !== null) {
      const [dup] = await conn.query(
        'SELECT reading_id FROM water_quality_readings WHERE device_id = ? AND pond_id = ? AND recorded_at = FROM_UNIXTIME(?) LIMIT 1',
        [device.device_id, pondId, when.epoch]
      );
      if (dup.length) {
        await conn.commit();
        await touchDevice(device.device_id);
        const cfg = await currentAssignment(device.device_id);
        return res.status(200).json({
          message: 'Reading already recorded.', duplicate: true, reading_id: dup[0].reading_id,
          pond_id: pondId, config: { pond_id: cfg.pond_id, pond_name: cfg.pond_name },
        });
      }
    }

    const timeSql = when.epoch !== null ? 'FROM_UNIXTIME(?)' : 'NOW()';
    const params = [device.device_id, pondId, t.value, ph.value, dox.value, sal.value];
    if (when.epoch !== null) params.push(when.epoch);
    const [ins] = await conn.query(
      `INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ${timeSql})`,
      params
    );

    const isFresh = when.epoch === null || (Date.now() / 1000 - when.epoch) <= ALERT_FRESH_SECONDS;
    // Alerts describe what a device is monitoring NOW. A reading that belongs
    // to a pond the device has since been moved out of is history (it is
    // stored, but it must not open an alert - or sound the alarm - for a pond
    // that no longer has this device).
    const forCurrentPond = pondId === device.pond_id;
    if (isFresh && forCurrentPond) {
      const [thRows] = await conn.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [device.farm_id]);
      const thresholds = {};
      for (const r of thRows) thresholds[r.parameter] = { min: r.min_value, max: r.max_value };

      const checks = [
        ['temperature', t.value], ['ph', ph.value],
        ['dissolved_oxygen', dox.value], ['salinity', sal.value],
      ];
      for (const [param, value] of checks) {
        if (value === null) continue;
        await checkThresholdsAndAlert(conn, {
          farmId: device.farm_id, pondId, deviceId: device.device_id,
          parameter: param, value, thresholds,
        });
      }
      // Data is flowing again: an "Outdated Readings" alert for this pond is over.
      await resolveStaleAlert(conn, pondId);
    }

    await conn.commit();

    // Contact counts as "alive" even for a backlog upload.
    await touchDevice(device.device_id);
    const cfg = await currentAssignment(device.device_id);
    res.status(201).json({
      message: 'Reading recorded.',
      reading_id: ins.insertId,
      pond_id: pondId,
      ignored,
      // The device's CURRENT assignment, so an ESP32 whose last config poll
      // is a bit old learns about a pond change from its very next upload.
      config: { pond_id: cfg.pond_id, pond_name: cfg.pond_name },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/ingest/status
// { deviceKey, batteryPercentage, isCharging, connectivityStatus, signalStrength, activeSensorsCount }
//
// device_status holds the device's CURRENT state: ONE row per device,
// updated in place (it used to INSERT a new row on every heartbeat, which
// is what piled up status rows). It is a snapshot, not a log.
router.post('/ingest/status', async (req, res) => {
  const body = req.body || {};
  const { deviceKey, isCharging, signalStrength } = body;
  if (!deviceKey) return res.status(401).json({ error: 'deviceKey is required' });

  const device = await resolveDevice(deviceKey);
  if (!device) return res.status(401).json({ error: 'Unknown device key' });

  let battery = null;
  if (body.batteryPercentage !== undefined && body.batteryPercentage !== null && body.batteryPercentage !== '') {
    const b = Number(body.batteryPercentage);
    if (Number.isFinite(b)) battery = Math.min(100, Math.max(0, b));
  }
  const sensors = Math.min(4, Math.max(0, parseInt(body.activeSensorsCount, 10) || 0));
  // The device may say it is online or on a weak link. "offline" is never
  // something a device reports about itself while it is talking to us.
  const conn = body.connectivityStatus === 'weak' ? 'weak' : 'online';

  await pool.query(
    `INSERT INTO device_status
       (device_id, battery_percentage, is_charging, connectivity_status, signal_strength, active_sensors_count, recorded_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       battery_percentage = VALUES(battery_percentage),
       is_charging = VALUES(is_charging),
       connectivity_status = VALUES(connectivity_status),
       signal_strength = VALUES(signal_strength),
       active_sensors_count = VALUES(active_sensors_count),
       recorded_at = NOW(),
       last_seen_at = NOW()`,
    [device.device_id, battery, isCharging ? 1 : 0, conn, signalStrength ? String(signalStrength).slice(0, 20) : null, sensors]
  );
  // The upsert above already refreshed last_seen_at; this closes any open
  // "Device Offline" alert now that the device is talking again.
  await touchDevice(device.device_id);

  const cfg = await currentAssignment(device.device_id);
  res.status(200).json({
    message: 'Status recorded.',
    config: { pond_id: cfg.pond_id, pond_name: cfg.pond_name },
  });
});

// GET /api/devices/:deviceId/config      header: x-device-key: <device key>
// Polled by the ESP32 (~every 60 s) to learn which pond it is currently
// assigned to. Lives in this router (not devices.js) because it
// authenticates with the device key like the other ingest endpoints —
// devices.js applies the farmer's JWT to everything it handles. The key
// must belong to the device id in the URL, so one device can't read
// another's assignment by guessing ids. Header only (not a query
// string) so the key doesn't end up in request logs.
router.get('/devices/:deviceId/config', async (req, res) => {
  const deviceKey = req.get('x-device-key');
  if (!deviceKey) return res.status(401).json({ error: 'x-device-key header is required' });

  const [rows] = await pool.query(
    `SELECT md.device_id, md.farm_id, md.pond_id, p.pond_name
     FROM monitoring_devices md
     LEFT JOIN ponds p ON md.pond_id = p.pond_id
     WHERE md.device_id = ? AND md.device_key = ?`,
    [req.params.deviceId, deviceKey]
  );
  // Same answer for "no such device" and "wrong key" (no id probing).
  if (!rows.length) return res.status(401).json({ error: 'Invalid device id or key' });

  const d = rows[0];
  // Polling for config is also proof the device is alive.
  await touchDevice(d.device_id);
  res.set('Cache-Control', 'no-store');
  res.json({
    device_id: d.device_id,
    farm_id: d.farm_id,
    pond_id: d.pond_id,       // null while the device is unassigned
    pond_name: d.pond_name,   // null while the device is unassigned
  });
});

module.exports = router;

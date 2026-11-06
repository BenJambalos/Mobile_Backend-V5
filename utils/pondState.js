// One place that decides what a POND looks like right now (status, online /
// offline, which reading to show). The Ponds list, the pond detail screen,
// the "device moved" reply and the alarm endpoint ALL use this, so they can
// never disagree with each other.
//
// Rules (this is what makes a device move show up instantly):
//   * A pond is judged by the device assigned to it RIGHT NOW. No device, or
//     a device that has gone silent -> OFFLINE. So the pond a device LEAVES
//     is offline the moment the move is saved.
//   * A pond whose (online) device was JUST assigned has no reading of its own
//     yet. It is shown as online ("waiting for first reading") instead of
//     offline, until the first reading taken after the move arrives. It is NOT
//     shown as "normal": with no measurement the water quality is unknown, so
//     the status is 'stale' (neutral). Online and offline describe the DEVICE;
//     normal / warning / critical describe the WATER.
//   * Missing or outdated data is never green. A reading older than
//     READING_STALE_AFTER_SECONDS is not judged at all: the pond is 'stale',
//     with the time of the last reading, and no alarm can ring from it.
//   * The ML service's hybrid result (risk_classification_results) can only
//     RAISE the displayed status (Warning/Critical), and only while it is
//     recent, so the pond card, the notification and the hybrid status agree.
//   * Only readings taken since the device entered the pond count as the
//     pond's current reading (monitoring_devices.assigned_at). So moving a
//     device back into a pond it was in last week does not resurrect that
//     week-old reading (and cannot trigger an alarm from it).
const pool = require('../db');
const { computePondStatus, PARAM_LABELS, PARAM_UNITS, STATUS_RANK } = require('./status');
const { iso } = require('./time');
const { connectivitySql } = require('./deviceHealth');

// The firmware sends a reading every 5 minutes (and immediately after it
// learns of a pond change). 10 minutes = two missed uploads.
const FIRST_READING_GRACE_SECONDS = Math.max(60, parseInt(process.env.POND_FIRST_READING_GRACE_SECONDS, 10) || 600);

// A reading older than this is outdated. The firmware uploads every 5 minutes,
// so the default of 15 minutes means three missed uploads.
const STALE_READING_SECONDS = Math.max(120, parseInt(process.env.READING_STALE_AFTER_SECONDS, 10) || 900);

// A hybrid result is only trusted for this long after the reading it was
// computed from (the ML service runs every 15 minutes).
const HYBRID_MAX_AGE_SECONDS = Math.max(300, parseInt(process.env.HYBRID_MAX_AGE_SECONDS, 10) || 2700);

// The alarm only rings for FRESH data. A critical reading older than this
// (default 20 minutes = four missed 5-minute uploads) is not "the water is
// critical right now"; it is a sensor that stopped delivering, which must not
// keep an alarm blaring on old numbers (or ring the moment someone logs in to
// a database full of old demo data). The pond card still shows its last status.
const ALARM_MAX_READING_AGE_SECONDS = Math.max(60, parseInt(process.env.ALARM_MAX_READING_AGE_SECONDS, 10) || 1200);

function timeAgo(date) {
  if (!date) return 'never';
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function getThresholds(farmId) {
  const [rows] = await pool.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [farmId]);
  const map = {};
  for (const r of rows) map[r.parameter] = { min: r.min_value, max: r.max_value };
  return map;
}

// "Latest reading" is the latest reading TAKEN IN THIS POND (wr.pond_id), not
// the latest reading of whatever device is assigned now, so a moved device
// never drags numbers from one pond into another. Connectivity comes from the
// device assigned to the pond now (at most one: UNIQUE(monitoring_devices.pond_id)).
const PONDS_QUERY = `
  SELECT p.pond_id, p.pond_name, p.volume, md.device_id, md.device_name, md.assigned_at,
    TIMESTAMPDIFF(SECOND, md.assigned_at, NOW()) AS assigned_age_s,
    wr.reading_id, wr.temperature, wr.ph_level, wr.dissolved_oxygen, wr.salinity, wr.recorded_at,
    TIMESTAMPDIFF(SECOND, wr.recorded_at, NOW()) AS reading_age_s,
    (wr.reading_id IS NOT NULL AND (md.assigned_at IS NULL OR wr.recorded_at >= md.assigned_at)) AS reading_is_current,
    ${connectivitySql('ds')} AS connectivity_status
  FROM ponds p
  LEFT JOIN monitoring_devices md ON md.pond_id = p.pond_id
  LEFT JOIN water_quality_readings wr ON wr.reading_id = (
    SELECT wr2.reading_id FROM water_quality_readings wr2
    WHERE wr2.pond_id = p.pond_id ORDER BY wr2.recorded_at DESC, wr2.reading_id DESC LIMIT 1
  )
  LEFT JOIN device_status ds ON ds.device_id = md.device_id
  WHERE p.farm_id = ?
`;

// Newest hybrid (Random Forest + ARIMA + rules) result of every pond of the
// farm, keyed by pond id. Returns an empty Map if the ML migration has not been
// applied yet, so the API keeps working before and after the migration.
async function loadHybridByPond(farmId) {
  try {
    const [rows] = await pool.query(
      `SELECT r.pond_id, r.hybrid_status, r.forecast_trend, r.risk_class, r.reading_recorded_at,
              TIMESTAMPDIFF(SECOND, r.reading_recorded_at, NOW()) AS age_s
       FROM risk_classification_results r
       JOIN (SELECT pond_id, MAX(result_id) AS newest FROM risk_classification_results WHERE farm_id = ? GROUP BY pond_id) m
         ON m.newest = r.result_id`,
      [farmId]
    );
    const map = new Map();
    for (const r of rows) {
      map.set(r.pond_id, { status: r.hybrid_status, trend: r.forecast_trend, riskClass: r.risk_class, ageSeconds: Number(r.age_s), recordedAt: r.reading_recorded_at });
    }
    return map;
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return new Map();
    throw err;
  }
}

// A hybrid result counts only while recent and only if it was computed from a
// reading taken since the device entered this pond.
function usableHybrid(row, hybrid) {
  if (!hybrid || !Number.isFinite(hybrid.ageSeconds) || hybrid.ageSeconds > HYBRID_MAX_AGE_SECONDS) return null;
  if (row.assigned_at && hybrid.recordedAt && new Date(hybrid.recordedAt) < new Date(row.assigned_at)) return null;
  return hybrid;
}

const HYBRID_TO_STATUS = { Normal: 'normal', Warning: 'warning', Critical: 'critical' };

// row = one row of PONDS_QUERY; hybrid = entry from loadHybridByPond (optional).
function evaluatePond(row, thresholds, hybrid = null) {
  const hasDevice = row.device_id !== null && row.device_id !== undefined;
  const online = hasDevice && row.connectivity_status !== 'offline';
  const hasReading = row.reading_id !== null && row.reading_id !== undefined;
  const lastReading = hasReading ? {
    temperature: row.temperature, ph_level: row.ph_level,
    dissolved_oxygen: row.dissolved_oxygen, salinity: row.salinity,
  } : null;
  const base = { hasDevice, stale: false, staleReason: null, hybridStatus: null, statusSource: 'thresholds' };

  // No device / silent device: OFFLINE. Keep showing the pond's own last reading.
  if (!online) {
    return { ...base, online: false, awaitingReading: false, currentReading: null, shownReading: lastReading, status: 'offline', byParameter: {} };
  }

  // Online and the pond has a reading taken since the device arrived.
  if (hasReading && Number(row.reading_is_current) === 1) {
    const age = row.reading_age_s === null || row.reading_age_s === undefined ? null : Number(row.reading_age_s);
    // Outdated: do not judge old numbers (and never call them normal).
    if (age === null || age > STALE_READING_SECONDS) {
      // Not judged as current, but never hidden either: remember what the
      // LAST reading said so the app can show "outdated, last reading was
      // critical" instead of a neutral card that conceals a problem.
      const last = computePondStatus(lastReading, thresholds, true).overall;
      return { ...base, online: true, awaitingReading: false, stale: true, staleReason: 'outdated', lastKnownStatus: last === 'stale' ? null : last, currentReading: null, shownReading: lastReading, status: 'stale', byParameter: {} };
    }
    const { overall, byParameter } = computePondStatus(lastReading, thresholds, true);
    let status = overall;
    let hybridStatus = null;
    let statusSource = 'thresholds';
    const h = status === 'stale' ? null : usableHybrid(row, hybrid);
    if (h) {
      hybridStatus = h.status;
      const hs = HYBRID_TO_STATUS[h.status];
      // The hybrid result may only raise the status, never hide a threshold problem.
      if (hs && STATUS_RANK[hs] > STATUS_RANK[status]) { status = hs; statusSource = 'hybrid'; }
    }
    const stale = status === 'stale';
    return { ...base, online: true, awaitingReading: false, stale, staleReason: stale ? 'no_valid_values' : null, hybridStatus, statusSource,
      currentReading: stale ? null : lastReading, shownReading: lastReading, status, byParameter };
  }

  // Online, but no reading from the new assignment yet.
  const age = row.assigned_age_s === null || row.assigned_age_s === undefined ? null : Number(row.assigned_age_s);
  if (age !== null && age <= FIRST_READING_GRACE_SECONDS) {
    return { ...base, online: true, awaitingReading: true, stale: true, staleReason: 'awaiting_first_reading', currentReading: null, shownReading: null, status: 'stale', byParameter: {} };
  }
  // Online but delivering no data (or a legacy row with no reading at all). The
  // DEVICE is up, so this is missing data, not an offline device.
  return { ...base, online: true, awaitingReading: false, stale: true, staleReason: 'no_readings', currentReading: null, shownReading: lastReading, status: 'stale', byParameter: {} };
}

function pondRowToJson(row, thresholds, hybrid = null) {
  const ev = evaluatePond(row, thresholds, hybrid);
  const shown = ev.shownReading;
  const missing = [];
  if (shown) {
    if (shown.ph_level === null || shown.ph_level === undefined) missing.push('ph');
    if (shown.dissolved_oxygen === null || shown.dissolved_oxygen === undefined) missing.push('dissolved_oxygen');
    if (shown.temperature === null || shown.temperature === undefined) missing.push('temperature');
    if (shown.salinity === null || shown.salinity === undefined) missing.push('salinity');
  }
  let updatedAgo = timeAgo(row.recorded_at);
  if (ev.awaitingReading) updatedAgo = 'waiting for first reading';
  else if (ev.stale && ev.staleReason === 'no_readings') updatedAgo = 'no readings yet';
  return {
    id: String(row.pond_id),
    name: row.pond_name,
    size: row.volume !== null ? String(row.volume) : '',
    status: ev.status,
    ph: shown?.ph_level ?? 0,
    dissolvedOxygen: shown?.dissolved_oxygen ?? 0,
    temperature: shown?.temperature ?? 0,
    salinity: shown?.salinity ?? 0,
    updatedAgo,
    assignedDeviceId: row.device_id ? String(row.device_id) : null,
    awaitingReading: ev.awaitingReading,
    // Additive fields (older app builds ignore them):
    deviceOnline: ev.online,
    stale: ev.stale,
    staleReason: ev.staleReason,
    lastReadingAt: iso(row.recorded_at),
    missingParameters: missing,
    hybridStatus: ev.hybridStatus,
    statusSource: ev.statusSource,
    lastKnownStatus: ev.lastKnownStatus ?? null,
  };
}

// Status of ONE pond (used by the "device moved" reply).
async function pondSnapshot(farmId, pondId) {
  if (pondId === null || pondId === undefined) return null;
  const thresholds = await getThresholds(farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' AND p.pond_id = ?', [farmId, pondId]);
  if (!rows.length) return null;
  const hybrid = (await loadHybridByPond(farmId)).get(Number(pondId)) || null;
  const j = pondRowToJson(rows[0], thresholds, hybrid);
  return { id: j.id, name: j.name, status: j.status, awaitingReading: j.awaitingReading, assignedDeviceId: j.assignedDeviceId, stale: j.stale, deviceOnline: j.deviceOnline };
}

const PARAM_KEYS = ['temperature', 'ph', 'dissolved_oxygen', 'salinity'];

function readingValue(reading, key) {
  if (!reading) return null;
  const v = key === 'ph' ? reading.ph_level : reading[key];
  return v === null || v === undefined ? null : Number(v);
}

// Every parameter that is CRITICAL right now, in ponds whose device is online
// and has delivered a FRESH reading since it was assigned. This is what sounds
// the alarm in the app. Warnings do not ring; offline / waiting / stale ponds
// do not ring.
function criticalAlarms(row, thresholds) {
  const ev = evaluatePond(row, thresholds);
  if (!ev.online || ev.awaitingReading || !ev.currentReading) return [];
  if (row.reading_age_s === null || row.reading_age_s === undefined || Number(row.reading_age_s) > ALARM_MAX_READING_AGE_SECONDS) return [];
  const out = [];
  for (const key of PARAM_KEYS) {
    if (ev.byParameter[key] !== 'critical') continue;
    const t = thresholds[key] || {};
    const value = readingValue(ev.currentReading, key);
    if (value === null) continue;
    const min = t.min !== null && t.min !== undefined ? Number(t.min) : null;
    const max = t.max !== null && t.max !== undefined ? Number(t.max) : null;
    const direction = min !== null && value < min ? 'low' : 'high';
    const unit = PARAM_UNITS[key];
    const safe = direction === 'low' ? `\u2265 ${min} ${unit}` : `\u2264 ${max} ${unit}`;
    out.push({
      key: `${row.pond_id}:${key}`,
      pondId: String(row.pond_id),
      pondName: row.pond_name,
      deviceName: row.device_name || null,
      parameter: key,
      label: PARAM_LABELS[key],
      unit,
      value,
      min,
      max,
      direction,
      message: `${PARAM_LABELS[key]} is critically ${direction}: ${value} ${unit} (safe ${safe})`,
      recordedAt: row.recorded_at,
    });
  }
  return out;
}

module.exports = {
  FIRST_READING_GRACE_SECONDS,
  STALE_READING_SECONDS,
  HYBRID_MAX_AGE_SECONDS,
  ALARM_MAX_READING_AGE_SECONDS,
  loadHybridByPond,
  PONDS_QUERY,
  getThresholds,
  timeAgo,
  evaluatePond,
  pondRowToJson,
  pondSnapshot,
  criticalAlarms,
  PARAM_KEYS,
};

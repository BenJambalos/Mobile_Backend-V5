const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { paramStatus, PARAM_UNITS, STATUS_RANK } = require('../utils/status');
const { STALE_READING_SECONDS } = require('../utils/pondState');
const { iso, formatTime, formatDateLong, formatDateTime, DISPLAY_TIMEZONE, DISPLAY_UTC_OFFSET, localSql } = require('../utils/time');

const router = express.Router();
router.use(requireAuth, requireFarm);

// Reports are per POND and read the readings that were taken in that pond
// (water_quality_readings.pond_id) - not "whatever the pond's current device
// recorded" - so moving a device never moves history with it. Also checks the
// pond is the caller's. Returns the pond id, or null.
async function ownedPondId(pondId, farmId) {
  const id = Number(pondId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [rows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [id, farmId]);
  return rows[0]?.pond_id || null;
}

async function getThresholds(farmId) {
  const [rows] = await pool.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [farmId]);
  const map = {};
  for (const r of rows) map[r.parameter] = { min: r.min_value, max: r.max_value };
  return map;
}

// Status of one reading row. Parameters with no value are 'unavailable' and are
// left out of the comparison; a row with NO usable value is 'stale', never 'normal'.
function paramStatuses(row, thresholds) {
  return {
    temp: paramStatus(row.temperature === null ? null : Number(row.temperature), thresholds.temperature?.min, thresholds.temperature?.max),
    ph: paramStatus(row.ph_level === null ? null : Number(row.ph_level), thresholds.ph?.min, thresholds.ph?.max),
    do: paramStatus(row.dissolved_oxygen === null ? null : Number(row.dissolved_oxygen), thresholds.dissolved_oxygen?.min, thresholds.dissolved_oxygen?.max),
    salinity: paramStatus(row.salinity === null ? null : Number(row.salinity), thresholds.salinity?.min, thresholds.salinity?.max),
  };
}

function rowStatus(row, thresholds) {
  const known = Object.values(paramStatuses(row, thresholds)).filter((x) => x !== 'unavailable');
  if (!known.length) return 'stale';
  if (known.includes('critical')) return 'critical';
  if (known.includes('warning')) return 'warning';
  return 'normal';
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const FORECAST_PARAMS = { temperature: 'temperature', dissolvedOxygen: 'dissolved_oxygen', ph: 'ph', salinity: 'salinity' };
const UNITS = { temperature: PARAM_UNITS.temperature, dissolvedOxygen: PARAM_UNITS.dissolved_oxygen, ph: PARAM_UNITS.ph, salinity: PARAM_UNITS.salinity };

// "10:00" (24 h) in the display zone, for the legacy `labels` array.
function hhmm(d) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: DISPLAY_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return parts;
}

// GET /api/reports/trend?pondId=1&hours=24
// Averages of the pond's readings for the "Overall Monitoring Trends" chart:
// HOURLY buckets for ranges up to 72 hours, DAILY buckets (display-zone days)
// beyond that. Anchored to the pond's most recent reading (rather than a
// calendar boundary) so it works both with continuous production data and with
// a demo dataset that isn't updating in real time; `rangeStart`, `rangeEnd`,
// `latestReadingAt` and `stale` say exactly which window is shown, so the app
// never presents old data as "the last 24 hours".
//
// Every point has a UTC timestamp (`timestamps`) so the app can label the time
// axis and the tooltip in the phone's own time. A bucket with no value for a
// parameter is `null` (a gap), never 0. `forecast` holds the newest stored
// forecast points (predicted, not measured) so the chart can draw them apart.
router.get('/reports/trend', async (req, res) => {
  const pondId = await ownedPondId(req.query.pondId, req.farmId);
  const empty = { labels: [], timestamps: [], temperature: [], dissolvedOxygen: [], ph: [], salinity: [], units: UNITS, timezone: DISPLAY_TIMEZONE, pointCount: 0, forecast: { timestamps: [], temperature: [], dissolvedOxygen: [], ph: [], salinity: [] }, thresholds: {}, stale: true, latestReadingAt: null, rangeStart: null, rangeEnd: null, bucket: 'hour' };
  if (!pondId) return res.json(empty);

  const hours = Math.min(Math.max(Math.floor(Number(req.query.hours)) || 24, 1), 24 * 90);
  const bucket = hours <= 72 ? 'hour' : 'day';
  const bucketKey = bucket === 'hour' ? "DATE_FORMAT(recorded_at, '%Y-%m-%d %H')" : `DATE_FORMAT(${localSql('recorded_at')}, '%Y-%m-%d')`;

  // MIN/MAX(recorded_at) are aggregates, so the query stays valid under MySQL 8's
  // default ONLY_FULL_GROUP_BY mode, which Railway's MySQL enforces.
  const [rows] = await pool.query(
    `SELECT ${bucketKey} AS bucket_key,
            MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at,
            ROUND(AVG(temperature), 2) AS avg_temp,
            ROUND(AVG(dissolved_oxygen), 2) AS avg_do,
            ROUND(AVG(ph_level), 2) AS avg_ph,
            ROUND(AVG(salinity), 2) AS avg_sal
     FROM water_quality_readings
     WHERE pond_id = ?
       AND recorded_at >= (SELECT MAX(recorded_at) FROM water_quality_readings WHERE pond_id = ?) - INTERVAL ? HOUR
     GROUP BY bucket_key
     ORDER BY first_at ASC`,
    [pondId, pondId, hours]
  );

  const nowMs = Date.now();
  const stamps = rows.map((r) => {
    if (bucket === 'hour') {
      // Hour-ENDING label (09:00-10:00 -> 10:00), the same convention as the
      // forecast. The hour still in progress is labelled by its latest reading.
      const [d, h] = String(r.bucket_key).split(' ');
      const [y, m, day] = d.split('-').map(Number);
      const hourEnd = new Date(Date.UTC(y, m - 1, day, Number(h)) + 3600 * 1000);
      return hourEnd.getTime() > nowMs ? new Date(r.last_at) : hourEnd;
    }
    // Daily bucket: local midnight of that day, as a UTC instant.
    return new Date(`${r.bucket_key}T00:00:00${DISPLAY_UTC_OFFSET}`);
  });

  const [[anchor]] = await pool.query('SELECT MAX(recorded_at) AS latest, TIMESTAMPDIFF(SECOND, MAX(recorded_at), NOW()) AS age_s FROM water_quality_readings WHERE pond_id = ?', [pondId]);
  const thresholds = await getThresholds(req.farmId);

  // Newest stored forecast per parameter (future points only). Optional table.
  const forecast = { timestamps: [], temperature: [], dissolvedOxygen: [], ph: [], salinity: [] };
  try {
    const times = new Set();
    const perParam = {};
    for (const [key, dbName] of Object.entries(FORECAST_PARAMS)) {
      const [f] = await pool.query(
        `SELECT forecast_value, predicted_for FROM water_quality_forecasts
         WHERE pond_id = ? AND parameter = ? AND predicted_for > NOW()
           AND created_at = (SELECT MAX(created_at) FROM water_quality_forecasts WHERE pond_id = ? AND parameter = ?)
         ORDER BY predicted_for ASC`,
        [pondId, dbName, pondId, dbName]
      );
      perParam[key] = new Map(f.filter((x) => x.forecast_value !== null && Number.isFinite(Number(x.forecast_value))).map((x) => [new Date(x.predicted_for).toISOString(), Number(x.forecast_value)]));
      for (const t of perParam[key].keys()) times.add(t);
    }
    forecast.timestamps = [...times].sort();
    for (const key of Object.keys(FORECAST_PARAMS)) forecast[key] = forecast.timestamps.map((t) => perParam[key].get(t) ?? null);
  } catch (err) {
    if (!(err && err.code === 'ER_NO_SUCH_TABLE')) throw err;
  }

  const th = {};
  for (const [key, dbName] of Object.entries(FORECAST_PARAMS)) {
    const t = thresholds[dbName];
    if (t) th[key] = { min: numOrNull(t.min), max: numOrNull(t.max) };
  }

  res.json({
    labels: stamps.map((d) => (bucket === 'hour' ? hhmm(d) : formatDateLong(d).replace(/, \d{4}$/, ''))),
    timestamps: stamps.map((d) => d.toISOString()),
    temperature: rows.map((r) => numOrNull(r.avg_temp)),
    dissolvedOxygen: rows.map((r) => numOrNull(r.avg_do)),
    ph: rows.map((r) => numOrNull(r.avg_ph)),
    salinity: rows.map((r) => numOrNull(r.avg_sal)),
    units: UNITS,
    timezone: DISPLAY_TIMEZONE,
    bucket,
    pointCount: rows.length,
    rangeHours: hours,
    rangeStart: rows.length ? iso(rows[0].first_at) : null,
    rangeEnd: rows.length ? iso(rows[rows.length - 1].last_at) : null,
    latestReadingAt: iso(anchor.latest),
    stale: anchor.age_s === null || Number(anchor.age_s) > STALE_READING_SECONDS,
    thresholds: th,
    forecast,
  });
});

// GET /api/reports/reading-logs?pondId=1&status=Normal&limit=50
// `date` and `time` are display-zone text; `recordedAt` is the exact UTC instant.
// A sensor that sent nothing is `null` (shown as a dash), never 0.
router.get('/reports/reading-logs', async (req, res) => {
  const pondId = await ownedPondId(req.query.pondId, req.farmId);
  if (!pondId) return res.json([]);
  const thresholds = await getThresholds(req.farmId);
  const limit = Math.min(Number(req.query.limit) || 50, 500);

  const [rows] = await pool.query(
    `SELECT temperature, ph_level, dissolved_oxygen, salinity, recorded_at
     FROM water_quality_readings WHERE pond_id = ? ORDER BY recorded_at DESC LIMIT ?`,
    [pondId, limit]
  );

  let logs = rows.map((r) => ({
    date: formatDateLong(r.recorded_at),
    time: formatTime(r.recorded_at),
    recordedAt: iso(r.recorded_at),
    temp: numOrNull(r.temperature),
    do: numOrNull(r.dissolved_oxygen),
    ph: numOrNull(r.ph_level),
    salinity: numOrNull(r.salinity),
    status: rowStatus(r, thresholds),
    statuses: paramStatuses(r, thresholds),
  }));

  if (req.query.status && req.query.status !== 'All') {
    logs = logs.filter((l) => l.status.toLowerCase() === String(req.query.status).toLowerCase());
  }
  res.json(logs);
});

// GET /api/reports/alert-logs?pondId=1&severity=Critical
router.get('/reports/alert-logs', async (req, res) => {
  const clauses = ['n.farm_id = ?'];
  const params = [req.farmId];
  if (req.query.pondId) { clauses.push('n.pond_id = ?'); params.push(req.query.pondId); }

  const [rows] = await pool.query(
    `SELECT n.*, p.pond_name FROM early_warning_notifications n
     LEFT JOIN ponds p ON p.pond_id = n.pond_id
     WHERE ${clauses.join(' AND ')} ORDER BY n.created_at DESC`,
    params
  );
  res.json(rows.map((r) => ({
    id: String(r.notification_id),
    title: r.title,
    pondName: r.pond_name,
    parameter: r.parameter || null,
    level: r.alert_level,
    message: r.alert_message,
    isResolved: !!r.is_resolved,
    createdAt: iso(r.created_at),
    time: formatDateTime(r.created_at),
  })));
});

// GET /api/reports/summary?pondId=1&period=weekly|monthly|daily
// This is the "use a query in reports to get the exact thing" endpoint:
// real AVG/MIN/MAX aggregation over water_quality_readings for the
// requested period, plus a compliance status per parameter and the
// incident log for that same window - matches the Report Detail / PDF
// preview screen field-for-field.
router.get('/reports/summary', async (req, res) => {
  const { pondId } = req.query;
  const period = req.query.period || 'weekly';
  const ownedPond = await ownedPondId(pondId, req.farmId);
  const thresholds = await getThresholds(req.farmId);

  const intervalSql = period === 'daily' ? 'INTERVAL 1 DAY' : period === 'monthly' ? 'INTERVAL 30 DAY' : 'INTERVAL 7 DAY';

  const [pondRows] = await pool.query('SELECT pond_name FROM ponds WHERE pond_id = ? AND farm_id = ?', [pondId, req.farmId]);
  if (!pondRows.length) return res.status(404).json({ error: 'Pond not found' });

  let aggregates = null;
  if (ownedPond) {
    const [rows] = await pool.query(
      `SELECT
          ROUND(AVG(temperature), 2) AS avg_temp, ROUND(MIN(temperature), 2) AS min_temp, ROUND(MAX(temperature), 2) AS max_temp,
          ROUND(AVG(ph_level), 2) AS avg_ph, ROUND(MIN(ph_level), 2) AS min_ph, ROUND(MAX(ph_level), 2) AS max_ph,
          ROUND(AVG(dissolved_oxygen), 2) AS avg_do, ROUND(MIN(dissolved_oxygen), 2) AS min_do, ROUND(MAX(dissolved_oxygen), 2) AS max_do,
          ROUND(AVG(salinity), 2) AS avg_sal, ROUND(MIN(salinity), 2) AS min_sal, ROUND(MAX(salinity), 2) AS max_sal,
          COUNT(*) AS reading_count, MIN(recorded_at) AS period_start, MAX(recorded_at) AS period_end
       FROM water_quality_readings
       WHERE pond_id = ?
         AND recorded_at >= (SELECT MAX(recorded_at) FROM water_quality_readings WHERE pond_id = ?) - ${intervalSql}`,
      [ownedPond, ownedPond]
    );
    aggregates = rows[0];
  }

  const [incidents] = await pool.query(
    `SELECT created_at, parameter, alert_message, alert_level FROM early_warning_notifications
     WHERE pond_id = ?
       AND created_at >= (SELECT COALESCE(MAX(recorded_at), NOW()) FROM water_quality_readings WHERE pond_id = ?) - ${intervalSql}
     ORDER BY created_at DESC`,
    [pondId, pondId]
  );

  // A parameter with no data in the period is 'stale' (no data), not 'offline':
  // offline describes a DEVICE, and not "normal" either.
  function row(label, key, avgKey, minKey, maxKey, unit) {
    if (!aggregates || aggregates[avgKey] === null) return { parameter: label, avg: '\u2014', min: '\u2014', max: '\u2014', status: 'stale' };
    const t = thresholds[key] || {};
    const status = paramStatus(Number(aggregates[avgKey]), t.min, t.max);
    const suffix = unit ? ` ${unit}` : '';
    return {
      parameter: label,
      avg: `${aggregates[avgKey]}${suffix}`,
      min: `${aggregates[minKey]}${suffix}`,
      max: `${aggregates[maxKey]}${suffix}`,
      status,
    };
  }

  res.json({
    pondName: pondRows[0].pond_name,
    period,
    periodStart: iso(aggregates?.period_start),
    periodEnd: iso(aggregates?.period_end),
    timezone: DISPLAY_TIMEZONE,
    readingCount: aggregates?.reading_count || 0,
    parameters: [
      row('Dissolved Oxygen (DO)', 'dissolved_oxygen', 'avg_do', 'min_do', 'max_do', 'mg/L'),
      row('Water Temperature', 'temperature', 'avg_temp', 'min_temp', 'max_temp', '\u00b0C'),
      row('pH Level', 'ph', 'avg_ph', 'min_ph', 'max_ph', ''),
      row('Salinity', 'salinity', 'avg_sal', 'min_sal', 'max_sal', 'ppt'),
    ],
    incidents: incidents.map((i) => ({
      timestamp: iso(i.created_at),
      time: formatDateTime(i.created_at),
      parameter: i.parameter,
      message: i.alert_message,
      level: i.alert_level,
    })),
  });
});

// GET /api/reports/list?pondId=1  - the 3 report cards (Weekly/Monthly/Daily).
// Computed from the current date rather than stored, since they're just
// "the last 7/30/1 day(s) as of now" - nothing to persist. Dates are
// calendar days in the display zone, not the server's.
router.get('/reports/list', async (req, res) => {
  const [pondRows] = await pool.query('SELECT pond_name FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.query.pondId, req.farmId]);
  const pondName = pondRows[0]?.pond_name || '';
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);

  res.json([
    { id: 'weekly', title: `Weekly Summary ${pondName}`, subtitle: `${formatDateLong(weekAgo)} \u2013 ${formatDateLong(now)}`, period: 'weekly' },
    { id: 'monthly', title: 'Monthly Summary', subtitle: formatDateLong(monthAgo), period: 'monthly' },
    { id: 'daily', title: 'Daily Summary', subtitle: formatDateLong(now), period: 'daily' },
  ]);
});

module.exports = router;

const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { progressFraction, PARAM_LABELS, PARAM_UNITS } = require('../utils/status');
const { PONDS_QUERY, getThresholds, evaluatePond, pondRowToJson, loadHybridByPond } = require('../utils/pondState');
const { iso, DISPLAY_TIMEZONE } = require('../utils/time');

const router = express.Router();
router.use(requireAuth, requireFarm);

// The "Pond Size" field's placeholder invites free text like "0.5
// hectare", but ponds.volume is a strict DECIMAL(10,2) column (per the
// schema). Passing non-numeric text straight into that column throws
// under MySQL/MariaDB's default strict SQL mode, which is exactly what
// was surfacing as a generic "Internal server error" — most visibly
// during onboarding, right before the device-assignment step, making it
// look like assignment itself was broken.
//
// Fix: extract the leading number from whatever was typed ("0.5
// hectare" -> 0.5, "1.2 ha" -> 1.2, "" or "abc" -> null) instead of
// crashing on it.
function parseDecimalOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const match = str.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// How a pond looks (status, online/offline, which reading) is decided in
// utils/pondState.js, shared with the alarm endpoint and the device-move reply.

// GET /api/ponds
router.get('/ponds', async (req, res) => {
  const thresholds = await getThresholds(req.farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' ORDER BY p.pond_id', [req.farmId]);
  const hybrid = await loadHybridByPond(req.farmId);
  res.json(rows.map((r) => pondRowToJson(r, thresholds, hybrid.get(r.pond_id) || null)));
});

// POST /api/ponds  { name, size }
router.post('/ponds', async (req, res) => {
  const { name, size } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const volume = parseDecimalOrNull(size);
  const [result] = await pool.query(
    'INSERT INTO ponds (farm_id, pond_name, volume) VALUES (?, ?, ?)',
    [req.farmId, name, volume]
  );
  res.status(201).json({ id: String(result.insertId), name, size: volume !== null ? String(volume) : '' });
});

// PUT /api/ponds/:id  { name, size }
router.put('/ponds/:id', async (req, res) => {
  const { name, size } = req.body;
  const volume = size === undefined ? null : parseDecimalOrNull(size);
  const [result] = await pool.query(
    'UPDATE ponds SET pond_name = COALESCE(?, pond_name), volume = COALESCE(?, volume) WHERE pond_id = ? AND farm_id = ?',
    [name, volume, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Pond not found' });
  res.json({ message: 'Pond updated.' });
});

// DELETE /api/ponds/:id
router.delete('/ponds/:id', async (req, res) => {
  const [result] = await pool.query('DELETE FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.params.id, req.farmId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Pond not found' });
  res.json({ message: 'Pond removed.' });
});

// GET /api/ponds/:id  — full detail for the Pond Detail "Current" tab
router.get('/ponds/:id', async (req, res) => {
  const thresholds = await getThresholds(req.farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' AND p.pond_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Pond not found' });
  const row = rows[0];
  const hybridEntry = (await loadHybridByPond(req.farmId)).get(row.pond_id) || null;
  const base = pondRowToJson(row, thresholds, hybridEntry);
  const ev = evaluatePond(row, thresholds, hybridEntry);
  const reading = ev.shownReading;

  const parameters = ['temperature', 'ph', 'dissolved_oxygen', 'salinity'].map((key) => {
    const t = thresholds[key] || {};
    const raw = reading ? (key === 'ph' ? reading.ph_level : reading[key]) : null;
    const value = raw === undefined ? null : raw;
    return {
      key,
      label: PARAM_LABELS[key],
      unit: PARAM_UNITS[key],
      value,
      min: t.min ?? null,
      max: t.max ?? null,
      // Never default to 'normal': with no judgement available the parameter
      // takes the pond's own state (offline / stale), or 'unavailable' when the
      // pond is judged but this one sensor sent no value.
      status: ev.byParameter[key] || (ev.status === 'offline' || ev.status === 'stale' ? ev.status : 'unavailable'),
      progress: value !== null ? progressFraction(value, t.min, t.max) : 0,
    };
  });

  res.json({ ...base, parameters, deviceOnline: ev.online });
});

// GET /api/ponds/:id/forecast?parameter=ph|dissolved_oxygen|temperature|salinity
//
// Returns the last 24 hours of HOURLY averages (actual readings) and the newest
// stored forecast batch (predicted hourly averages), each with its timestamp
// (UTC, ISO-8601), so the app can label the time axis and show a tooltip.
// `status` says why a series is empty instead of letting the app guess:
//   ok            history and forecast available
//   no_forecast   history exists but the ML service has no current forecast
//                 (it needs about 72 hours of continuous readings first)
//   no_history    the pond has no readings for this parameter
router.get('/ponds/:id/forecast', async (req, res) => {
  const parameter = req.query.parameter || 'dissolved_oxygen';
  const COLUMNS = { temperature: 'temperature', ph: 'ph_level', dissolved_oxygen: 'dissolved_oxygen', salinity: 'salinity' };
  const column = COLUMNS[parameter];
  if (!column) return res.status(400).json({ error: 'Unknown parameter' });

  // History comes from the pond itself (readings carry their pond_id), so it
  // is the same series whichever device produced it. The pond must be the
  // caller's, otherwise this would leak another farm's readings.
  const [pondRows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.params.id, req.farmId]);
  if (!pondRows.length) return res.status(404).json({ error: 'Pond not found' });
  const pondId = pondRows[0].pond_id;

  // Hourly averages, labelled by the END of each hour (the same convention the
  // ML forecast uses: a point at 14:00 is the average of 13:00-14:00). The hour
  // still in progress is labelled with its latest reading's time instead.
  // `column` comes from the fixed COLUMNS map above, never from user input.
  const [hourly] = await pool.query(
    `SELECT AVG(${column}) AS value,
            MIN(recorded_at) AS bucket_start,
            MAX(recorded_at) AS last_at
     FROM water_quality_readings
     WHERE pond_id = ? AND recorded_at >= (NOW() - INTERVAL 24 HOUR) AND ${column} IS NOT NULL
     GROUP BY DATE_FORMAT(recorded_at, '%Y-%m-%d %H')
     ORDER BY bucket_start ASC`,
    [pondId]
  );
  const nowMs = Date.now();
  let historical = [];
  let historicalTimestamps = [];
  if (hourly.length >= 3) {
    for (const r of hourly) {
      const start = new Date(r.bucket_start);
      const hourStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours()));
      const hourEnd = new Date(hourStart.getTime() + 3600 * 1000);
      const label = hourEnd.getTime() > nowMs ? new Date(r.last_at) : hourEnd;
      historical.push(Math.round(Number(r.value) * 100) / 100);
      historicalTimestamps.push(label.toISOString());
    }
  } else {
    // Fewer than 3 hours of data: show the latest raw readings instead of nothing.
    const [raw] = await pool.query(
      `SELECT ${column} AS value, recorded_at FROM water_quality_readings
       WHERE pond_id = ? AND ${column} IS NOT NULL ORDER BY recorded_at DESC LIMIT 24`,
      [pondId]
    );
    raw.reverse();
    historical = raw.map((r) => Number(r.value));
    historicalTimestamps = raw.map((r) => iso(r.recorded_at));
  }

  // Only the NEWEST forecast batch (rows sharing the latest created_at for this
  // pond + parameter) and only its future points. Older batches, and the sample
  // forecasts from seed_data.sql, stay in the table but are never mixed in.
  const [forecastRows] = await pool.query(
    `SELECT forecast_value, predicted_for, created_at FROM water_quality_forecasts
     WHERE pond_id = ? AND parameter = ? AND predicted_for > NOW()
       AND created_at = (SELECT MAX(created_at) FROM water_quality_forecasts WHERE pond_id = ? AND parameter = ?)
     ORDER BY predicted_for ASC`,
    [pondId, parameter, pondId, parameter]
  );
  // Never pass NaN/NULL values on to a chart.
  const valid = forecastRows.filter((r) => r.forecast_value !== null && Number.isFinite(Number(r.forecast_value)));

  let status = 'ok';
  if (!historical.length) status = 'no_history';
  else if (!valid.length) status = 'no_forecast';

  res.json({
    parameter,
    unit: PARAM_UNITS[parameter] ?? '',
    status,
    historical,
    historicalTimestamps,
    forecast: valid.map((r) => Number(r.forecast_value)),
    predictedForTimestamps: valid.map((r) => iso(r.predicted_for)),
    generatedAt: valid.length ? iso(valid[0].created_at) : null,
    timezone: DISPLAY_TIMEZONE,
  });
});

module.exports = router;

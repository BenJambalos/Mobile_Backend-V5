const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');

// Read-only access to what the Python ML service has already saved in
// `risk_classification_results` (and the hybrid alert it may have raised).
// Nothing here runs a model or calls the ML service: the app reads saved
// rows, exactly like it reads readings and forecasts.
//
// Authorization: the farm comes from the signed JWT (req.farmId), never from
// the request. Every query is also filtered by farm_id, so a pond id that
// belongs to another farm behaves exactly like one that doesn't exist (404).

const router = express.Router();
router.use(requireAuth, requireFarm);

// A result older than this is flagged `stale` so the app can say "last
// updated X min ago" instead of presenting it as current. The ML service
// runs every 15 minutes while readings are arriving.
const STALE_AFTER_MINUTES = 45;

const DISCLAIMER =
  'Risk classes are statistical early-warning estimates from current readings. ' +
  'They are not a prediction that shrimp will die and are not a mortality percentage.';

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value; // MySQL returns JSON columns already parsed
  try { return JSON.parse(value); } catch { return null; } // MariaDB returns text
}

function num(value) {
  return value === null || value === undefined ? null : Number(value);
}

function resultToJson(row, activeWarning) {
  const details = parseJson(row.details_json) || {};
  const ageMinutes = row.age_minutes === null || row.age_minutes === undefined ? null : Number(row.age_minutes);
  return {
    available: true,
    pondId: String(row.pond_id),
    resultId: Number(row.result_id),
    sourceReadingId: Number(row.source_reading_id),
    riskClass: row.risk_class,                       // 'Low' | 'Moderate' | 'High'
    riskLevel: String(row.risk_class).toLowerCase(),
    probabilities: {
      Low: num(row.prob_low),
      Moderate: num(row.prob_moderate),
      High: num(row.prob_high),
    },
    waterQualityCondition: row.water_quality_condition, // 'Normal' | 'Abnormal'
    forecastTrend: row.forecast_trend,                 // null when no forecast was available
    trendAvailable: row.forecast_trend !== null,
    hybridStatus: row.hybrid_status,                   // 'Normal' | 'Warning' | 'Critical'
    parameterStatuses: details.parameters || null,     // { dissolved_oxygen: {value, status}, ... }
    parameterTrends: details.parameter_trends || null,
    trendNote: details.trend_note || null,
    readingRecordedAt: row.reading_recorded_at,
    calculatedAt: row.calculated_at,
    ageMinutes,
    stale: ageMinutes !== null && ageMinutes > STALE_AFTER_MINUTES,
    recommendedAction: activeWarning ? activeWarning.recommended_action : null,
    activeWarning: activeWarning
      ? {
          id: String(activeWarning.notification_id),
          severity: activeWarning.alert_level === 'critical' ? 'critical' : 'warning',
          alertLevel: activeWarning.alert_level,
          title: activeWarning.title,
          message: activeWarning.alert_message,
          recommendedAction: activeWarning.recommended_action,
          createdAt: activeWarning.created_at,
        }
      : null,
    disclaimer: DISCLAIMER,
  };
}

const RESULT_COLUMNS = `r.result_id, r.pond_id, r.source_reading_id, r.reading_recorded_at, r.risk_class,
       r.prob_low, r.prob_moderate, r.prob_high, r.water_quality_condition, r.forecast_trend,
       r.hybrid_status, r.details_json, r.calculated_at,
       TIMESTAMPDIFF(MINUTE, r.calculated_at, NOW()) AS age_minutes`;

// GET /api/ponds/:id/risk  - newest saved result for one pond
router.get('/ponds/:id/risk', async (req, res) => {
  const [ponds] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [
    req.params.id,
    req.farmId,
  ]);
  if (!ponds.length) return res.status(404).json({ error: 'Pond not found' });
  const pondId = ponds[0].pond_id;

  const [rows] = await pool.query(
    `SELECT ${RESULT_COLUMNS}
     FROM risk_classification_results r
     WHERE r.pond_id = ? AND r.farm_id = ?
     ORDER BY r.reading_recorded_at DESC, r.result_id DESC
     LIMIT 1`,
    [pondId, req.farmId]
  );
  if (!rows.length) {
    // Normal for a new pond: the ML service has not classified a reading yet.
    return res.json({ available: false, pondId: String(pondId), reason: 'no_result_yet', disclaimer: DISCLAIMER });
  }

  const [warnings] = await pool.query(
    `SELECT notification_id, alert_level, title, alert_message, recommended_action, created_at
     FROM early_warning_notifications
     WHERE pond_id = ? AND farm_id = ? AND source = 'hybrid_ml' AND is_resolved = 0
     ORDER BY notification_id DESC LIMIT 1`,
    [pondId, req.farmId]
  );
  res.json(resultToJson(rows[0], warnings[0] || null));
});

// GET /api/risk/latest  - newest saved result for every pond of the farm
// (one query; for dashboards / pond lists). Keyed by pond id.
router.get('/risk/latest', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ${RESULT_COLUMNS}
     FROM risk_classification_results r
     JOIN (
       SELECT pond_id, MAX(result_id) AS newest
       FROM risk_classification_results
       WHERE farm_id = ?
       GROUP BY pond_id
     ) m ON m.newest = r.result_id
     WHERE r.farm_id = ?`,
    [req.farmId, req.farmId]
  );
  const [warnings] = await pool.query(
    `SELECT notification_id, pond_id, alert_level, title, alert_message, recommended_action, created_at
     FROM early_warning_notifications
     WHERE farm_id = ? AND source = 'hybrid_ml' AND is_resolved = 0
     ORDER BY notification_id ASC`,
    [req.farmId]
  );
  const latestWarning = new Map(warnings.map((w) => [w.pond_id, w])); // later rows overwrite earlier ones
  const ponds = {};
  for (const row of rows) ponds[String(row.pond_id)] = resultToJson(row, latestWarning.get(row.pond_id) || null);
  res.json({ ponds, disclaimer: DISCLAIMER });
});

module.exports = router;

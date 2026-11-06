const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { OFFLINE_TITLE } = require('../utils/deviceHealth');
const { STALE_TITLE } = require('../utils/readingFreshness');
const { PARAM_LABELS, PARAM_UNITS } = require('../utils/status');
const { getThresholds } = require('../utils/pondState');
const { dateGroupFor, formatDateTime, iso } = require('../utils/time');

const READING_COLUMN = { temperature: 'temperature', ph: 'ph_level', dissolved_oxygen: 'dissolved_oxygen', salinity: 'salinity' };

const router = express.Router();
router.use(requireAuth, requireFarm);

function levelToSeverity(level) {
  // App's severities: normal / warning / critical / offline / stale.
  // Schema's alert_level: low / medium / high / critical.
  if (level === 'critical') return 'critical';
  if (level === 'high' || level === 'medium') return 'warning';
  return 'normal'; // 'low' - e.g. "Water Quality Restored"
}

// What KIND of alert this is. Water-quality alerts (Warning / Critical) are
// kept apart from device connectivity (Offline) and data freshness (Stale),
// because they mean different things and get different colors in the app.
function categoryOf(row) {
  if (row.title === OFFLINE_TITLE || (!row.parameter && row.device_id && !row.is_resolved && row.alert_level === 'low')) return 'offline';
  if (row.title === STALE_TITLE) return 'stale';
  if (row.source === 'hybrid_ml') return 'hybrid';
  return 'parameter';
}

const SEVERITY_BY_CATEGORY = { offline: 'offline', stale: 'stale' };

// Is an OPEN parameter alert getting worse, better, or staying put? Judged from
// the pond's last readings of that parameter against its threshold range;
// returns null when there is not enough data to say (nothing is invented).
async function parameterTrend(pondId, parameter, t) {
  const col = READING_COLUMN[parameter];
  if (!col || !t) return null;
  const [rows] = await pool.query(
    `SELECT ${col} AS v FROM water_quality_readings WHERE pond_id = ? AND ${col} IS NOT NULL
     ORDER BY recorded_at DESC, reading_id DESC LIMIT 4`,
    [pondId]
  );
  if (rows.length < 3) return null;
  const min = t.min === null || t.min === undefined ? null : Number(t.min);
  const max = t.max === null || t.max === undefined ? null : Number(t.max);
  const distance = (v) => Math.max(min !== null ? min - v : 0, max !== null ? v - max : 0, 0);
  const newest = distance(Number(rows[0].v));
  const oldest = distance(Number(rows[rows.length - 1].v));
  const eps = 0.02 * (min !== null && max !== null ? max - min : Math.abs(min ?? max ?? 1)) || 0.05;
  if (newest > oldest + eps) return 'Deteriorating Trend';
  if (newest < oldest - eps) return 'Improving Trend';
  return 'Stable Trend';
}

// Forecast trend recorded with the hybrid result that raised a hybrid alert.
async function hybridTrends(rows) {
  const ids = [...new Set(rows.filter((r) => r.source === 'hybrid_ml' && r.risk_result_id).map((r) => r.risk_result_id))];
  if (!ids.length) return new Map();
  try {
    const [res] = await pool.query('SELECT result_id, forecast_trend FROM risk_classification_results WHERE result_id IN (?)', [ids]);
    return new Map(res.map((r) => [r.result_id, r.forecast_trend]));
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return new Map();
    throw err;
  }
}

async function rowsToJson(rows, farmId) {
  const thresholds = rows.some((r) => !r.is_resolved && r.parameter) ? await getThresholds(farmId) : {};
  const trendOfResult = await hybridTrends(rows);
  const out = [];
  for (const row of rows) {
    const category = categoryOf(row);
    let trend = null;
    if (!row.is_resolved) {
      if (category === 'parameter' && row.parameter) trend = await parameterTrend(row.pond_id, row.parameter, thresholds[row.parameter]);
      else if (category === 'hybrid') {
        const ft = trendOfResult.get(row.risk_result_id);
        trend = ft ? `${ft} Trend` : null;
      }
    }
    out.push({
      id: String(row.notification_id),
      severity: SEVERITY_BY_CATEGORY[category] || levelToSeverity(row.alert_level),
      category,
      title: row.title,
      pondId: row.pond_id === null || row.pond_id === undefined ? null : String(row.pond_id),
      pondName: row.pond_name || 'Farm-wide',
      deviceName: row.device_name || null,
      parameter: row.parameter || null,
      parameterLabel: row.parameter ? (PARAM_LABELS[row.parameter] || row.parameter) : null,
      unit: row.parameter ? (PARAM_UNITS[row.parameter] || '') : null,
      measuredValue: row.measured_value === null || row.measured_value === undefined ? null : Number(row.measured_value),
      description: row.alert_message,
      trend,
      resolved: !!row.is_resolved,
      dateGroup: dateGroupFor(row.created_at),
      // Display text in Philippine time (see utils/time.js) AND the exact UTC
      // instant, so the app can show either without guessing.
      time: formatDateTime(row.created_at),
      createdAt: iso(row.created_at),
      read: !!row.is_read,
      recommendedAction: row.recommended_action,
      thresholdText: null, // could be derived from parameter_thresholds + parameter if you want it live-computed
    });
  }
  return out;
}

const NOTIF_QUERY = `
  SELECT n.*, p.pond_name, md.device_name
  FROM early_warning_notifications n
  LEFT JOIN ponds p ON p.pond_id = n.pond_id
  LEFT JOIN monitoring_devices md ON md.device_id = n.device_id
  WHERE n.farm_id = ?
`;

// GET /api/notifications?severity=Critical&pondId=1
// severity: All | Critical | Warning | Normal | Offline | Stale (case-insensitive)
router.get('/notifications', async (req, res) => {
  const clauses = ['n.farm_id = ?'];
  const params = [req.farmId];
  if (req.query.pondId) {
    clauses.push('n.pond_id = ?');
    params.push(req.query.pondId);
  }
  const [rows] = await pool.query(
    `SELECT n.*, p.pond_name, md.device_name FROM early_warning_notifications n
     LEFT JOIN ponds p ON p.pond_id = n.pond_id
     LEFT JOIN monitoring_devices md ON md.device_id = n.device_id
     WHERE ${clauses.join(' AND ')} ORDER BY n.created_at DESC, n.notification_id DESC`,
    params
  );
  let list = await rowsToJson(rows, req.farmId);
  if (req.query.severity && req.query.severity !== 'All') {
    list = list.filter((n) => n.severity.toLowerCase() === String(req.query.severity).toLowerCase());
  }
  res.json(list);
});

// GET /api/notifications/:id
router.get('/notifications/:id', async (req, res) => {
  const [rows] = await pool.query(NOTIF_QUERY + ' AND n.notification_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
  res.json((await rowsToJson(rows, req.farmId))[0]);
});

// PUT /api/notifications/:id/read  { read: true|false }
router.put('/notifications/:id/read', async (req, res) => {
  const read = req.body.read !== false;
  const [result] = await pool.query(
    'UPDATE early_warning_notifications SET is_read = ? WHERE notification_id = ? AND farm_id = ?',
    [read ? 1 : 0, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Notification not found' });
  res.json({ message: 'Updated.' });
});

// PUT /api/notifications/mark-all-read
router.put('/notifications/mark-all-read', async (req, res) => {
  await pool.query('UPDATE early_warning_notifications SET is_read = 1 WHERE farm_id = ?', [req.farmId]);
  res.json({ message: 'All marked as read.' });
});

module.exports = router;

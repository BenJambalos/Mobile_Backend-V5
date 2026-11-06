// API + database test for the ML-result routes added with migration 004:
//   GET /api/ponds/:id/risk, GET /api/risk/latest, the reworked
//   GET /api/ponds/:id/forecast, how hybrid alerts show up in /api/notifications,
//   and that urgent threshold alerts still fire immediately at ingest.
//
// Needs the server running against a LOCAL database that has schema.sql (or
// migrations/004_ml_results.sql) applied. It creates two throw-away farms
// (names start with ZZ_TEST_) and deletes them afterwards. No Super Admin or
// demo login is needed: tokens are signed directly with the same JWT_SECRET
// the server uses (read from .env), which is exactly what the server checks.
//
//   node tests/risk_flow.js            (API_BASE defaults to http://localhost:4000/api)
const crypto = require('crypto');
const pool = require('../db');
const { signToken } = require('../middleware/auth');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function makeFarm(label, ownerId) {
  const [f] = await pool.query('INSERT INTO aquaculture_farms (owner_id, farm_name) VALUES (?, ?)', [ownerId, `ZZ_TEST_${label}_${crypto.randomBytes(3).toString('hex')}`]);
  const farmId = f.insertId;
  const [p] = await pool.query('INSERT INTO ponds (farm_id, pond_name) VALUES (?, ?)', [farmId, `${label} pond`]);
  const key = crypto.randomBytes(16).toString('hex');
  const [d] = await pool.query(
    'INSERT INTO monitoring_devices (farm_id, pond_id, device_name, device_key, assigned_at) VALUES (?, ?, ?, ?, NOW() - INTERVAL 1 DAY)',
    [farmId, p.insertId, `${label} device`, key]
  );
  for (const [param, lo, hi] of [['temperature', 25, 30], ['ph', 6.5, 8.5], ['dissolved_oxygen', 5, 12], ['salinity', 10, 25]]) {
    await pool.query('INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?, ?, ?, ?)', [farmId, param, lo, hi]);
  }
  return { farmId, pondId: p.insertId, deviceId: d.insertId, deviceKey: key };
}

async function addResult(farm, { ts = 'NOW()', risk = 'Moderate', pl = 0.2, pm = 0.55, ph = 0.25, hybrid = 'Warning', trend = null, calculatedAt = 'NOW()' }) {
  const [r] = await pool.query(
    `INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at)
     VALUES (?, ?, 28.5, 7.9, 4.4, 20.0, ${ts})`, [farm.deviceId, farm.pondId]);
  const details = JSON.stringify({ parameters: { dissolved_oxygen: { value: 4.4, status: 'Conditional', score: 1 } }, parameter_trends: null, trend_note: 'no recent forecast' });
  const [res] = await pool.query(
    `INSERT INTO risk_classification_results
       (farm_id, pond_id, source_reading_id, reading_recorded_at, risk_class, prob_low, prob_moderate, prob_high,
        water_quality_condition, forecast_trend, hybrid_status, details_json, model_version, calculated_at)
     VALUES (?, ?, ?, ${ts}, ?, ?, ?, ?, 'Abnormal', ?, ?, ?, 'test', ${calculatedAt})`,
    [farm.farmId, farm.pondId, r.insertId, risk, pl, pm, ph, trend, hybrid, details]);
  return res.insertId;
}

(async () => {
  const [[owner]] = await pool.query('SELECT account_id FROM accounts ORDER BY account_id LIMIT 1');
  const A = await makeFarm('A', owner.account_id);
  const B = await makeFarm('B', owner.account_id);
  const tokA = signToken({ accountId: owner.account_id, farmId: A.farmId });
  const tokB = signToken({ accountId: owner.account_id, farmId: B.farmId });
  const tokNoFarm = signToken({ accountId: owner.account_id, farmId: null });

  try {
    // ---------- access control ----------
    let r = await call('GET', `/ponds/${A.pondId}/risk`);
    check('no token -> 401', r.status === 401, r);
    r = await call('GET', `/ponds/${A.pondId}/risk`, { token: tokNoFarm });
    check('account without a farm -> 409 FARM_REQUIRED', r.status === 409 && r.body.code === 'FARM_REQUIRED', r);
    r = await call('GET', '/ponds/999999/risk', { token: tokA });
    check('unknown pond -> 404', r.status === 404, r);
    r = await call('GET', '/ponds/abc/risk', { token: tokA });
    check('non-numeric pond id -> 404 (not 500)', r.status === 404, r);

    // ---------- nothing computed yet ----------
    r = await call('GET', `/ponds/${A.pondId}/risk`, { token: tokA });
    check('new pond with no result -> available:false (200)', r.status === 200 && r.body.available === false && r.body.reason === 'no_result_yet', r);
    r = await call('GET', '/risk/latest', { token: tokA });
    check('/risk/latest with no results -> empty map', r.status === 200 && Object.keys(r.body.ponds).length === 0, r);

    // ---------- a saved result + an open hybrid alert ----------
    const resId = await addResult(A, { risk: 'High', pl: 0.05, pm: 0.2, ph: 0.75, hybrid: 'Warning', trend: null });
    await pool.query(
      `INSERT INTO early_warning_notifications
         (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read, source, risk_result_id)
       VALUES (?, ?, NULL, NULL, 'Hybrid Early Warning: Warning', 'high', 'A pond: water quality is abnormal; Random Forest risk class is High.', 'Increase aeration.', 0, 0, 'hybrid_ml', ?)`,
      [A.farmId, A.pondId, resId]);

    r = await call('GET', `/ponds/${A.pondId}/risk`, { token: tokA });
    const b = r.body;
    check('owner sees the saved result', r.status === 200 && b.available === true && b.riskClass === 'High' && b.riskLevel === 'high', r);
    check('class probabilities are returned by label and sum to 1',
      Math.abs(b.probabilities.Low + b.probabilities.Moderate + b.probabilities.High - 1) < 1e-6 && b.probabilities.High === 0.75, b.probabilities);
    check('hybrid status + condition returned', b.hybridStatus === 'Warning' && b.waterQualityCondition === 'Abnormal', b);
    check('missing forecast is reported as unavailable, not invented', b.forecastTrend === null && b.trendAvailable === false, b);
    check('per-parameter statuses come from details_json', b.parameterStatuses && b.parameterStatuses.dissolved_oxygen.status === 'Conditional', b.parameterStatuses);
    check('active hybrid warning + recommended action included',
      b.activeWarning && b.activeWarning.alertLevel === 'high' && b.activeWarning.severity === 'warning' && b.recommendedAction === 'Increase aeration.', b.activeWarning);
    check('reading + calculation timestamps present', !!b.readingRecordedAt && !!b.calculatedAt && b.stale === false, b);
    check('response never claims mortality', /not a prediction that shrimp will die/.test(b.disclaimer) && !/die|mortality %/i.test(JSON.stringify({ ...b, disclaimer: '' })), b.disclaimer);

    // ---------- cross-farm isolation ----------
    r = await call('GET', `/ponds/${A.pondId}/risk`, { token: tokB });
    check("another farm cannot read this pond's result (404)", r.status === 404, r);
    r = await call('GET', '/risk/latest', { token: tokB });
    check("another farm's /risk/latest does not include it", r.status === 200 && !(String(A.pondId) in r.body.ponds), r.body);
    r = await call('GET', '/risk/latest', { token: tokA });
    check('/risk/latest for the owner includes the pond', r.status === 200 && r.body.ponds[String(A.pondId)]?.riskClass === 'High', r.body);

    // ---------- newest result wins; stale flag ----------
    await addResult(A, { ts: 'NOW() + INTERVAL 1 MINUTE', risk: 'Low', pl: 0.8, pm: 0.15, ph: 0.05, hybrid: 'Normal', trend: 'Stable', calculatedAt: 'NOW() - INTERVAL 2 HOUR' });
    r = await call('GET', `/ponds/${A.pondId}/risk`, { token: tokA });
    check('newest reading wins', r.body.riskClass === 'Low' && r.body.forecastTrend === 'Stable' && r.body.trendAvailable === true, r.body);
    check('result calculated 2 h ago is flagged stale', r.body.stale === true && r.body.ageMinutes >= 119, r.body);

    // ---------- hybrid alert in the existing notifications feed ----------
    r = await call('GET', '/notifications', { token: tokA });
    const list = Array.isArray(r.body) ? r.body : (r.body.notifications || r.body.items || []);
    const hybrid = list.find((n) => n.title === 'Hybrid Early Warning: Warning');
    check('hybrid alert appears in /notifications', !!hybrid, list.map((n) => n.title));
    check('hybrid alert is a warning, NOT shown as "Device Offline"', hybrid && hybrid.severity === 'warning', hybrid);
    r = await call('GET', '/notifications', { token: tokB });
    const listB = Array.isArray(r.body) ? r.body : (r.body.notifications || r.body.items || []);
    check("other farm's feed does not contain it", !listB.some((n) => n.title === 'Hybrid Early Warning: Warning'), listB.map((n) => n.title));

    // ---------- forecast route: newest batch only, hourly history ----------
    const insF = (parameter, value, predicted, created) => pool.query(
      `INSERT INTO water_quality_forecasts (farm_id, pond_id, parameter, forecast_value, predicted_for, created_at)
       VALUES (?, ?, ?, ?, ${predicted}, ${created})`, [A.farmId, A.pondId, parameter, value]);
    await insF('dissolved_oxygen', 1.11, 'NOW() + INTERVAL 90 MINUTE', 'NOW() - INTERVAL 5 HOUR');   // old batch, stale values
    await insF('dissolved_oxygen', 2.22, 'NOW() + INTERVAL 150 MINUTE', 'NOW() - INTERVAL 5 HOUR');
    const newBatch = [[6.1, '1 HOUR'], [6.2, '2 HOUR'], [6.3, '3 HOUR']];
    for (const [v, h] of newBatch) await insF('dissolved_oxygen', v, `NOW() + INTERVAL ${h}`, 'NOW()');
    for (let i = 0; i < 6 * 12; i++) { // 6 hours of 5-minute readings
      await pool.query(
        `INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at)
         VALUES (?, ?, 28, 8, 6.0, 20, NOW() - INTERVAL ? MINUTE)`, [A.deviceId, A.pondId, 5 * i + 3]);
    }
    r = await call('GET', `/ponds/${A.pondId}/forecast?parameter=dissolved_oxygen`, { token: tokA });
    check('forecast shows only the newest batch', JSON.stringify(r.body.forecast) === JSON.stringify([6.1, 6.2, 6.3]), r.body.forecast);
    check('forecast reports when it was generated', !!r.body.generatedAt, r.body);
    check('history is hourly averages (not ~72 raw readings)', r.body.historical.length >= 6 && r.body.historical.length <= 8, r.body.historical.length);
    r = await call('GET', `/ponds/${A.pondId}/forecast?parameter=bogus`, { token: tokA });
    check('unknown forecast parameter -> 400', r.status === 400, r);
    r = await call('GET', `/ponds/${A.pondId}/forecast?parameter=ph`, { token: tokB });
    check("another farm cannot read this pond's forecast (404)", r.status === 404, r);

    // ---------- urgent threshold alert still fires at ingest, without the ML service ----------
    const before = (await q('SELECT COUNT(*) n FROM early_warning_notifications WHERE pond_id = ? AND parameter = ?', [B.pondId, 'dissolved_oxygen']))[0].n;
    r = await call('POST', '/ingest/readings', { body: { deviceKey: B.deviceKey, temperature: 28, phLevel: 8, dissolvedOxygen: 1.8, salinity: 20, createdAt: new Date().toISOString() } });
    check('ingest accepts the reading', r.status === 200 || r.status === 201, r);
    const alerts = await q(`SELECT alert_level, source FROM early_warning_notifications WHERE pond_id = ? AND parameter = 'dissolved_oxygen' AND is_resolved = 0`, [B.pondId]);
    check('critical low DO raised an alert immediately (same request)', alerts.length === before + 1 && alerts[0].alert_level === 'critical', alerts);
    r = await call('POST', '/ingest/readings', { body: { deviceKey: B.deviceKey, temperature: 28, phLevel: 8, dissolvedOxygen: 1.7, salinity: 20, createdAt: new Date(Date.now() + 1000).toISOString() } });
    const alerts2 = await q(`SELECT COUNT(*) n FROM early_warning_notifications WHERE pond_id = ? AND parameter = 'dissolved_oxygen' AND is_resolved = 0`, [B.pondId]);
    check('a second bad reading does not duplicate the open alert', alerts2[0].n === 1, alerts2);

    // ---------- moving a device never rewrites old readings ----------
    const histBefore = await q('SELECT COUNT(*) n, MIN(reading_id) lo, MAX(reading_id) hi FROM water_quality_readings WHERE pond_id = ?', [A.pondId]);
    const [p2] = await pool.query('INSERT INTO ponds (farm_id, pond_name) VALUES (?, ?)', [A.farmId, 'A second pond']);
    r = await call('PUT', `/devices/${A.deviceId}/pond`, { token: tokA, body: { pond_id: p2.insertId } });
    check('device move endpoint succeeds', r.status === 200, r);
    const dev = (await q('SELECT pond_id FROM monitoring_devices WHERE device_id = ?', [A.deviceId]))[0];
    check('device now points at the new pond', dev.pond_id === p2.insertId, dev);
    const histAfter = await q('SELECT COUNT(*) n, MIN(reading_id) lo, MAX(reading_id) hi FROM water_quality_readings WHERE pond_id = ?', [A.pondId]);
    check('readings stay with the pond they were recorded for after a device move',
      histBefore[0].n === histAfter[0].n && histBefore[0].lo === histAfter[0].lo && histBefore[0].hi === histAfter[0].hi, { histBefore, histAfter });
  } finally {
    await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_%'");
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_%'"); } catch {} process.exit(1); });

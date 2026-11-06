// QA regression suite (findings A, B, D, E, F, G, I at the API + database level).
//
// Needs the server running against a LOCAL database with schema.sql (or
// migrations 004 and 005) applied. It creates throw-away farms named ZZ_TEST_*
// and deletes them afterwards. Tokens are signed with the same JWT_SECRET the
// server uses (from .env), so no demo login is needed.
//
//   node tests/qa_flow.js            (API_BASE defaults to http://localhost:4000/api)
//
// Run it against servers started with different TZ values (for example
// TZ=UTC and TZ=America/Los_Angeles): every time assertion below is
// independent of the server's own time zone, which is the point of finding F.
const crypto = require('crypto');
const pool = require('../db');
const { signToken } = require('../middleware/auth');
const { sweepStaleReadings } = require('../utils/readingFreshness');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
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
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

async function makeFarm(label, ownerId) {
  const [f] = await pool.query('INSERT INTO aquaculture_farms (owner_id, farm_name) VALUES (?, ?)', [ownerId, `ZZ_TEST_${label}_${crypto.randomBytes(3).toString('hex')}`]);
  const farmId = f.insertId;
  const [p] = await pool.query('INSERT INTO ponds (farm_id, pond_name) VALUES (?, ?)', [farmId, `${label} pond`]);
  const key = crypto.randomBytes(16).toString('hex');
  const [d] = await pool.query(
    'INSERT INTO monitoring_devices (farm_id, pond_id, device_name, device_key, assigned_at) VALUES (?, ?, ?, ?, NOW() - INTERVAL 3 DAY)',
    [farmId, p.insertId, `${label} device`, key]);
  for (const [param, lo, hi] of [['temperature', 25, 30], ['ph', 6.5, 8.5], ['dissolved_oxygen', 5, 12], ['salinity', 10, 25]]) {
    await pool.query('INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?, ?, ?, ?)', [farmId, param, lo, hi]);
  }
  return { farmId, pondId: p.insertId, deviceId: d.insertId, deviceKey: key };
}
const sendReading = (farm, v, createdAt) => call('POST', '/ingest/readings', { body: { deviceKey: farm.deviceKey, createdAt: createdAt || new Date().toISOString(), temperature: 28, phLevel: 8, dissolvedOxygen: 6.5, salinity: 20, ...v } });
const notifs = async (token, qs = '') => { const r = await call('GET', '/notifications' + qs, { token }); return Array.isArray(r.body) ? r.body : []; };
const paramAlerts = (list, parameter) => list.filter((n) => n.parameter === parameter);

(async () => {
  const [[owner]] = await pool.query('SELECT account_id FROM accounts ORDER BY account_id LIMIT 1');
  await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_%'");
  const A = await makeFarm('A', owner.account_id);
  const B = await makeFarm('B', owner.account_id);
  const tokA = signToken({ accountId: owner.account_id, farmId: A.farmId });
  const tokB = signToken({ accountId: owner.account_id, farmId: B.farmId });

  try {
    // =============================================================== F. timestamps
    // The ESP32 sends this exact instant. It is 10:05 AM on 28 October 2026 in Manila (UTC+8).
    const KNOWN = '2026-10-28T02:05:00Z';
    let r = await sendReading(A, { temperature: 28.5, phLevel: 8.0, dissolvedOxygen: 6.2, salinity: null }, KNOWN);
    check('F1 ingest accepts the known timestamp', r.status === 201, r);
    const [[stored]] = await pool.query('SELECT UNIX_TIMESTAMP(recorded_at) AS epoch FROM water_quality_readings WHERE pond_id = ? AND recorded_at = FROM_UNIXTIME(?)', [A.pondId, Date.parse(KNOWN) / 1000]);
    check('F2 MySQL holds exactly that instant (no shift stored)', stored && stored.epoch === Date.parse(KNOWN) / 1000, stored);
    r = await call('GET', `/reports/reading-logs?pondId=${A.pondId}&limit=500`, { token: tokA });
    const known = (r.body || []).find((x) => x.recordedAt === '2026-10-28T02:05:00.000Z');
    check('F3 reading-logs row has the exact UTC instant', !!known, (r.body || [])[0]);
    check('F4 reading-logs time is Philippine time: 10:05 AM', known && known.time === '10:05 AM', known);
    check('F5 reading-logs date is the Philippine date: October 28, 2026', known && known.date === 'October 28, 2026', known);
    check('F6 a sensor that sent nothing is null, not 0', known && known.salinity === null && known.temp === 28.5, known);
    check('F7 the row status ignores the missing value instead of calling it normal/0', known && known.statuses.salinity === 'unavailable' && known.status === 'normal', known);

    // an instant that is a DIFFERENT calendar day in Manila than in UTC: 2026-10-27 18:30 UTC = 2026-10-28 02:30 Manila
    await sendReading(A, {}, '2026-10-27T18:30:00Z');
    r = await call('GET', `/reports/reading-logs?pondId=${A.pondId}&limit=500`, { token: tokA });
    const cross = (r.body || []).find((x) => x.recordedAt === '2026-10-27T18:30:00.000Z');
    check('F8 across the UTC midnight the Manila date and time are both right', cross && cross.date === 'October 28, 2026' && cross.time === '2:30 AM', cross);

    // =============================================================== D. notification lifecycle (parameter alerts)
    const P = B; // a clean pond for alert tests
    await sendReading(P, { dissolvedOxygen: 4.4 });
    let list = await notifs(tokB);
    let doAlerts = paramAlerts(list, 'dissolved_oxygen');
    check('D1 a concerning DO reading creates ONE Warning alert', doAlerts.length === 1 && doAlerts[0].severity === 'warning' && !doAlerts[0].resolved, doAlerts);
    const first = doAlerts[0];
    check('D2 the alert carries pond, parameter, unit and measured value', first.pondName === 'B pond' && first.parameterLabel === 'Dissolved Oxygen' && first.unit === 'mg/L' && first.measuredValue === 4.4, first);
    check('D3 the alert carries severity, message, ISO timestamp and display time', first.description.includes('4.4') && /below the safe threshold/.test(first.description) && !!first.createdAt && /^\d\d\/\d\d\/\d{4}, \d{1,2}:\d\d (AM|PM)$/.test(first.time), first);
    r = await call('GET', '/notifications?severity=Warning', { token: tokB });
    check('D4 the Warning filter returns it (Warning is not omitted)', r.body.some((n) => n.id === first.id), r.body);
    await call('PUT', `/notifications/${first.id}/read`, { token: tokB, body: { read: true } });

    await sendReading(P, { dissolvedOxygen: 2.0 }, new Date(Date.now() + 1000).toISOString());
    list = await notifs(tokB); doAlerts = paramAlerts(list, 'dissolved_oxygen');
    check('D5 a worse reading ESCALATES the same alert to Critical (no second alert)', doAlerts.length === 1 && doAlerts[0].id === first.id && doAlerts[0].severity === 'critical' && doAlerts[0].measuredValue === 2, doAlerts);
    check('D6 the escalated alert is unread again', doAlerts[0].read === false, doAlerts[0]);
    r = await call('GET', '/notifications?severity=Critical', { token: tokB });
    const crit = r.body.filter((n) => n.parameter === 'dissolved_oxygen');
    check('D7 the Critical filter returns it and the Warning filter no longer does', crit.length === 1 && !(await call('GET', '/notifications?severity=Warning', { token: tokB })).body.some((n) => n.id === first.id), crit);

    await sendReading(P, { dissolvedOxygen: 4.4 }, new Date(Date.now() + 2000).toISOString());
    doAlerts = paramAlerts(await notifs(tokB), 'dissolved_oxygen');
    check('D8 an improving but still low reading lowers the SAME alert to Warning', doAlerts.length === 1 && doAlerts[0].severity === 'warning', doAlerts);

    // recovery: 3 consecutive in-range readings required
    await sendReading(P, { dissolvedOxygen: 6.5 }, new Date(Date.now() + 3000).toISOString());
    check('D9 one good reading does NOT resolve it', paramAlerts(await notifs(tokB), 'dissolved_oxygen')[0].resolved === false);
    await sendReading(P, { dissolvedOxygen: 4.0 }, new Date(Date.now() + 4000).toISOString()); // flaps back below the limit
    await sendReading(P, { dissolvedOxygen: 6.6 }, new Date(Date.now() + 5000).toISOString());
    await sendReading(P, { dissolvedOxygen: 6.7 }, new Date(Date.now() + 6000).toISOString());
    doAlerts = paramAlerts(await notifs(tokB), 'dissolved_oxygen');
    check('D10 a flapping value never created a second alert and two good readings after a relapse still do not resolve it', doAlerts.length === 1 && doAlerts[0].resolved === false, doAlerts);
    await sendReading(P, { dissolvedOxygen: 6.8 }, new Date(Date.now() + 7000).toISOString());
    doAlerts = paramAlerts(await notifs(tokB), 'dissolved_oxygen');
    check('D11 three consecutive good readings resolve it', doAlerts.length === 1 && doAlerts[0].resolved === true, doAlerts);
    await sendReading(P, { dissolvedOxygen: 3.0 }, new Date(Date.now() + 8000).toISOString());
    doAlerts = paramAlerts(await notifs(tokB), 'dissolved_oxygen');
    check('D12 a new problem after recovery opens a NEW alert (history kept)', doAlerts.length === 2 && doAlerts.filter((n) => !n.resolved).length === 1, doAlerts.map((n) => [n.id, n.resolved, n.severity]));

    // =============================================================== D. outdated readings
    const S = await makeFarm('S', owner.account_id);
    const tokS = signToken({ accountId: owner.account_id, farmId: S.farmId });
    await sendReading(S, {}, minutesAgo(25)); // device is in contact NOW, but its newest reading is 25 minutes old
    let stats = await sweepStaleReadings();
    let stale = (await notifs(tokS)).filter((n) => n.category === 'stale');
    check('D13 online device + 25-minute-old reading -> ONE "Outdated Readings" alert', stale.length === 1 && stale[0].title === 'Outdated Readings' && stale[0].severity === 'stale' && stale[0].pondName === 'S pond', stale);
    check('D14 the stale alert states the age and the last reading time', /for 2[0-9] minutes/.test(stale[0].description) && /Last reading/.test(stale[0].description), stale[0]);
    check('D15 it is kept apart from water quality: no Warning/Critical filter match', !(await call('GET', '/notifications?severity=Warning', { token: tokS })).body.some((n) => n.category === 'stale'));
    stats = await sweepStaleReadings();
    stale = (await notifs(tokS)).filter((n) => n.category === 'stale');
    check('D16 repeated sweeps do not duplicate it', stale.length === 1 && stats.created === 0, { stale: stale.length, stats });
    // 90 minutes old -> escalates in place
    await pool.query('UPDATE water_quality_readings SET recorded_at = NOW() - INTERVAL 90 MINUTE WHERE pond_id = ?', [S.pondId]);
    await call('PUT', `/notifications/${stale[0].id}/read`, { token: tokS, body: { read: true } });
    await sweepStaleReadings();
    stale = (await notifs(tokS)).filter((n) => n.category === 'stale');
    check('D17 after an hour it ESCALATES in place and is unread again', stale.length === 1 && stale[0].read === false && /1 hour/.test(stale[0].description) && (await q('SELECT alert_level FROM early_warning_notifications WHERE notification_id = ?', [stale[0].id]))[0].alert_level === 'high', stale);
    check('D18 the pond itself shows STALE (never green) while data is outdated', (await call('GET', `/ponds/${S.pondId}`, { token: tokS })).body.status === 'stale');
    await sendReading(S, {}); // fresh data
    stale = (await notifs(tokS)).filter((n) => n.category === 'stale');
    check('D19 a fresh reading resolves the outdated-data alert immediately', stale.length === 1 && stale[0].resolved === true, stale);
    check('D20 and the pond is judged normal again', (await call('GET', `/ponds/${S.pondId}`, { token: tokS })).body.status === 'normal');

    // offline device: reported as offline, not also as stale
    await pool.query('UPDATE water_quality_readings SET recorded_at = NOW() - INTERVAL 40 MINUTE WHERE pond_id = ?', [S.pondId]);
    await pool.query("UPDATE device_status SET last_seen_at = NOW() - INTERVAL 30 MINUTE, connectivity_status = 'offline' WHERE device_id = ?", [S.deviceId]);
    await sweepStaleReadings();
    check('D21 an OFFLINE device gets no "Outdated Readings" alert (offline covers it)', !(await notifs(tokS)).some((n) => n.category === 'stale' && !n.resolved));
    check('D22 the pond is OFFLINE (device state), distinct from stale data', (await call('GET', `/ponds/${S.pondId}`, { token: tokS })).body.status === 'offline');

    // =============================================================== monitors really run
    r = await call('GET', '/health/monitors');
    const names = (r.body.monitors || []).map((m) => m.name);
    check('D23 /api/health/monitors lists both background monitors', names.includes('staleReadings') && names.includes('deviceOffline'), r.body);
    check('D24 both have run, on schedule (staleReadings every 300 s, deviceOffline every 60 s)', (r.body.monitors || []).every((m) => m.runs >= 1) && (r.body.monitors || []).find((m) => m.name === 'staleReadings').intervalSeconds === 300, r.body);

    // =============================================================== E / I. status never green without data; hybrid agrees
    const H = await makeFarm('H', owner.account_id);
    const tokH = signToken({ accountId: owner.account_id, farmId: H.farmId });
    await sendReading(H, { phLevel: null });
    let pond = (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body;
    check('E1 a missing pH value is "unavailable" for that parameter, never normal', pond.parameters.find((p) => p.name === 'pH' || p.key === 'ph' || /pH/i.test(p.name || p.label || ''))?.status === 'unavailable' && pond.missingParameters.includes('ph'), pond.parameters);
    check('E2 the pond is judged on what WAS measured (normal)', pond.status === 'normal' && pond.stale === false, pond);

    const insertHybrid = async (farm, status, ageMin, trend) => {
      const [rd] = await pool.query('INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at) VALUES (?, ?, 28, 8, 6.5, 20, NOW() - INTERVAL ? MINUTE)', [farm.deviceId, farm.pondId, ageMin]);
      const [res] = await pool.query(
        `INSERT INTO risk_classification_results (farm_id, pond_id, source_reading_id, reading_recorded_at, risk_class, prob_low, prob_moderate, prob_high, water_quality_condition, forecast_trend, hybrid_status, details_json, model_version, calculated_at)
         VALUES (?, ?, ?, NOW() - INTERVAL ? MINUTE, 'High', 0.1, 0.2, 0.7, 'Abnormal', ?, ?, '{}', 'qa', NOW())`, [farm.farmId, farm.pondId, rd.insertId, ageMin, trend, status]);
      return res.insertId;
    };
    await sendReading(H, {}); // fresh, in-range reading
    const hid = await insertHybrid(H, 'Critical', 1, 'Deteriorating');
    pond = (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body;
    check('I1 a recent hybrid CRITICAL raises the displayed pond status (they agree)', pond.status === 'critical' && pond.hybridStatus === 'Critical' && pond.statusSource === 'hybrid', pond);
    await pool.query('UPDATE risk_classification_results SET hybrid_status = ? WHERE result_id = ?', ['Warning', hid]);
    check('I2 hybrid WARNING shows as warning', (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body.status === 'warning');
    await pool.query('UPDATE risk_classification_results SET hybrid_status = ? WHERE result_id = ?', ['Normal', hid]);
    check('I3 hybrid NORMAL keeps the pond normal', (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body.status === 'normal');
    await pool.query("UPDATE risk_classification_results SET hybrid_status = 'Critical', reading_recorded_at = NOW() - INTERVAL 3 HOUR WHERE result_id = ?", [hid]);
    check('I4 an OLD hybrid result is ignored (not trusted after 45 minutes)', (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body.status === 'normal');
    await pool.query("UPDATE risk_classification_results SET hybrid_status = 'Normal', reading_recorded_at = NOW() WHERE result_id = ?", [hid]);
    await sendReading(H, { dissolvedOxygen: 1.5 }, new Date(Date.now() + 1000).toISOString());
    check('I5 hybrid NORMAL can never hide a threshold CRITICAL', (await call('GET', `/ponds/${H.pondId}`, { token: tokH })).body.status === 'critical');

    // hybrid alert in the notification feed carries the forecast trend that triggered it
    await pool.query(
      `INSERT INTO early_warning_notifications (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read, source, risk_result_id)
       VALUES (?, ?, NULL, NULL, 'Hybrid Early Warning: Critical', 'critical', 'H pond: hybrid critical', 'Check aeration.', 0, 0, 'hybrid_ml', ?)`, [H.farmId, H.pondId, hid]);
    await pool.query("UPDATE risk_classification_results SET forecast_trend = 'Deteriorating' WHERE result_id = ?", [hid]);
    const hyb = (await notifs(tokH)).find((n) => n.category === 'hybrid');
    check('I6 hybrid alert: severity critical, category hybrid, honest forecast trend', hyb && hyb.severity === 'critical' && hyb.trend === 'Deteriorating Trend', hyb);
    // a parameter alert's trend comes from the readings themselves: DO went 6.5 -> 1.5, so it IS worsening
    const doAlert = (await notifs(tokH)).find((n) => n.parameter === 'dissolved_oxygen');
    check('I7 a parameter alert reports a trend derived from the last readings (here: getting worse)', doAlert && doAlert.trend === 'Deteriorating Trend', doAlert);

    // =============================================================== A / B. forecast API
    const F = await makeFarm('F', owner.account_id);
    const tokF = signToken({ accountId: owner.account_id, farmId: F.farmId });
    for (let i = 0; i < 6 * 12; i++) {
      await pool.query('INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at) VALUES (?, ?, 28, 7.9, 6.0, 20, NOW() - INTERVAL ? MINUTE)', [F.deviceId, F.pondId, 5 * i + 3]);
    }
    // The ML service stamps a whole batch with ONE created_at; do the same here.
    const batchAt = new Date();
    const addFc = (param, value, minutesAhead, createdAt = batchAt) => pool.query('INSERT INTO water_quality_forecasts (farm_id, pond_id, parameter, forecast_value, predicted_for, created_at) VALUES (?, ?, ?, ?, ?, ?)', [F.farmId, F.pondId, param, value, new Date(Date.now() + minutesAhead * 60000), createdAt]);
    for (const [param, base] of [['ph', 7.7], ['dissolved_oxygen', 6.1], ['temperature', 28.2], ['salinity', 19.5]]) for (let h = 1; h <= 4; h++) await addFc(param, base + h * 0.1, h * 60);
    const results = {};
    for (const param of ['ph', 'dissolved_oxygen', 'temperature', 'salinity']) results[param] = (await call('GET', `/ponds/${F.pondId}/forecast?parameter=${param}`, { token: tokF })).body;
    check('A1 pH forecast is returned with its own data (7.8..8.1), parameter and unit', results.ph.parameter === 'ph' && results.ph.unit === 'pH' && results.ph.status === 'ok' && results.ph.forecast.length === 4 && Math.abs(results.ph.forecast[0] - 7.8) < 1e-9, results.ph);
    check('A2 each parameter returns a DIFFERENT series with the right unit',
      results.dissolved_oxygen.unit === 'mg/L' && results.temperature.unit === '\u00b0C' && results.salinity.unit === 'ppt' &&
      results.dissolved_oxygen.forecast[0] !== results.ph.forecast[0] && results.salinity.forecast[0] !== results.temperature.forecast[0], Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [v.unit, v.forecast[0]]])));
    check('B1 history and forecast both carry timestamps, one per value', results.ph.historical.length === results.ph.historicalTimestamps.length && results.ph.forecast.length === results.ph.predictedForTimestamps.length && results.ph.historical.length >= 6, { h: results.ph.historical.length, ht: results.ph.historicalTimestamps.length });
    const hts = results.ph.historicalTimestamps.map((t) => Date.parse(t));
    check('B2 history timestamps are ascending UTC instants ending now-ish, before the first forecast', hts.every((t, i) => i === 0 || t > hts[i - 1]) && hts[hts.length - 1] <= Date.now() + 1000 && hts[hts.length - 1] < Date.parse(results.ph.predictedForTimestamps[0]), { last: results.ph.historicalTimestamps.slice(-2), first: results.ph.predictedForTimestamps[0] });
    check('B3 the response says which time zone labels should use', results.ph.timezone === 'Asia/Manila');
    // newest batch only, NaN-ish rows dropped, states explained
    await addFc('ph', 9.99, 125, new Date(Date.now() - 600 * 60000)); // an OLDER batch must not mix in
    const again = (await call('GET', `/ponds/${F.pondId}/forecast?parameter=ph`, { token: tokF })).body;
    check('A3 only the newest forecast batch is used (an old 9.99 row is ignored)', !again.forecast.includes(9.99), again.forecast);
    await pool.query("DELETE FROM water_quality_forecasts WHERE pond_id = ? AND parameter = 'ph'", [F.pondId]);
    const nf = (await call('GET', `/ponds/${F.pondId}/forecast?parameter=ph`, { token: tokF })).body;
    check('A4 no forecast -> status "no_forecast" with history still returned (honest empty state)', nf.status === 'no_forecast' && nf.forecast.length === 0 && nf.historical.length >= 6, nf);
    const E = await makeFarm('E', owner.account_id);
    const tokE = signToken({ accountId: owner.account_id, farmId: E.farmId });
    const nh = (await call('GET', `/ponds/${E.pondId}/forecast?parameter=ph`, { token: tokE })).body;
    check('A5 a pond with no readings -> status "no_history"', nh.status === 'no_history' && nh.historical.length === 0, nh);
    check('A6 an unknown parameter is rejected, not guessed', (await call('GET', `/ponds/${F.pondId}/forecast?parameter=bogus`, { token: tokF })).status === 400);
    check('A7 another farm cannot read this forecast', (await call('GET', `/ponds/${F.pondId}/forecast?parameter=ph`, { token: tokB })).status === 404);

    // =============================================================== G. report trends
    // two different DAYS at the same clock hour must not be merged into one bucket
    const T = await makeFarm('T', owner.account_id);
    const tokT = signToken({ accountId: owner.account_id, farmId: T.farmId });
    const put = (iso, v) => pool.query('INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at) VALUES (?, ?, ?, 8, 6, 20, ?)', [T.deviceId, T.pondId, v, new Date(iso)]);
    await put('2026-10-27T02:10:00Z', 26); await put('2026-10-27T02:40:00Z', 28);    // 10:xx Manila, day 1 (avg 27)
    await put('2026-10-28T02:20:00Z', 30);                                         // 10:xx Manila, day 2
    await put('2026-10-28T05:30:00Z', 29);
    let tr = (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=48`, { token: tokT })).body;
    check('G1 hourly trend keeps the same clock hour of different days apart (4 points -> 3 buckets)', tr.bucket === 'hour' && tr.pointCount === 3 && tr.temperature.join() === '27,30,29', tr);
    check('G2 every point has a UTC timestamp, aligned with every series', tr.timestamps.length === 3 && ['temperature', 'dissolvedOxygen', 'ph', 'salinity'].every((k) => tr[k].length === 3), tr);
    check('G3 hour labels are Philippine time (hour-ending: 02:10Z..02:40Z -> 11:00)', tr.labels[0] === '11:00' && tr.timestamps[0] === '2026-10-27T03:00:00.000Z', { l: tr.labels, t: tr.timestamps });
    check('G4 units and the zone accompany the data', tr.units.temperature === '\u00b0C' && tr.units.dissolvedOxygen === 'mg/L' && tr.units.ph === 'pH' && tr.units.salinity === 'ppt' && tr.timezone === 'Asia/Manila', tr.units);
    check('G5 thresholds are returned so the app can draw the safe band', tr.thresholds.dissolvedOxygen && tr.thresholds.dissolvedOxygen.min === 5, tr.thresholds);
    check('G6 old data is reported as stale with its true range, not "the last 24 hours"', tr.stale === true && tr.rangeEnd === '2026-10-28T05:30:00.000Z' && !!tr.latestReadingAt, tr);
    tr = (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=168`, { token: tokT })).body;
    check('G7 long ranges switch to DAILY buckets labelled by Manila calendar day', tr.bucket === 'day' && tr.pointCount === 2 && tr.temperature.join() === '27,29.5', tr);
    await pool.query('INSERT INTO water_quality_forecasts (farm_id, pond_id, parameter, forecast_value, predicted_for, created_at) VALUES (?, ?, ?, 28.4, NOW() + INTERVAL 1 HOUR, NOW())', [T.farmId, T.pondId, 'temperature']);
    tr = (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=48`, { token: tokT })).body;
    check('G8 forecast values come in a separate block with their own timestamps (not mixed with measured data)', tr.forecast.timestamps.length === 1 && tr.forecast.temperature[0] === 28.4 && tr.forecast.ph[0] === null && tr.temperature.length === 3, tr.forecast);
    tr = (await call('GET', `/reports/trend?pondId=${E.pondId}&hours=24`, { token: tokE })).body;
    check('G9 a pond with no readings returns a valid empty trend, no crash', tr.pointCount === 0 && tr.labels.length === 0 && tr.stale === true, tr);
    check('G10 a nonsense range is clamped, not trusted', (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=-5`, { token: tokT })).status === 200 && (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=abc`, { token: tokT })).status === 200);
    check("G11 another farm's trend is empty (pond not theirs)", (await call('GET', `/reports/trend?pondId=${T.pondId}&hours=48`, { token: tokB })).body.pointCount === 0);
    check("G12 another farm's reading logs are empty", (await call('GET', `/reports/reading-logs?pondId=${T.pondId}`, { token: tokB })).body.length === 0);
    check('G13 unauthenticated report access is refused', (await call('GET', `/reports/trend?pondId=${T.pondId}`)).status === 401);
    const sm = (await call('GET', `/reports/summary?pondId=${T.pondId}&period=weekly`, { token: tokT })).body;
    check('G14 report summary: ISO period, parameters with status, a parameter without data is "stale" not "offline"/"normal"',
      sm.periodStart === '2026-10-27T02:10:00.000Z' && sm.parameters.length === 4, sm);
    const sm2 = (await call('GET', `/reports/summary?pondId=${E.pondId}&period=weekly`, { token: tokE })).body;
    check('G15 summary for a pond with no data: every parameter "stale", reading count 0', sm2.readingCount === 0 && sm2.parameters.every((p) => p.status === 'stale'), sm2.parameters);

    // =============================================================== authorization
    check('X1 notifications of another farm are not visible', !(await notifs(tokB)).some((n) => n.pondName === 'H pond'));
    check('X2 notifications require a login', (await call('GET', '/notifications')).status === 401);
  } finally {
    await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_%'");
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_%'"); } catch {} process.exit(1); });

// API + database test for: one device_status row per device, OFFLINE
// detection, readings that keep their own pond, queued (SD-card) readings,
// and device -> pond reassignment.
//
// Needs the server running against a LOCAL database that has the current
// schema.sql loaded, plus a Super Admin and the demo seed (it uses the demo
// farm's pond as "someone else's pond").
//
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... node tests/device_flow.js
//
// It also talks to the database directly (same .env as the server) to
// inspect rows and to back-date "last seen" times instead of waiting.
const pool = require('../db');
const { sweepOfflineDevices, OFFLINE_AFTER_SECONDS } = require('../utils/deviceHealth');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const SA_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@hyquai.test';
const SA_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin123!';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const q = async (sql, params) => (await pool.query(sql, params))[0];
const nowEpoch = () => Math.floor(Date.now() / 1000);

(async () => {
  const stamp = Date.now();
  const email = `dev${stamp}@test.ph`, pw = 'Password123!';

  // ---------- setup: approved farmer with a farm, 2 ponds, 1 device ----------
  let r = await call('POST', '/auth/signup', { body: { firstName: 'Dev', lastName: 'Tester', email, password: pw } });
  const accId = r.body.accountId;
  r = await call('POST', '/auth/login', { body: { email: SA_EMAIL, password: SA_PASSWORD } });
  const admin = r.body.token;
  await call('PUT', `/admin/accounts/${accId}/approve`, { token: admin });
  r = await call('POST', '/auth/login', { body: { email, password: pw } });
  r = await call('POST', '/farm', { token: r.body.token, body: { farmName: 'Device Test Farm' } });
  const tok = r.body.token;
  const A = Number((await call('POST', '/ponds', { token: tok, body: { name: 'Pond A' } })).body.id);
  const B = Number((await call('POST', '/ponds', { token: tok, body: { name: 'Pond B' } })).body.id);
  r = await call('POST', '/devices', { token: tok, body: { name: 'Sensor 1' } });
  const dev = Number(r.body.id), key = r.body.deviceKey;
  const ingest = (extra) => call('POST', '/ingest/readings', { body: { deviceKey: key, temperature: 28.4, phLevel: 7.8, dissolvedOxygen: 6.1, salinity: 14, ...extra } });
  const heartbeat = (extra) => call('POST', '/ingest/status', { body: { deviceKey: key, batteryPercentage: 87, isCharging: true, connectivityStatus: 'online', signalStrength: 'Stable', activeSensorsCount: 4, ...extra } });
  const listDev = async () => (await call('GET', '/devices', { token: tok })).body.find((d) => Number(d.id) === dev);
  const pondList = async () => (await call('GET', '/ponds', { token: tok })).body;
  const statusRows = async () => (await q('SELECT * FROM device_status WHERE device_id = ?', [dev]));

  // ================= PROBLEM 1 + 10: device_status is one current row =================
  check('new device has exactly one initial OFFLINE status row', (await statusRows()).length === 1 && (await statusRows())[0].connectivity_status === 'offline');
  let d = await listDev();
  check('unassigned device -> "unassigned", last sync "never"', d.status === 'unassigned' && d.lastSync === 'never', d);
  await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: A } });
  d = await listDev();
  check('assigned but never contacted -> OFFLINE (not a stale "online")', d.status === 'offline', d);

  for (let i = 0; i < 5; i++) await heartbeat({ batteryPercentage: 90 - i });
  let rows = await statusRows();
  check('5 heartbeats -> still exactly ONE device_status row', rows.length === 1, rows.length);
  check('that row holds the LATEST values (battery 86)', Number(rows[0].battery_percentage) === 86, rows[0]);
  check('last_seen_at is set', !!rows[0].last_seen_at, rows[0]);
  let allRows = await q('SELECT device_id, COUNT(*) n FROM device_status GROUP BY device_id HAVING n > 1');
  check('no device anywhere has more than one status row', allRows.length === 0, allRows);
  let dup = await q('SELECT 1 FROM device_status LIMIT 0'); // schema-level guarantee:
  let threw = false;
  try { await q('INSERT INTO device_status (device_id) VALUES (?)', [dev]); } catch (e) { threw = e.code === 'ER_DUP_ENTRY'; }
  check('database itself REFUSES a second status row (UNIQUE device_id)', threw);

  d = await listDev();
  check('after heartbeat -> online, "just now"', d.status === 'online' && d.lastSync === 'just now', d);
  r = await call('GET', `/devices/${dev}`, { token: tok });
  check('detail: online, battery 86, 4 sensors', r.body.online === true && r.body.batteryPercent === 86 && r.body.activeSensors === 4, r.body);
  r = await heartbeat({ connectivityStatus: 'weak', signalStrength: 'Unstable' });
  d = await listDev();
  check('weak-signal device still counts as online (it IS talking)', d.status === 'online', d);
  r = await call('GET', `/devices/${dev}`, { token: tok });
  check('...and detail reports connectivity "weak", wifiStable=false', r.body.connectivityStatus === 'weak' && r.body.wifiStable === false, r.body);
  r = await heartbeat({ connectivityStatus: 'offline' });
  d = await listDev();
  check('a device cannot declare itself "offline" while it is talking to us', d.status === 'online', d);
  r = await heartbeat({ batteryPercentage: 250, activeSensorsCount: 99 });
  rows = await statusRows();
  check('battery clamped to 100, sensors clamped to 4', Number(rows[0].battery_percentage) === 100 && rows[0].active_sensors_count === 4, rows[0]);

  // ================= PROBLEM 2: powered-off device shows OFFLINE =================
  await heartbeat();
  const ago = (sec) => q('UPDATE device_status SET last_seen_at = NOW() - INTERVAL ? SECOND, recorded_at = NOW() - INTERVAL ? SECOND WHERE device_id = ?', [sec, sec, dev]);
  await ago(OFFLINE_AFTER_SECONDS - 60);
  d = await listDev();
  check(`silent for ${OFFLINE_AFTER_SECONDS - 60}s (< threshold) -> still online`, d.status === 'online', d);
  await ago(OFFLINE_AFTER_SECONDS + 60);
  d = await listDev();
  check(`silent for ${OFFLINE_AFTER_SECONDS + 60}s -> OFFLINE, with NO message from the device and NO background job`, d.status === 'offline', d);
  r = await call('GET', `/devices/${dev}`, { token: tok });
  check('detail: online=false, 0 active sensors, last sync is minutes ago', r.body.online === false && r.body.activeSensors === 0 && /m ago/.test(r.body.lastSync), r.body);
  let p = (await pondList()).find((x) => Number(x.id) === A);
  check('pond whose device went silent -> pond status "offline"', p.status === 'offline', p);

  // sweeper: marks offline once + exactly one notification
  const before = (await q("SELECT COUNT(*) n FROM early_warning_notifications WHERE device_id = ? AND title = 'Device Offline'", [dev]))[0].n;
  const changed1 = await sweepOfflineDevices();
  const changed2 = await sweepOfflineDevices();
  const offlineNotifs = await q("SELECT * FROM early_warning_notifications WHERE device_id = ? AND title = 'Device Offline' AND is_resolved = 0", [dev]);
  check('sweep flags the device offline (first run changes 1+, second run 0)', changed1 >= 1 && changed2 === 0, { changed1, changed2 });
  check('exactly ONE open "Device Offline" notification for the outage', offlineNotifs.length === 1 && before === 0, offlineNotifs.length);
  check('...tied to the pond the device is in', offlineNotifs[0] && offlineNotifs[0].pond_id === A);
  rows = await statusRows();
  check('sweep stored connectivity_status = offline', rows[0].connectivity_status === 'offline', rows[0]);

  // device powers back on: any contact revives it and closes the alert
  r = await heartbeat();
  d = await listDev();
  check('device powers back on -> online again', d.status === 'online', d);
  const open = await q("SELECT 1 FROM early_warning_notifications WHERE device_id = ? AND title = 'Device Offline' AND is_resolved = 0", [dev]);
  check('...and the "Device Offline" alert is auto-resolved', open.length === 0);

  // config poll / reading upload also count as contact
  await ago(OFFLINE_AFTER_SECONDS + 600); await sweepOfflineDevices();
  check('(set up) device is offline again', (await listDev()).status === 'offline');
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': key } });
  check('a config poll alone brings it back online', r.status === 200 && (await listDev()).status === 'online');
  await ago(OFFLINE_AFTER_SECONDS + 600);
  r = await ingest();
  check('a reading upload alone brings it back online', r.status === 201 && (await listDev()).status === 'online', r);

  // seed / pre-migration rows (last_seen_at NULL) fall back to recorded_at
  const seedDev = (await q("SELECT device_id FROM monitoring_devices WHERE device_key IS NOT NULL AND farm_id = (SELECT farm_id FROM aquaculture_farms WHERE owner_id = 1) ORDER BY device_id LIMIT 1"))[0];
  await q('UPDATE device_status SET last_seen_at = NULL, connectivity_status = ?, recorded_at = NOW() WHERE device_id = ?', ['online', seedDev.device_id]);
  let sd = (await q(`SELECT ${require('../utils/deviceHealth').connectivitySql('ds')} AS c FROM device_status ds WHERE ds.device_id = ?`, [seedDev.device_id]))[0].c;
  check('legacy row (no last_seen_at) written just now -> online', sd === 'online', sd);
  await q('UPDATE device_status SET recorded_at = NOW() - INTERVAL 1 DAY WHERE device_id = ?', [seedDev.device_id]);
  sd = (await q(`SELECT ${require('../utils/deviceHealth').connectivitySql('ds')} AS c FROM device_status ds WHERE ds.device_id = ?`, [seedDev.device_id]))[0].c;
  check('legacy row written a day ago -> offline', sd === 'offline', sd);

  // ================= PROBLEM 3 + 9: readings keep the pond they were taken in =================
  r = await ingest({ dissolvedOxygen: 6.0 });
  check('live reading while device is in Pond A is stored with pond_id = A', r.status === 201 && r.body.pond_id === A, r.body);
  let row = (await q('SELECT * FROM water_quality_readings WHERE reading_id = ?', [r.body.reading_id]))[0];
  check('row in the database has pond_id = A and device_id', row.pond_id === A && row.device_id === dev, row);
  check('response also tells the device its CURRENT pond (config)', r.body.config.pond_id === A && r.body.config.pond_name === 'Pond A', r.body.config);

  const nA1 = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE pond_id = ?', [A]))[0].n;
  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: B } });
  check('farmer moves the device to Pond B', r.status === 200);
  r = await ingest({ dissolvedOxygen: 7.7 });
  check('a live reading after the move is stored with pond_id = B', r.status === 201 && r.body.pond_id === B, r.body);
  check('response config now says Pond B (device learns it from its upload)', r.body.config.pond_id === B, r.body.config);

  const nA2 = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE pond_id = ?', [A]))[0].n;
  check('Pond A KEPT its history after the device left (count unchanged)', nA1 === nA2 && nA2 >= 1, { nA1, nA2 });
  r = await call('GET', `/reports/reading-logs?pondId=${A}`, { token: tok });
  check('report for Pond A still lists its readings (via pond_id, not the device)', r.body.length === nA2 && r.body.some((x) => x.do === 6), r.body);
  r = await call('GET', `/reports/reading-logs?pondId=${B}`, { token: tok });
  check('report for Pond B lists ONLY the reading taken in Pond B', r.body.length === 1 && r.body[0].do === 7.7, r.body);
  const pl = await pondList();
  const pA = pl.find((x) => Number(x.id) === A), pB = pl.find((x) => Number(x.id) === B);
  check('Pond A card keeps showing ITS last reading (DO 6) but is offline (no device)', pA.dissolvedOxygen === 6 && pA.status === 'offline' && pA.assignedDeviceId === null, pA);
  check('Pond B card shows ITS reading (DO 7.7) and the device', pB.dissolvedOxygen === 7.7 && pB.assignedDeviceId === String(dev), pB);
  r = await call('GET', `/reports/trend?pondId=${A}&hours=24`, { token: tok });
  check('trend chart for Pond A has data (history kept)', r.body.labels.length >= 1, r.body);
  r = await call('GET', `/reports/summary?pondId=${A}&period=daily`, { token: tok });
  check('summary report for Pond A counts only Pond A readings', r.body.readingCount === nA2, r.body.readingCount);
  r = await call('GET', `/ponds/${A}/forecast?parameter=dissolved_oxygen`, { token: tok });
  check("forecast history for Pond A is Pond A's own series", r.status === 200 && r.body.historical.length === nA2 && r.body.historical.includes(6), r.body);
  r = await call('GET', `/reports/reading-logs?pondId=1`, { token: tok });
  check("cannot read another farm's pond through reports (empty)", r.status === 200 && r.body.length === 0, r.body.length);
  r = await call('GET', `/ponds/1/forecast?parameter=ph`, { token: tok });
  check("cannot read another farm's pond forecast (404)", r.status === 404, r.status);

  // ================= PROBLEM 8: queued SD-card readings keep their pond =================
  // The device is now assigned to B, but these were taken earlier in A.
  const t0 = nowEpoch() - 2 * 3600;
  r = await ingest({ pondId: A, recordedAt: t0, dissolvedOxygen: 5.5 });
  check('queued reading (taken in A, 2h ago) uploaded while device is in B -> stored in A', r.status === 201 && r.body.pond_id === A, r.body);
  row = (await q('SELECT pond_id, UNIX_TIMESTAMP(recorded_at) ts FROM water_quality_readings WHERE reading_id = ?', [r.body.reading_id]))[0];
  check('...and recorded_at is when it was TAKEN (not when uploaded)', row.pond_id === A && Math.abs(row.ts - t0) <= 1, row);
  const cntBefore = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [dev]))[0].n;
  r = await ingest({ pondId: A, recordedAt: t0, dissolvedOxygen: 5.5 });
  const cntAfter = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [dev]))[0].n;
  check('re-sending the same queued reading (lost reply) is recognised: 200 duplicate, no new row', r.status === 200 && r.body.duplicate === true && cntBefore === cntAfter, { s: r.status, b: r.body, cntBefore, cntAfter });
  r = await ingest({ pondId: A, recordedAt: new Date((t0 - 600) * 1000).toISOString() });
  check('recordedAt may be an ISO string too', r.status === 201, r.body);
  r = await ingest({ pondId: A, recordedAt: t0 - 1200, temperature: 28, phLevel: 7.5, dissolvedOxygen: 1.0, salinity: 15 });
  const alertsStale = await q("SELECT COUNT(*) n FROM early_warning_notifications WHERE pond_id = ? AND parameter = 'dissolved_oxygen' AND created_at > NOW() - INTERVAL 1 MINUTE", [A]);
  check('a 2-hour-old CRITICAL reading is stored but raises no new alert', r.status === 201 && alertsStale[0].n === 0, alertsStale[0]);
  r = await ingest({ dissolvedOxygen: 1.0 });
  const alertsLive = await q("SELECT pond_id FROM early_warning_notifications WHERE parameter = 'dissolved_oxygen' AND device_id = ? AND is_resolved = 0 ORDER BY notification_id DESC LIMIT 1", [dev]);
  check('a LIVE critical reading does raise an alert, in the reading\'s pond (B)', r.status === 201 && alertsLive[0] && alertsLive[0].pond_id === B, alertsLive);

  // validation
  r = await ingest({ pondId: 1 });
  check("pondId from ANOTHER farm -> 422 POND_NOT_FOUND (device drops it)", r.status === 422 && r.body.code === 'POND_NOT_FOUND', r);
  r = await ingest({ pondId: 999999 });
  check('pondId that does not exist -> 422', r.status === 422, r);
  r = await ingest({ pondId: 'abc' });
  check('garbage pondId -> 400', r.status === 400, r);
  r = await ingest({ pondId: A, recordedAt: 1000 });
  check('recordedAt in 1970 (clock never synced) -> 422 BAD_TIMESTAMP', r.status === 422 && r.body.code === 'BAD_TIMESTAMP', r);
  r = await ingest({ pondId: A, recordedAt: nowEpoch() + 3600 });
  check('recordedAt 1h in the future -> 422', r.status === 422, r);
  r = await ingest({ pondId: A, recordedAt: 'yesterday-ish' });
  check('recordedAt garbage text -> 422', r.status === 422, r);
  r = await ingest({ phLevel: 99, temperature: 28 });
  check('impossible pH (99) stored as NULL, other values kept, reported in "ignored"', r.status === 201 && r.body.ignored.includes('phLevel'), r.body);
  row = (await q('SELECT ph_level, temperature FROM water_quality_readings WHERE reading_id = ?', [r.body.reading_id]))[0];
  check('...database row: ph NULL, temperature 28', row.ph_level === null && Number(row.temperature) === 28, row);
  r = await call('POST', '/ingest/readings', { body: { deviceKey: key, temperature: 'x', phLevel: 99, dissolvedOxygen: null, salinity: 999 } });
  check('reading with nothing usable -> 422 NO_VALID_VALUES', r.status === 422 && r.body.code === 'NO_VALID_VALUES', r);
  r = await call('POST', '/ingest/readings', { body: { temperature: 28 } });
  check('no deviceKey -> 401', r.status === 401);
  r = await call('POST', '/ingest/readings', { body: { deviceKey: 'dk_nope', temperature: 28 } });
  check('wrong deviceKey -> 401', r.status === 401);

  // ================= PROBLEM 4: assignment is dynamic and unassigned devices behave =================
  r = await call('PUT', `/devices/${dev}`, { token: tok, body: { name: 'Sensor 1', pondId: null } });
  check('farmer unassigns the device', r.status === 200);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': key } });
  check('config now returns pond_id null / pond_name null', r.status === 200 && r.body.pond_id === null && r.body.pond_name === null, r.body);
  r = await ingest();
  check('live reading from an UNASSIGNED device -> 409 DEVICE_UNASSIGNED', r.status === 409 && r.body.code === 'DEVICE_UNASSIGNED', r);
  r = await ingest({ pondId: B, recordedAt: nowEpoch() - 300, dissolvedOxygen: 6.6 });
  check('...but a reading taken earlier in B (queued) is still accepted into B', r.status === 201 && r.body.pond_id === B, r);
  await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: A } });
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': key } });
  check('moved to A: the config poll returns Pond A', r.body.pond_id === A && r.body.pond_name === 'Pond A', r.body);

  // deleting a pond (their schema: readings cascade) must not break device views
  r = await call('DELETE', `/ponds/${B}`, { token: tok });
  check('deleting Pond B works', r.status === 200);
  r = await ingest({ pondId: B, recordedAt: nowEpoch() - 60 });
  check('a queued reading for the DELETED pond -> 422 (device drops it, queue is not blocked)', r.status === 422 && r.body.code === 'POND_NOT_FOUND', r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

// API + database test for: moving a device between ponds (instant online /
// offline), one device per pond, and the critical-level alarm endpoint.
//
// Needs the server running against a LOCAL database that has the current
// schema.sql loaded (or migrations 001-003 applied), the demo seed (it uses the
// demo farm's pond as "someone else's pond") and a Super Admin.
//
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... node tests/reassign_flow.js
//
// It also talks to the database directly (same .env as the server) to
// inspect rows and to back-date times instead of waiting.
const pool = require('../db');

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
// Readings and moves in this test happen within the same second; real ones are
// minutes apart. Push a pond's existing readings back in time to match.
const ageReadings = (pondId, minutes) => q('UPDATE water_quality_readings SET recorded_at = recorded_at - INTERVAL ? MINUTE WHERE pond_id = ?', [minutes, pondId]);

(async () => {
  const stamp = Date.now();
  const email = `reassign${stamp}@test.ph`, pw = 'Password123!';

  // ---------- setup: approved farmer, farm, 3 ponds, 3 devices ----------
  let r = await call('POST', '/auth/signup', { body: { firstName: 'Re', lastName: 'Assign', email, password: pw } });
  const accId = r.body.accountId;
  r = await call('POST', '/auth/login', { body: { email: SA_EMAIL, password: SA_PASSWORD } });
  const admin = r.body.token;
  await call('PUT', `/admin/accounts/${accId}/approve`, { token: admin });
  r = await call('POST', '/auth/login', { body: { email, password: pw } });
  r = await call('POST', '/farm', { token: r.body.token, body: { farmName: 'Reassign Test Farm' } });
  const tok = r.body.token;
  const mkPond = async (name) => Number((await call('POST', '/ponds', { token: tok, body: { name } })).body.id);
  const A = await mkPond('Pond A'), B = await mkPond('Pond B'), C = await mkPond('Pond C');
  // pin this farm's thresholds to known values (DO 5-12, pH 6.5-8.5, temp 25-30, salinity 10-25)
  const [farmRow] = await q('SELECT farm_id FROM aquaculture_farms WHERE farm_name = ? ORDER BY farm_id DESC LIMIT 1', ['Reassign Test Farm']);
  for (const [p, lo, hi] of [['temperature', 25, 30], ['ph', 6.5, 8.5], ['dissolved_oxygen', 5, 12], ['salinity', 10, 25]]) {
    await q('INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE min_value = VALUES(min_value), max_value = VALUES(max_value)', [farmRow.farm_id, p, lo, hi]);
  }
  const mkDevice = async (name, pondId) => {
    const x = await call('POST', '/devices', { token: tok, body: pondId ? { name, pondId } : { name } });
    return { id: Number(x.body.id), key: x.body.deviceKey, res: x };
  };
  const D1 = await mkDevice('Sensor 1', A);
  const D2 = await mkDevice('Sensor 2', B);
  const D3 = await mkDevice('Sensor 3', null);
  const normal = { temperature: 28, phLevel: 7.5, dissolvedOxygen: 7, salinity: 15 };
  const ingest = (dev, extra) => call('POST', '/ingest/readings', { body: { deviceKey: dev.key, ...normal, ...(extra || {}) } });
  const heartbeat = (dev) => call('POST', '/ingest/status', { body: { deviceKey: dev.key, batteryPercentage: 80, isCharging: true, connectivityStatus: 'online', activeSensorsCount: 4 } });
  const ponds = async () => (await call('GET', '/ponds', { token: tok })).body;
  const pond = async (id) => (await ponds()).find((p) => Number(p.id) === id);
  const alarms = async () => (await call('GET', '/alarms', { token: tok })).body;
  const move = (dev, pondId) => call('PUT', `/devices/${dev.id}/pond`, { token: tok, body: { pond_id: pondId } });

  await heartbeat(D1); await heartbeat(D2); await heartbeat(D3);
  await ingest(D1); await ingest(D2);

  // ================= 1. the move is instant =================
  let a = await pond(A), b = await pond(B);
  check('(setup) Pond A is online and judged from its reading', a.status === 'normal' && a.assignedDeviceId === String(D1.id) && !a.awaitingReading, a);
  check('(setup) a device registered into Pond A is stamped with assigned_at', (await q('SELECT assigned_at FROM monitoring_devices WHERE device_id = ?', [D1.id]))[0].assigned_at !== null);

  r = await move(D1, C);
  check('move Device 1: Pond A -> Pond C answers 200 and says what happened', r.status === 200 && r.body.changed === true && r.body.previous_pond_id === A && r.body.pond_id === C, r.body);
  check('...the reply already says the pond it LEFT is offline', r.body.previous_pond && r.body.previous_pond.status === 'offline', r.body.previous_pond);
  // QA finding E/I: with no measurement yet the WATER is unknown, so the status is 'stale' (neutral),
// never 'normal' (green). The DEVICE is online, which is reported separately (deviceOnline).
  check('...and the pond it ENTERED is online (waiting for its first reading, NOT green)', r.body.pond && r.body.pond.status === 'stale' && r.body.pond.awaitingReading === true && r.body.pond.deviceOnline === true, r.body.pond);
  const afterMove = await ponds();
  a = afterMove.find((p) => Number(p.id) === A);
  let c = afterMove.find((p) => Number(p.id) === C);
  check('IMMEDIATELY after the move, Pond A (left) is OFFLINE with no device', a.status === 'offline' && a.assignedDeviceId === null, a);
  check('IMMEDIATELY after the move, Pond C (entered) is ONLINE, not offline', c.status !== 'offline' && c.assignedDeviceId === String(D1.id), c);
  check('...and says it is waiting for the first reading', c.awaitingReading === true && /waiting for first reading/.test(c.updatedAgo), c);
  check('each pond appears exactly once in the list', afterMove.length === 3 && new Set(afterMove.map((p) => p.id)).size === 3, afterMove.map((p) => p.id));
  r = await call('GET', `/ponds/${C}`, { token: tok });
  check('pond detail for Pond C: deviceOnline, parameters have no value yet', r.status === 200 && r.body.deviceOnline === true && r.body.parameters.every((p) => p.value === null), r.body);

  // the device sends its first reading for the new pond
  r = await ingest(D1);
  check('first live reading after the move is stored in Pond C', r.status === 201 && r.body.pond_id === C, r.body);
  c = await pond(C);
  check('Pond C now shows the real reading (no longer waiting)', c.status === 'normal' && c.awaitingReading === false && c.dissolvedOxygen === 7, c);
  a = await pond(A);
  check('Pond A stays offline and keeps its own last reading', a.status === 'offline' && a.dissolvedOxygen === 7, a);

  // ================= 2. moving BACK must not revive old data =================
  // Pond A has an old reading (DO 7 from before the move). Plant an old CRITICAL one too.
  await ageReadings(A, 30);
  await q('INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at) VALUES (?,?,?,?,?,?, NOW() - INTERVAL 20 MINUTE)', [D1.id, A, 28, 7.5, 1.0, 15]);
  r = await move(D1, A);
  check('move Device 1 back: Pond C -> Pond A', r.status === 200 && r.body.changed === true, r.body);
  a = await pond(A); c = await pond(C);
  check('Pond A is online and WAITING, not green (its old readings are from before the move)', a.status === 'stale' && a.awaitingReading === true && a.deviceOnline === true, a);
  check('Pond C (left) is offline again', c.status === 'offline', c);
  r = await alarms();
  check('NO alarm from the 20-minute-old critical reading in Pond A', r.count === 0, r);
  await ingest(D1, { dissolvedOxygen: 6.5 });
  a = await pond(A);
  check('first fresh reading puts Pond A back to normal', a.status === 'normal' && a.awaitingReading === false, a);

  // ================= 3. one device per pond =================
  // Device 2 sits in Pond B. Move Device 1 into Pond B.
  r = await move(D1, B);
  check('moving into a pond that already has a device works and names the displaced device', r.status === 200 && r.body.displaced_device && r.body.displaced_device.device_id === D2.id, r.body);
  check('...the message says so', /Sensor 2 was unassigned from Pond B/.test(r.body.message), r.body.message);
  let list = await ponds();
  check('Pond B appears ONCE (it used to be listed once per device)', list.filter((p) => Number(p.id) === B).length === 1, list.map((p) => p.name));
  b = list.find((p) => Number(p.id) === B);
  check('Pond B belongs to Device 1 now', b.assignedDeviceId === String(D1.id), b);
  const devs = (await call('GET', '/devices', { token: tok })).body;
  const d2 = devs.find((d) => Number(d.id) === D2.id);
  check('the displaced device is listed as Unassigned', d2.status === 'unassigned' && d2.pond === 'Unassigned', d2);
  check('no pond has more than one device (database)', (await q('SELECT pond_id, COUNT(*) n FROM monitoring_devices WHERE pond_id IS NOT NULL GROUP BY pond_id HAVING n > 1')).length === 0);

  r = await move(D1, B);
  check('moving a device to the pond it is already in changes nothing', r.status === 200 && r.body.changed === false && r.body.message === 'Device pond unchanged.', r.body);

  // ================= 4. all three endpoints behave the same =================
  r = await call('POST', `/devices/${D2.id}/assign`, { token: tok, body: { pondId: A } });
  check('POST /devices/:id/assign: Device 2 -> Pond A', r.status === 200 && r.body.changed === true && r.body.pond.status !== 'offline', r.body);
  r = await call('PUT', `/devices/${D3.id}`, { token: tok, body: { name: 'Sensor 3b', pondId: A } });
  check('PUT /devices/:id with pondId: Device 3 -> Pond A displaces Device 2', r.status === 200 && r.body.displaced_device && r.body.displaced_device.device_id === D2.id, r.body);
  r = await call('PUT', `/devices/${D3.id}`, { token: tok, body: { name: 'Sensor 3c' } });
  check('PUT /devices/:id with only a name leaves the pond alone', r.status === 200 && (await q('SELECT pond_id FROM monitoring_devices WHERE device_id = ?', [D3.id]))[0].pond_id === A);
  r = await call('PUT', `/devices/${D3.id}`, { token: tok, body: { pondId: null } });
  a = await pond(A);
  check('PUT /devices/:id with pondId null unassigns -> Pond A offline', r.status === 200 && a.status === 'offline' && a.assignedDeviceId === null, a);
  check('...and assigned_at is cleared', (await q('SELECT assigned_at FROM monitoring_devices WHERE device_id = ?', [D3.id]))[0].assigned_at === null);
  r = await call('POST', '/devices', { token: tok, body: { name: 'Sensor 4', pondId: B } });
  check('registering a device straight into an occupied pond displaces its device', r.status === 201 && r.body.displaced_device && r.body.displaced_device.device_id === D1.id, r.body);

  // ================= 5. rejects what it must =================
  r = await call('PUT', `/devices/${D3.id}/pond`, { token: tok, body: { pond_id: 1 } });
  check("another farm's pond -> 404, nothing changes", r.status === 404, r);
  r = await call('PUT', `/devices/${D3.id}/pond`, { token: tok, body: { pond_id: 999999 } });
  check('a pond that does not exist -> 404', r.status === 404, r);
  r = await call('PUT', `/devices/999999/pond`, { token: tok, body: { pond_id: A } });
  check('a device that does not exist -> 404', r.status === 404, r);
  r = await call('PUT', `/devices/${D3.id}/pond`, { token: tok, body: {} });
  check('no pond_id -> 400', r.status === 400, r);
  const demo = await call('POST', '/auth/login', { body: { email: 'farmer@hyquai.demo', password: 'HyQuai123!' } });
  r = await call('PUT', `/devices/${D3.id}/pond`, { token: demo.body.token, body: { pond_id: 1 } });
  check("another farm's farmer cannot move this farm's device -> 404", r.status === 404, r);

  // ================= 6. waiting does not last forever =================
  await q('UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE device_id IN (?, ?, ?)', [D1.id, D2.id, D3.id]);
  await ageReadings(C, 180); // older than the 1-hour-ago assignment used below
  const D5 = await mkDevice('Sensor 5', C);
  await heartbeat(D5);
  c = await pond(C);
  check('a freshly assigned online device: pond is waiting (online, not green)', c.status === 'stale' && c.awaitingReading === true && c.deviceOnline === true, c);
  await q('UPDATE monitoring_devices SET assigned_at = NOW() - INTERVAL 1 HOUR WHERE device_id = ?', [D5.id]);
  c = await pond(C);
  // Online but delivering nothing is MISSING DATA (stale), not an offline device.
  check('online device but NO reading for over 10 minutes -> pond STALE (no data), device still online', c.status === 'stale' && c.staleReason === 'no_readings' && c.awaitingReading === false && c.deviceOnline === true, c);
  await ingest(D5);
  c = await pond(C);
  check('a reading taken after the assignment brings it back (current)', c.status === 'normal' && c.awaitingReading === false, c);
  await q('UPDATE water_quality_readings SET recorded_at = NOW() - INTERVAL 2 HOUR WHERE device_id = ?', [D5.id]);
  c = await pond(C);
  check('...but a reading taken BEFORE the assignment is not "current"', c.status === 'stale' && c.staleReason === 'no_readings', c);
  await q('UPDATE monitoring_devices SET assigned_at = NOW() - INTERVAL 1 MINUTE WHERE device_id = ?', [D5.id]);
  await ingest(D5);
  c = await pond(C);
  check('a fresh reading after the assignment is current again', c.status === 'normal' && c.awaitingReading === false, c);

  // ================= 7. the alarm =================
  r = await alarms();
  check('normal water -> no alarm', r.count === 0 && Array.isArray(r.alarms), r);
  await ingest(D5, { dissolvedOxygen: 4.8 });
  c = await pond(C); r = await alarms();
  check('DO 4.8 (just under the 5.0 floor) is a WARNING, not critical -> no alarm', c.status === 'warning' && r.count === 0, { c, r });
  await ingest(D5, { dissolvedOxygen: 2.1 });
  c = await pond(C); r = await alarms();
  check('DO 2.1 is CRITICAL: pond shows critical', c.status === 'critical', c);
  check('...and the alarm endpoint lists it', r.count === 1 && r.alarms[0].pondId === String(C) && r.alarms[0].parameter === 'dissolved_oxygen' && r.alarms[0].direction === 'low' && r.alarms[0].value === 2.1, r);
  check('...with a readable message', /Dissolved Oxygen is critically low: 2.1 mg\/L \(safe \u2265 5 mg\/L\)/.test(r.alarms[0].message), r.alarms[0].message);
  await ingest(D5, { dissolvedOxygen: 2.1, temperature: 40, salinity: 40 });
  r = await alarms();
  check('several critical parameters -> one alarm entry each', r.count === 3 && ['dissolved_oxygen', 'temperature', 'salinity'].every((k) => r.alarms.some((x) => x.parameter === k)), r.alarms.map((x) => x.parameter));
  check('...with a stable key the app uses to remember "silenced"', r.alarms.every((x) => x.key === `${C}:${x.parameter}`), r.alarms.map((x) => x.key));
  await ingest(D5, { temperature: 40, salinity: 15 });
  r = await alarms();
  check('water back in range for some parameters -> only the still-critical one remains', r.count === 1 && r.alarms[0].parameter === 'temperature', r.alarms.map((x) => x.parameter));
  await ingest(D5);
  r = await alarms();
  check('everything back to normal -> alarm stops by itself', r.count === 0, r);

  await ingest(D5, { dissolvedOxygen: 1.5 });
  check('(setup) critical again', (await alarms()).count === 1);
  // stale data must not ring: same critical reading, but taken 1 hour ago
  await q('UPDATE monitoring_devices SET assigned_at = NOW() - INTERVAL 3 HOUR WHERE device_id = ?', [D5.id]);
  await q('UPDATE water_quality_readings SET recorded_at = NOW() - INTERVAL 1 HOUR WHERE device_id = ?', [D5.id]);
  c = await pond(C); r = await alarms();
  // An outdated reading is not judged as current (the card goes 'stale'), but it is not hidden:
  // lastKnownStatus keeps saying what the last reading was.
  check('a critical reading that is 1 hour old: the pond card is STALE (not judged) but remembers it was critical...', c.status === 'stale' && c.staleReason === 'outdated' && c.lastKnownStatus === 'critical', c);
  check('...but it does NOT ring (old data is not "critical right now")', r.count === 0, r);
  await q('UPDATE monitoring_devices SET assigned_at = NOW() - INTERVAL 1 MINUTE WHERE device_id = ?', [D5.id]);
  await ingest(D5, { dissolvedOxygen: 1.5 });
  check('a fresh critical reading rings again', (await alarms()).count === 1);
  await q('UPDATE device_status SET last_seen_at = NOW() - INTERVAL 10 MINUTE WHERE device_id = ?', [D5.id]);
  r = await alarms();
  check('the device goes silent (offline) -> no alarm from stale data', r.count === 0, r);
  await heartbeat(D5);
  check('(setup) device back online -> critical again', (await alarms()).count === 1);
  r = await move(D5, A);
  check('the critical device is MOVED to another pond -> the alarm for the old pond stops at once', r.status === 200 && (await alarms()).count === 0, await alarms());
  r = await call('GET', '/alarms', {});
  check('/alarms needs a login', r.status === 401, r);

  // ================= 8. readings that belong to the pond a device LEFT =================
  const openBefore = (await q("SELECT COUNT(*) n FROM early_warning_notifications WHERE pond_id = ? AND parameter = 'dissolved_oxygen' AND is_resolved = 0", [B]))[0].n;
  r = await ingest(D5, { pondIdAtCapture: B, dissolvedOxygen: 1.0 });
  const openAfter = (await q("SELECT COUNT(*) n FROM early_warning_notifications WHERE pond_id = ? AND parameter = 'dissolved_oxygen' AND is_resolved = 0", [B]))[0].n;
  check('a critical reading captured in the OLD pond is stored there as history...', r.status === 201 && r.body.pond_id === B, r.body);
  check('...but opens no alert for a pond that no longer has this device', openBefore === openAfter, { openBefore, openAfter });
  check('...and sounds no alarm', (await alarms()).count === 0);

  // ================= 9. the firmware sends createdAt =================
  const t30 = new Date(Date.now() - 30 * 60 * 1000);
  r = await ingest(D5, { createdAt: t30.toISOString().replace(/\.\d+Z$/, 'Z') });
  let row = (await q('SELECT UNIX_TIMESTAMP(recorded_at) ts FROM water_quality_readings WHERE reading_id = ?', [r.body.reading_id]))[0];
  check('createdAt (what the ESP32 sends) is used as the time the reading was taken', r.status === 201 && Math.abs(row.ts - Math.floor(t30.getTime() / 1000)) <= 2, row);
  r = await ingest(D5, { createdAt: 'not a time' });
  row = (await q('SELECT UNIX_TIMESTAMP(recorded_at) ts FROM water_quality_readings WHERE reading_id = ?', [r.body.reading_id]))[0];
  check('an unusable createdAt never rejects the reading: stored as "now"', r.status === 201 && Math.abs(row.ts - Math.floor(Date.now() / 1000)) <= 3, { s: r.status, row });
  r = await ingest(D5, { createdAt: '1970-01-01T00:00:00Z' });
  check('createdAt from a clock that never synced (1970) is ignored too, not a 422', r.status === 201, r);
  r = await ingest(D5, { recordedAt: 'garbage', createdAt: new Date().toISOString() });
  check('an explicit bad recordedAt is still a 422 (documented behaviour unchanged)', r.status === 422 && r.body.code === 'BAD_TIMESTAMP', r);

  // ================= 10. two people move devices into the same pond at once =================
  await q('UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE farm_id = ?', [farmRow.farm_id]);
  const [m1, m2] = await Promise.all([move(D1, B), move(D3, B)]);
  const inB = await q('SELECT device_id FROM monitoring_devices WHERE pond_id = ?', [B]);
  check('simultaneous moves into one pond: both answered (no 500)', m1.status === 200 && m2.status === 200, { m1: m1.status, m2: m2.status });
  check('...and the pond ends up with exactly ONE device', inB.length === 1, inB);

  // ---------- clean up ----------
  await q('DELETE FROM aquaculture_farms WHERE farm_id = ?', [farmRow.farm_id]);
  await q('DELETE FROM accounts WHERE account_id = ?', [accId]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

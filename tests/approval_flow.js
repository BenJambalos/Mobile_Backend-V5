// End-to-end API test for the Super Admin approval / setup / remote pond
// assignment flow. Run it against a LOCAL database (it creates accounts).
//
// Prerequisites
//   - server running:            npm start          (PORT 4000 by default)
//   - database.sql + seed_data.sql loaded, migrations/001 applied
//   - a Super Admin account:     role 'super_admin', status 'active'
//     SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD env vars (see below)
//   - the demo farmer from seed_data.sql (farmer@hyquai.demo / HyQuai123!)
//     — the test uses its pond id 1 as "another farm's pond".
//
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... node tests/approval_flow.js
//   (API_BASE overrides the default http://localhost:4000/api)
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

(async () => {
  const stamp = Date.now();
  const userA = `alice${stamp}@test.ph`, userB = `bob${stamp}@test.ph`, pw = 'Password123!';

  // ---- 1. Registration -> PENDING, no token ----
  let r = await call('POST', '/auth/signup', { body: { firstName: 'Alice', lastName: 'Reyes', email: userA, password: pw } });
  check('signup returns 201', r.status === 201, r);
  check('signup status = PENDING', r.body?.accountStatus === 'PENDING', r.body);
  check('signup returns NO token', !r.body?.token, r.body);
  const aliceId = r.body.accountId;
  r = await call('POST', '/auth/signup', { body: { firstName: 'Bob', lastName: 'Cruz', email: userB, password: pw } });
  const bobId = r.body.accountId;
  r = await call('POST', '/auth/signup', { body: { firstName: 'Alice', lastName: 'Reyes', email: userA, password: pw } });
  check('duplicate email -> 409', r.status === 409, r);
  r = await call('POST', '/auth/signup', { body: { firstName: 'X', email: 'x@y.z', password: pw } });
  check('signup missing lastName -> 400', r.status === 400, r);

  // ---- 2. Login while pending ----
  r = await call('POST', '/auth/login', { body: { email: userA, password: pw } });
  check('pending login -> 403', r.status === 403, r);
  check('pending message text', r.body?.error === 'Your account is still pending Super Admin approval.', r.body);
  check('pending code', r.body?.code === 'ACCOUNT_PENDING', r.body);
  check('pending login gives NO token', !r.body?.token);
  r = await call('POST', '/auth/login', { body: { email: userA, password: 'wrong-password' } });
  check('wrong password on pending acct -> 401 (status not leaked)', r.status === 401, r);

  // ---- 3. Authorization: normal user cannot use admin routes ----
  r = await call('POST', '/auth/login', { body: { email: 'farmer@hyquai.demo', password: 'HyQuai123!' } });
  check('existing demo farmer still logs in', r.status === 200 && r.body?.accountStatus === 'APPROVED', r);
  check('demo farmer setup is complete', r.body?.setup?.setupComplete === true, r.body?.setup);
  const farmerToken = r.body.token;
  for (const [m, p] of [['GET', '/admin/accounts/pending'], ['PUT', `/admin/accounts/${aliceId}/approve`], ['PUT', `/admin/accounts/${aliceId}/reject`]]) {
    r = await call(m, p, { token: farmerToken });
    check(`farm_owner ${m} ${p.replace(aliceId, ':id')} -> 403`, r.status === 403, r);
  }
  r = await call('GET', '/admin/accounts/pending');
  check('no token -> 401', r.status === 401, r);
  r = await call('GET', '/ponds', { token: farmerToken });
  check('existing farmer dashboard data still works', r.status === 200 && r.body.length === 4, r.body?.length);

  // ---- 4. Super Admin lists / approves / rejects ----
  r = await call('POST', '/auth/login', { body: { email: SA_EMAIL, password: SA_PASSWORD } });
  check('super admin login', r.status === 200 && r.body?.role === 'super_admin', r);
  const adminToken = r.body.token;
  r = await call('GET', '/admin/accounts/pending', { token: adminToken });
  const ids = (r.body?.accounts || []).map((a) => a.account_id);
  check('pending list contains alice + bob', ids.includes(aliceId) && ids.includes(bobId), r.body);
  const aliceRow = (r.body?.accounts || []).find((a) => a.account_id === aliceId);
  check('pending row shape', aliceRow && aliceRow.name === 'Alice Reyes' && aliceRow.email === userA && aliceRow.status === 'PENDING', aliceRow);
  check('pending list excludes demo farmer', !ids.includes(1));

  r = await call('PUT', `/admin/accounts/${bobId}/reject`, { token: adminToken });
  check('reject bob -> REJECTED', r.status === 200 && r.body?.status === 'REJECTED', r);
  r = await call('PUT', `/admin/accounts/${bobId}/reject`, { token: adminToken });
  check('reject twice -> 409', r.status === 409, r);
  r = await call('POST', '/auth/login', { body: { email: userB, password: pw } });
  check('rejected login -> 403 ACCOUNT_REJECTED', r.status === 403 && r.body?.code === 'ACCOUNT_REJECTED', r);
  r = await call('GET', '/admin/accounts/pending', { token: adminToken });
  check('rejected bob leaves pending list', !(r.body.accounts || []).some((a) => a.account_id === bobId));

  r = await call('PUT', `/admin/accounts/999999/approve`, { token: adminToken });
  check('approve unknown id -> 404', r.status === 404, r);
  r = await call('PUT', `/admin/accounts/abc/approve`, { token: adminToken });
  check('approve bad id -> 400', r.status === 400, r);
  r = await call('PUT', `/admin/accounts/1/reject`, { token: adminToken });
  check('cannot reject an already-active farm owner -> 409', r.status === 409, r);
  r = await call('PUT', `/admin/accounts/${aliceId}/approve`, { token: adminToken });
  check('approve alice -> APPROVED', r.status === 200 && r.body?.status === 'APPROVED', r);
  r = await call('PUT', `/admin/accounts/${aliceId}/approve`, { token: adminToken });
  check('approve twice -> 409', r.status === 409, r);
  r = await call('GET', '/admin/nope', { token: adminToken });
  check('unknown admin path -> 404', r.status === 404, r);

  // ---- 5. Approved user: setup gate data ----
  r = await call('POST', '/auth/login', { body: { email: userA, password: pw } });
  check('approved login -> 200', r.status === 200 && r.body?.accountStatus === 'APPROVED', r);
  check('new approved user: hasFarm=false', r.body?.setup?.hasFarm === false, r.body?.setup);
  let tok = r.body.token;
  r = await call('GET', '/ponds', { token: tok });
  check('no farm yet: /ponds -> 409 FARM_REQUIRED', r.status === 409 && r.body?.code === 'FARM_REQUIRED', r);
  r = await call('POST', '/ponds', { token: tok, body: { name: 'Pond X' } });
  check('no farm yet: POST /ponds -> 409 (not 500)', r.status === 409, r);
  r = await call('POST', '/farm', { token: tok, body: {} });
  check('POST /farm without name -> 400', r.status === 400, r);
  r = await call('POST', '/farm', { token: tok, body: { farmName: 'Reyes AquaFarm', city: 'Calapan City', barangay: 'Salong', province: 'Oriental Mindoro', zip: '5200' } });
  check('POST /farm -> 201 + new token', r.status === 201 && r.body?.farmId && r.body?.token, r);
  const aliceFarm = r.body.farmId; tok = r.body.token;
  r = await call('POST', '/farm', { token: tok, body: { farmName: 'Second' } });
  check('second farm -> 409', r.status === 409, r);
  r = await call('GET', '/auth/me', { token: tok });
  check('/me after farm: hasFarm, 0 ponds, 0 devices', r.body?.setup?.hasFarm && r.body.setup.pondCount === 0 && r.body.setup.deviceCount === 0 && r.body.setup.setupComplete === false, r.body);

  // ---- 6. Ponds + devices ----
  r = await call('POST', '/ponds', { token: tok, body: { name: 'Pond A', size: '0.5 hectare' } });
  check('create Pond A', r.status === 201, r); const pondA = r.body.id;
  r = await call('POST', '/ponds', { token: tok, body: { name: 'Pond B' } });
  check('create Pond B', r.status === 201, r); const pondB = r.body.id;
  r = await call('GET', '/auth/me', { token: tok });
  check('/me: 2 ponds, 0 devices, setup not complete', r.body?.setup?.pondCount === 2 && r.body.setup.deviceCount === 0 && !r.body.setup.setupComplete, r.body?.setup);
  r = await call('POST', '/devices', { token: tok, body: { name: 'Device Alpha' } });
  check('register device -> key returned', r.status === 201 && /^dk_/.test(r.body?.deviceKey), r); 
  const dev = r.body.id, devKey = r.body.deviceKey;
  r = await call('GET', '/auth/me', { token: tok });
  check('/me: setupComplete once ponds+device exist', r.body?.setup?.setupComplete === true, r.body?.setup);

  // ---- 7. Remote pond assignment ----
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': devKey } });
  check('config for unassigned device: pond_id null', r.status === 200 && r.body.pond_id === null && r.body.pond_name === null && r.body.farm_id === aliceFarm, r);
  r = await call('POST', '/ingest/readings', { body: { deviceKey: devKey, temperature: 28, phLevel: 7.5, dissolvedOxygen: 6, salinity: 15 } });
  check('ingest while unassigned -> 409 (existing behavior)', r.status === 409, r);

  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: Number(pondA) } });
  check('PUT /devices/:id/pond -> Pond A', r.status === 200 && r.body.pond_name === 'Pond A', r);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': devKey } });
  check('config now shows Pond A', r.body?.pond_id === Number(pondA) && r.body?.pond_name === 'Pond A', r.body);
  r = await call('POST', '/ingest/readings', { body: { deviceKey: devKey, temperature: 28, phLevel: 7.5, dissolvedOxygen: 6, salinity: 15 } });
  check('ingest after assignment -> 201', r.status === 201, r);

  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: String(pondB) } });
  check('reassign to Pond B (string id accepted)', r.status === 200 && r.body.pond_name === 'Pond B', r);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': devKey } });
  check('config now shows Pond B (device would pick this up)', r.body?.pond_id === Number(pondB) && r.body?.pond_name === 'Pond B', r.body);

  // validation
  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: 1 } });
  check("other farm's pond (id 1) -> 404, assignment unchanged", r.status === 404, r);
  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: { pond_id: 999999 } });
  check('nonexistent pond -> 404', r.status === 404, r);
  r = await call('PUT', `/devices/${dev}/pond`, { token: tok, body: {} });
  check('missing pond_id -> 400', r.status === 400, r);
  r = await call('PUT', `/devices/1/pond`, { token: tok, body: { pond_id: Number(pondA) } });
  check("other farm's device -> 404", r.status === 404, r);
  r = await call('PUT', `/devices/${dev}/pond`, { body: { pond_id: Number(pondA) } });
  check('no token -> 401', r.status === 401, r);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': devKey } });
  check('failed attempts did not change assignment', r.body?.pond_id === Number(pondB), r.body);

  // config auth
  r = await call('GET', `/devices/${dev}/config`);
  check('config without key -> 401', r.status === 401, r);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': 'dk_wrong' } });
  check('config wrong key -> 401', r.status === 401, r);
  r = await call('GET', `/devices/1/config`, { headers: { 'x-device-key': devKey } });
  check("alice's key can't read demo device 1 config -> 401", r.status === 401, r);
  r = await call('GET', `/devices/${dev}/config`, { token: tok });
  check('JWT alone is not enough for config -> 401', r.status === 401, r);

  // existing endpoints hardened / fixed
  r = await call('PUT', `/devices/${dev}`, { token: tok, body: { name: 'Renamed Alpha' } });
  check('rename only -> 200', r.status === 200, r);
  r = await call('GET', `/devices/${dev}/config`, { headers: { 'x-device-key': devKey } });
  check('rename does NOT unassign the device', r.body?.pond_id === Number(pondB), r.body);
  r = await call('PUT', `/devices/${dev}`, { token: tok, body: { name: 'Renamed Alpha', pondId: 1 } });
  check("legacy PUT /devices/:id with other farm's pond -> 400", r.status === 400, r);
  r = await call('POST', `/devices/${dev}/assign`, { token: tok, body: { pondId: 1 } });
  check("legacy POST /assign with other farm's pond -> 400", r.status === 400, r);
  r = await call('POST', `/devices/${dev}/assign`, { token: tok, body: { pondId: Number(pondA) } });
  check('legacy POST /assign own pond -> 200', r.status === 200, r);
  r = await call('GET', '/devices', { token: tok });
  check('GET /devices lists it under Pond A', r.body?.[0]?.pond === 'Pond A' && r.body[0].name === 'Renamed Alpha', r.body);

  // demo farm untouched
  r = await call('GET', '/devices', { token: farmerToken });
  check('demo farm still has its 5 devices', r.body?.length === 5, r.body?.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

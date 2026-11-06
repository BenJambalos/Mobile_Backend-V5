// One-time seeding script — generates realistic demo data directly in
// MySQL (base rows + a real multi-day water_quality_readings time series)
// so the Reports aggregation queries have something genuine to chew on.
// After running this, we `mysqldump` the result into seed_data.sql so
// the person receives a plain, guaranteed-valid SQL file — this script
// itself is not part of the deliverable.
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const DEVICE_KEY_1 = 'dk_' + require('crypto').randomBytes(16).toString('hex');
const DEVICE_KEY_2 = 'dk_' + require('crypto').randomBytes(16).toString('hex');
const DEVICE_KEY_3 = 'dk_' + require('crypto').randomBytes(16).toString('hex');
const DEVICE_KEY_4 = 'dk_' + require('crypto').randomBytes(16).toString('hex');
const DEVICE_KEY_5 = 'dk_' + require('crypto').randomBytes(16).toString('hex');

function randWalk(base, stepMax, min, max) {
  let v = base + (Math.random() * 2 - 1) * stepMax;
  return Math.max(min, Math.min(max, v));
}

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'hyquai_app',
    password: 'hyquai_dev_pw',
    database: 'hyquai_db',
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  console.log('Clearing existing data...');
  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of ['activity_logs','password_resets','early_warning_notifications','water_quality_forecasts',
                    'water_quality_readings','device_maintenance','device_status','monitoring_devices',
                    'parameter_thresholds','ponds','aquaculture_farms','user_profiles','accounts']) {
    await conn.query(`TRUNCATE TABLE ${t}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS=1');

  // --- accounts + user_profiles ---
  const passwordHash = bcrypt.hashSync('HyQuai123!', 10);
  const [acc] = await conn.query(
    `INSERT INTO accounts (username, password_hash, role, status) VALUES (?, ?, 'farm_owner', 'active')`,
    ['farmer@hyquai.demo', passwordHash]
  );
  const accountId = acc.insertId;

  await conn.query(
    `INSERT INTO user_profiles (account_id, first_name, middle_name, last_name, email, phone)
     VALUES (?, 'Juan', 'Dela', 'Cruz', 'jdelacruz@qumon.ph', '09512783262')`,
    [accountId]
  );

  // --- farm ---
  const [farm] = await conn.query(
    `INSERT INTO aquaculture_farms (owner_id, farm_name, street, barangay, municipality, province, zip_code, location)
     VALUES (?, 'Juan Dela Cruz Farm', NULL, 'Barangay Salong', 'Calapan City', 'Oriental Mindoro', '5200', 'Masipit Shrimp Farm')`,
    [accountId]
  );
  const farmId = farm.insertId;

  // --- thresholds (farm-wide defaults) ---
  const thresholds = [
    ['temperature', 25.00, 30.00],
    ['ph', 6.50, 8.50],
    ['dissolved_oxygen', 5.00, 12.00],
    ['salinity', 10.00, 25.00],
  ];
  for (const [param, min, max] of thresholds) {
    await conn.query(
      `INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?, ?, ?, ?)`,
      [farmId, param, min, max]
    );
  }

  // --- ponds ---
  const pondDefs = [
    { name: 'Pond A', volume: 0.50 },
    { name: 'Pond B', volume: 0.50 },
    { name: 'Pond C', volume: 0.75 },
    { name: 'Pond D', volume: 0.40 },
  ];
  const pondIds = {};
  for (const p of pondDefs) {
    const [r] = await conn.query(
      `INSERT INTO ponds (farm_id, pond_name, volume) VALUES (?, ?, ?)`,
      [farmId, p.name, p.volume]
    );
    pondIds[p.name] = r.insertId;
  }

  // --- devices ---
  const deviceDefs = [
    { name: 'Device 1', pond: 'Pond A', status: 'active', key: DEVICE_KEY_1 },
    { name: 'Device 2', pond: 'Pond B', status: 'active', key: DEVICE_KEY_2 },
    { name: 'Device 3', pond: 'Pond C', status: 'active', key: DEVICE_KEY_3 },
    { name: 'Device 4', pond: 'Pond D', status: 'active', key: DEVICE_KEY_4 },
    { name: 'Device 5', pond: null, status: 'inactive', key: DEVICE_KEY_5 },
  ];
  const deviceIds = {};
  for (const d of deviceDefs) {
    const [r] = await conn.query(
      `INSERT INTO monitoring_devices (farm_id, pond_id, device_name, status, device_key) VALUES (?, ?, ?, ?, ?)`,
      [farmId, d.pond ? pondIds[d.pond] : null, d.name, d.status, d.key]
    );
    deviceIds[d.name] = r.insertId;
  }

  // --- device_status snapshots (current) ---
  const statusDefs = [
    { name: 'Device 1', battery: 87, charging: 1, conn: 'online', signal: 'Stable', sensors: 4 },
    { name: 'Device 2', battery: 74, charging: 1, conn: 'online', signal: 'Stable', sensors: 4 },
    { name: 'Device 3', battery: 62, charging: 0, conn: 'online', signal: 'Stable', sensors: 4 },
    { name: 'Device 4', battery: 12, charging: 0, conn: 'offline', signal: 'Unstable', sensors: 0 },
    { name: 'Device 5', battery: 100, charging: 0, conn: 'offline', signal: 'Unstable', sensors: 0 },
  ];
  for (const s of statusDefs) {
    await conn.query(
      `INSERT INTO device_status (device_id, battery_percentage, is_charging, connectivity_status, signal_strength, active_sensors_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [deviceIds[s.name], s.battery, s.charging, s.conn, s.signal, s.sensors]
    );
  }

  // --- water_quality_readings: 7 days, every 15 min, per active device ---
  // Base targets per pond (matches what the Flutter app currently shows
  // as the "current" reading — the last row of each series lands here).
  const readingTargets = {
    'Pond A': { device: 'Device 1', temp: 28.4, ph: 7.8, do: 5.1, sal: 14, offlineAfter: null },
    'Pond B': { device: 'Device 2', temp: 28.4, ph: 7.8, do: 6.2, sal: 14, offlineAfter: null },
    'Pond C': { device: 'Device 3', temp: 31.6, ph: 6.3, do: 2.6, sal: 9,  offlineAfter: null },
    // Pond D's device is offline — stop generating "fresh" readings 3
    // hours before "now" so the last reading is genuinely stale.
    'Pond D': { device: 'Device 4', temp: 27.9, ph: 7.5, do: 5.8, sal: 13, offlineAfter: 3 * 60 },
  };

  const now = new Date();
  const days = 7;
  const stepMinutes = 15;
  const totalSteps = (days * 24 * 60) / stepMinutes;

  for (const [pondName, t] of Object.entries(readingTargets)) {
    const deviceId = deviceIds[t.device];
    let temp = t.temp, ph = t.ph, dox = t.do, sal = t.sal;
    const rows = [];
    for (let i = totalSteps; i >= 0; i--) {
      const minutesAgo = i * stepMinutes;
      if (t.offlineAfter !== null && minutesAgo < t.offlineAfter) continue; // device was offline
      const ts = new Date(now.getTime() - minutesAgo * 60000);
      // random walk toward the target, mild daily cycle on temperature
      temp = randWalk(temp, 0.15, 24, 33);
      ph = randWalk(ph, 0.03, 6.0, 8.8);
      dox = randWalk(dox, 0.08, Math.max(1.5, t.do - 1.5), t.do + 1.5);
      sal = randWalk(sal, 0.15, 7, 28);
      rows.push([deviceId, pondIds[pondName], temp.toFixed(2), ph.toFixed(2), dox.toFixed(2), sal.toFixed(2), ts]);
    }
    // force the very last row to match the exact "current" target values
    if (rows.length) {
      // Row layout: [device_id, pond_id, temperature, ph, do, salinity, recorded_at]
      // (pond_id sits at index 1, so the measurements are indices 2-5.)
      const last = rows[rows.length - 1];
      last[2] = t.temp.toFixed(2);
      last[3] = t.ph.toFixed(2);
      last[4] = t.do.toFixed(2);
      last[5] = t.sal.toFixed(2);
    }
    // batch insert
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await conn.query(
        `INSERT INTO water_quality_readings (device_id, pond_id, temperature, ph_level, dissolved_oxygen, salinity, recorded_at) VALUES ?`,
        [chunk]
      );
    }
    console.log(`Inserted ${rows.length} readings for ${pondName}`);
  }

  // --- water_quality_forecasts: next 3h/6h/12h per active pond, DO focus + others ---
  const forecastDefs = [
    { pond: 'Pond A', param: 'dissolved_oxygen', vals: [4.95, 4.80, 4.70] },
    { pond: 'Pond C', param: 'dissolved_oxygen', vals: [2.40, 2.20, 2.05] },
  ];
  for (const f of forecastDefs) {
    const offsets = [3, 6, 12];
    for (let i = 0; i < offsets.length; i++) {
      const predictedFor = new Date(now.getTime() + offsets[i] * 3600000);
      await conn.query(
        `INSERT INTO water_quality_forecasts (farm_id, pond_id, parameter, forecast_value, predicted_for)
         VALUES (?, ?, ?, ?, ?)`,
        [farmId, pondIds[f.pond], f.param, f.vals[i], predictedFor]
      );
    }
  }

  // --- early_warning_notifications ---
  const notifDefs = [
    {
      pond: 'Pond A', device: 'Device 1', param: 'dissolved_oxygen',
      title: 'Moderate Risk -Low DO', level: 'medium',
      msg: 'DO level at 5.1, above the safe threshold of \u2265 5 mg/L',
      action: 'Increase aeration in Pond A and re-check dissolved oxygen every 30 minutes until it stabilizes above 5 mg/L.',
      resolved: 0, read: 1, hoursAgo: 2,
    },
    {
      pond: 'Pond A', device: 'Device 1', param: 'dissolved_oxygen',
      title: 'High Risk -Low Dissolve Oxygen', level: 'critical',
      msg: 'DO level at 2.8 mg/L, above the safe threshold of \u2265 5 mg/L',
      action: 'Run emergency aeration immediately and inspect for the cause of the drop (overstocking, organic buildup, or equipment failure).',
      resolved: 1, read: 1, hoursAgo: 26,
    },
    {
      pond: 'Pond A', device: 'Device 1', param: 'ph',
      title: 'Moderate High ph', level: 'medium',
      msg: 'pH trending toward 6.5, nearing the unsafe threshold of \u2265 7.0.',
      action: 'Monitor pH hourly and avoid adding lime or other pH-raising treatments until it stabilizes.',
      resolved: 1, read: 1, hoursAgo: 26,
    },
    {
      pond: 'Pond D', device: 'Device 4', param: null,
      title: 'Device Offline', level: 'low',
      msg: 'No data received from sensor. Check power and connectivity.',
      action: "Check the device's solar panel and battery, and confirm it is within Wi-Fi range.",
      resolved: 0, read: 1, hoursAgo: 27,
    },
    {
      pond: 'Pond B', device: 'Device 2', param: null,
      title: 'Water Quality Restored', level: 'low',
      msg: 'All readings are back within safe range after a brief dip yesterday.',
      action: 'No action needed \u2014 continue routine monitoring.',
      resolved: 1, read: 1, hoursAgo: 4,
    },
  ];
  for (const n of notifDefs) {
    const createdAt = new Date(now.getTime() - n.hoursAgo * 3600000);
    await conn.query(
      `INSERT INTO early_warning_notifications
         (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [farmId, pondIds[n.pond], deviceIds[n.device], n.param, n.title, n.level, n.msg, n.action, n.resolved, n.read, createdAt]
    );
  }

  // --- activity_logs (a few sample entries) ---
  await conn.query(
    `INSERT INTO activity_logs (account_id, action_type, action_description, logged_at) VALUES
     (?, 'account_created', 'Farm account registered.', ?),
     (?, 'login', 'Signed in from mobile app.', ?)`,
    [accountId, new Date(now.getTime() - 40 * 24 * 3600000), accountId, new Date(now.getTime() - 3600000)]
  );

  console.log('\nDone. Device keys generated (save these for your device firmware / .env):');
  for (const d of deviceDefs) console.log(`  ${d.name}: ${d.key}`);

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

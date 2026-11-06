const express = require('express');
const pool = require('../db');
const { requireAuth, signToken } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/profile
router.get('/profile', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.account_id, a.username, a.role, up.first_name, up.middle_name, up.last_name, up.email, up.phone
     FROM accounts a JOIN user_profiles up ON up.account_id = a.account_id
     WHERE a.account_id = ?`,
    [req.accountId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
  res.json(rows[0]);
});

// PUT /api/profile  { firstName, middleName, lastName, email, phone }
router.put('/profile', async (req, res) => {
  const { firstName, middleName, lastName, email, phone } = req.body;
  await pool.query(
    `UPDATE user_profiles SET
       first_name = COALESCE(?, first_name),
       middle_name = ?,
       last_name = COALESCE(?, last_name),
       email = COALESCE(?, email),
       phone = ?
     WHERE account_id = ?`,
    [firstName, middleName ?? null, lastName, email, phone ?? null, req.accountId]
  );
  res.json({ message: 'Profile updated.' });
});

// GET /api/farm
router.get('/farm', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM aquaculture_farms WHERE farm_id = ?', [req.farmId]);
  if (!rows.length) return res.status(404).json({ error: 'Farm not found' });
  res.json(rows[0]);
});

// POST /api/farm  { farmName, city, barangay, province, zip }
// "Farm Setup" step for an approved account that has no farm yet. Moved
// here from signup (which now only creates a pending account). Returns a
// fresh token because the old one was issued with farmId = null.
const DEFAULT_THRESHOLDS = [
  ['temperature', 25.0, 30.0],
  ['ph', 6.5, 8.5],
  ['dissolved_oxygen', 5.0, 12.0],
  ['salinity', 10.0, 25.0],
];

router.post('/farm', async (req, res) => {
  const { farmName, city, barangay, province, zip } = req.body;
  if (!farmName || !String(farmName).trim()) return res.status(400).json({ error: 'farmName is required' });

  const [accRows] = await pool.query('SELECT role, status FROM accounts WHERE account_id = ?', [req.accountId]);
  const account = accRows[0];
  if (!account || account.status !== 'active') return res.status(403).json({ error: 'Account is not approved' });
  if (account.role !== 'farm_owner') return res.status(403).json({ error: 'Only farm owner accounts can create a farm' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query('SELECT farm_id FROM aquaculture_farms WHERE owner_id = ? LIMIT 1 FOR UPDATE', [req.accountId]);
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'You already have a farm' });
    }

    const [farmRes] = await conn.query(
      `INSERT INTO aquaculture_farms (owner_id, farm_name, barangay, municipality, province, zip_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.accountId, String(farmName).trim(), barangay || null, city || null, province || null, zip || null]
    );
    const farmId = farmRes.insertId;

    // Same standard thresholds signup used to seed, so status/warning logic
    // has something to compare against as soon as the farm exists.
    for (const [param, min, max] of DEFAULT_THRESHOLDS) {
      await conn.query(
        `INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?, ?, ?, ?)`,
        [farmId, param, min, max]
      );
    }

    await conn.query(
      `INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, 'farm_created', 'Farm created during setup.')`,
      [req.accountId]
    );

    await conn.commit();
    res.status(201).json({ farmId, token: signToken({ accountId: req.accountId, farmId }) });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PUT /api/farm  { farmName, city, barangay, province, zip }
router.put('/farm', async (req, res) => {
  const { farmName, city, barangay, province, zip } = req.body;
  await pool.query(
    `UPDATE aquaculture_farms SET
       farm_name = COALESCE(?, farm_name),
       municipality = COALESCE(?, municipality),
       barangay = COALESCE(?, barangay),
       province = COALESCE(?, province),
       zip_code = COALESCE(?, zip_code)
     WHERE farm_id = ?`,
    [farmName, city, barangay, province, zip, req.farmId]
  );
  res.json({ message: 'Farm details updated.' });
});

module.exports = router;

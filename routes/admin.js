const express = require('express');
const pool = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

// GET /api/admin/accounts/pending
router.get('/accounts/pending', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.account_id,
            TRIM(CONCAT_WS(' ', up.first_name, up.middle_name, up.last_name)) AS name,
            COALESCE(up.email, a.username) AS email,
            a.created_at
     FROM accounts a
     LEFT JOIN user_profiles up ON up.account_id = a.account_id
     WHERE a.status = 'pending' AND a.role = 'farm_owner'
     ORDER BY a.created_at ASC, a.account_id ASC`
  );
  res.json({
    accounts: rows.map((r) => ({
      account_id: r.account_id,
      name: r.name,
      email: r.email,
      status: 'PENDING',
      created_at: r.created_at,
    })),
  });
});

// Shared by approve/reject: validates the target and returns it, or sends
// the error response itself and returns null.
async function loadTarget(req, res) {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'Invalid account id' });
    return null;
  }
  const [rows] = await pool.query('SELECT account_id, username, role, status FROM accounts WHERE account_id = ?', [accountId]);
  const target = rows[0];
  if (!target) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  if (target.role !== 'farm_owner') {
    res.status(400).json({ error: 'Only farm owner accounts go through approval' });
    return null;
  }
  return target;
}

async function logAction(adminId, actionType, description) {
  await pool.query(
    'INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, ?, ?)',
    [adminId, actionType, description]
  );
}

// PUT /api/admin/accounts/:accountId/approve
// pending -> active (APPROVED). A previously rejected account can also be
// approved (e.g. rejected by mistake). disabled/suspended accounts are NOT
// re-enabled through this route.
router.put('/accounts/:accountId/approve', async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;

  if (target.status === 'active') return res.status(409).json({ error: 'Account is already approved' });
  if (target.status !== 'pending' && target.status !== 'rejected') {
    return res.status(409).json({ error: `Account is ${target.status} and cannot be approved here` });
  }

  const [result] = await pool.query(
    `UPDATE accounts SET status = 'active' WHERE account_id = ? AND status IN ('pending', 'rejected')`,
    [target.account_id]
  );
  if (!result.affectedRows) return res.status(409).json({ error: 'Account status changed, please refresh' });

  await logAction(req.accountId, 'account_approved', `Approved account #${target.account_id} (${target.username}).`);
  res.json({ message: 'Account approved.', account_id: target.account_id, status: 'APPROVED' });
});

// PUT /api/admin/accounts/:accountId/reject
// Only pending accounts can be rejected, so an approved farm that is
// already running can't be knocked out through this route.
router.put('/accounts/:accountId/reject', async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;

  if (target.status === 'rejected') return res.status(409).json({ error: 'Account is already rejected' });
  if (target.status !== 'pending') {
    return res.status(409).json({ error: `Only pending accounts can be rejected (account is ${target.status})` });
  }

  const [result] = await pool.query(
    `UPDATE accounts SET status = 'rejected' WHERE account_id = ? AND status = 'pending'`,
    [target.account_id]
  );
  if (!result.affectedRows) return res.status(409).json({ error: 'Account status changed, please refresh' });

  await logAction(req.accountId, 'account_rejected', `Rejected account #${target.account_id} (${target.username}).`);
  res.json({ message: 'Account rejected.', account_id: target.account_id, status: 'REJECTED' });
});

// Unknown /api/admin/* paths stop here instead of falling through to the
// farm-scoped routers below (which would answer a Super Admin with FARM_REQUIRED).
router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;

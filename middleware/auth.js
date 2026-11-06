const jwt = require('jsonwebtoken');
const pool = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.accountId = payload.accountId;
    req.farmId = payload.farmId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Approved accounts that haven't created their farm yet carry a token with
// farmId = null. Every farm-scoped route (ponds, devices, notifications,
// reports) runs behind this so they answer with a clear "finish setup"
// error instead of querying `farm_id = NULL` or failing an INSERT.
function requireFarm(req, res, next) {
  if (!req.farmId) {
    return res.status(409).json({ error: 'Farm setup is not complete yet', code: 'FARM_REQUIRED' });
  }
  next();
}

// Role is read from the database on every call (not from the JWT) so a
// role/status change by an admin takes effect immediately instead of
// after the token expires. Must run after requireAuth.
async function requireSuperAdmin(req, res, next) {
  const [rows] = await pool.query('SELECT role, status FROM accounts WHERE account_id = ?', [req.accountId]);
  const account = rows[0];
  if (!account || account.role !== 'super_admin' || account.status !== 'active') {
    return res.status(403).json({ error: 'Super Admin access required' });
  }
  next();
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = { requireAuth, requireFarm, requireSuperAdmin, signToken };

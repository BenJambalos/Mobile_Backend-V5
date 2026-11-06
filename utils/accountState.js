const pool = require('../db');

// DB value -> API value. 'active' is the pre-existing "good" status, so it
// is reused as APPROVED rather than adding a second, duplicate value.
const STATUS_LABEL = {
  pending: 'PENDING',
  active: 'APPROVED',
  rejected: 'REJECTED',
  disabled: 'DISABLED',
  suspended: 'SUSPENDED',
};

function statusLabel(dbStatus) {
  return STATUS_LABEL[dbStatus] || String(dbStatus || '').toUpperCase();
}

// Where the farmer is in Farm -> Ponds -> Devices setup. Read from the
// database (not the JWT) so it is correct right after each setup step.
async function getSetupState(accountId) {
  const [farms] = await pool.query(
    'SELECT farm_id FROM aquaculture_farms WHERE owner_id = ? ORDER BY farm_id LIMIT 1',
    [accountId]
  );
  const farmId = farms[0]?.farm_id || null;
  if (!farmId) {
    return { farmId: null, hasFarm: false, pondCount: 0, deviceCount: 0, setupComplete: false };
  }
  const [[ponds]] = await pool.query('SELECT COUNT(*) AS n FROM ponds WHERE farm_id = ?', [farmId]);
  const [[devices]] = await pool.query('SELECT COUNT(*) AS n FROM monitoring_devices WHERE farm_id = ?', [farmId]);
  return {
    farmId,
    hasFarm: true,
    pondCount: ponds.n,
    deviceCount: devices.n,
    setupComplete: ponds.n > 0 && devices.n > 0,
  };
}

module.exports = { statusLabel, getSetupState };

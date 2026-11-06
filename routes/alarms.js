const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { PONDS_QUERY, getThresholds, criticalAlarms } = require('../utils/pondState');

const router = express.Router();
router.use(requireAuth, requireFarm);

// GET /api/alarms
// Every parameter that is CRITICAL right now (and being measured by an online
// device). The app polls this every few seconds and sounds a loud alarm while
// the list is not empty. It is computed from the live pond state, not from the
// notification log, so it stops by itself the moment the water is back in range,
// the device is moved away, or the device goes offline.
router.get('/alarms', async (req, res) => {
  const thresholds = await getThresholds(req.farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' ORDER BY p.pond_id', [req.farmId]);
  const alarms = rows.flatMap((r) => criticalAlarms(r, thresholds));
  res.set('Cache-Control', 'no-store');
  res.json({ count: alarms.length, alarms });
});

module.exports = router;

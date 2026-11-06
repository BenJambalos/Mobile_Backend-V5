require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const pondsRoutes = require('./routes/ponds');
const riskRoutes = require('./routes/risk');
const devicesRoutes = require('./routes/devices');
const ingestRoutes = require('./routes/ingest');
const notificationsRoutes = require('./routes/notifications');
const alarmsRoutes = require('./routes/alarms');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const pool = require('./db');
const { startOfflineMonitor } = require('./utils/deviceHealth');
const { startStaleMonitor } = require('./utils/readingFreshness');
const monitorState = require('./utils/monitorState');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
// Proof that the background monitors (device offline every 60 s, outdated
// readings every 5 min) are running in THIS deployed process. `healthy` is true
// when each ran within two intervals and its last run did not fail. Contains
// no credentials or farm data, only timers.
app.get('/api/health/monitors', (req, res) => {
  const monitors = monitorState.snapshot();
  res.status(monitors.every((m) => m.healthy) && monitors.length ? 200 : 503).json({ monitors, serverTime: new Date().toISOString() });
});
// Same as /api/health but also proves the database connection works.
// Open it in a browser after deploying: {"status":"ok","db":"ok"}.
app.get('/api/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', code: err.code || null });
  }
});

app.use('/api/auth', authRoutes);
// ingestRoutes must be mounted before any router below, since those
// routers apply `router.use(requireAuth)` for ALL /api/* traffic that
// reaches them (including paths they don't define, like /ingest/*) —
// Express stops at the first router that sends a response, so ingest
// requests need to hit their own (unauthenticated, device-key-based)
// routes before reaching another router's blanket auth check.
app.use('/api', ingestRoutes);
// Super Admin routes: mounted on their own /api/admin prefix and BEFORE the
// farm-scoped routers below, which require a farm a Super Admin doesn't have.
app.use('/api/admin', adminRoutes);
app.use('/api', profileRoutes);
app.use('/api', pondsRoutes);
app.use('/api', riskRoutes);
app.use('/api', devicesRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', alarmsRoutes);
app.use('/api', reportsRoutes);

// Express 5 forwards thrown/rejected errors from async handlers here
// automatically — no extra try/catch or middleware package needed.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`HyQual API listening on port ${PORT}`);
  // Say it loudly in the logs if the database can't be reached, instead of
  // waiting for the first request to fail with a 500.
  pool.query('SELECT 1')
    .then(() => console.log('Database connection OK'))
    .catch((err) => console.error('Database connection FAILED:', err.code || err.message));
  startOfflineMonitor();
  startStaleMonitor();
});

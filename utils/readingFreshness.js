// Outdated-reading detection (QA finding D).
//
// The offline monitor (utils/deviceHealth.js) notices a device that stopped
// TALKING to the server. This one notices a device that is still talking but
// whose READINGS stopped arriving or were never valid (dead probe cable,
// sensor board fault, readings rejected by the server). The two are different
// problems and are reported separately:
//
//   device silent                -> "Device Offline"      (grey)
//   device online, readings old  -> "Outdated Readings"   (neutral / stale)
//   water out of range           -> Warning / Critical    (amber / red)
//
// Rules
//   * Runs every STALE_CHECK_INTERVAL_SECONDS (default 300 = 5 minutes).
//   * A pond is stale when its device is online and the newest reading taken
//     since the device entered the pond is older than READING_STALE_AFTER_SECONDS
//     (default 900 = 15 minutes), or no reading has arrived that long after the
//     device was assigned.
//   * One open alert per pond. Medium at first; it ESCALATES in place to high
//     after STALE_ESCALATE_AFTER_SECONDS (default 3600) and is marked unread
//     again. While open, its text is refreshed, never duplicated.
//   * It RESOLVES when a fresh reading arrives (immediately at ingest, and
//     again here as a safety net) or when the device goes offline (the offline
//     alert then takes over).
//   * A MySQL named lock makes concurrent sweeps (two replicas, a restart
//     overlap) harmless.
const pool = require('../db');
const { connectivitySql } = require('./deviceHealth');
const { STALE_READING_SECONDS } = require('./pondState');
const { formatDateTime } = require('./time');
const monitorState = require('./monitorState');

const STALE_TITLE = 'Outdated Readings';
const CHECK_INTERVAL_SECONDS = Math.max(5, parseInt(process.env.STALE_CHECK_INTERVAL_SECONDS, 10) || 300);
const ESCALATE_AFTER_SECONDS = Math.max(STALE_READING_SECONDS, parseInt(process.env.STALE_ESCALATE_AFTER_SECONDS, 10) || 3600);
const LEVEL_RANK = { medium: 1, high: 2 };
const LOCK_NAME = 'hyqual:stale_reading_sweep';

function humanAge(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `${Math.floor(hrs / 24)} days`;
}

const ACTION = 'Check the sensor probes and cables, the device power and its Wi-Fi. The values shown for this pond are out of date until new readings arrive.';

// Called by the ingest route when a FRESH reading is stored, so the alert
// clears the moment data flows again instead of at the next sweep.
async function resolveStaleAlert(db, pondId) {
  const [r] = await db.query(
    'UPDATE early_warning_notifications SET is_resolved = 1 WHERE pond_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0',
    [pondId, STALE_TITLE]
  );
  return r.affectedRows;
}

async function sweepStaleReadings(db = pool) {
  const stats = { checked: 0, stale: 0, created: 0, escalated: 0, updated: 0, resolved: 0, skipped: false };
  const lockConn = await db.getConnection();
  try {
    const [[lock]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
    if (!Number(lock.got)) { stats.skipped = true; return stats; }

    const [ponds] = await db.query(
      `SELECT p.pond_id, p.farm_id, p.pond_name, md.device_id, md.device_name,
              TIMESTAMPDIFF(SECOND, md.assigned_at, NOW()) AS assigned_age_s,
              ${connectivitySql('ds')} AS connectivity_status,
              wr.recorded_at, TIMESTAMPDIFF(SECOND, wr.recorded_at, NOW()) AS reading_age_s
       FROM ponds p
       JOIN monitoring_devices md ON md.pond_id = p.pond_id
       LEFT JOIN device_status ds ON ds.device_id = md.device_id
       LEFT JOIN water_quality_readings wr ON wr.reading_id = (
         SELECT wr2.reading_id FROM water_quality_readings wr2
         WHERE wr2.pond_id = p.pond_id AND (md.assigned_at IS NULL OR wr2.recorded_at >= md.assigned_at)
         ORDER BY wr2.recorded_at DESC, wr2.reading_id DESC LIMIT 1
       )`
    );

    for (const p of ponds) {
      stats.checked++;
      const [open] = await db.query(
        'SELECT notification_id, alert_level FROM early_warning_notifications WHERE pond_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0 ORDER BY notification_id DESC LIMIT 1',
        [p.pond_id, STALE_TITLE]
      );

      // Offline device: the "Device Offline" alert covers it; do not also call
      // the data stale. Clear any stale alert so the pond shows one clear cause.
      if (p.connectivity_status === 'offline') {
        if (open.length) stats.resolved += await resolveStaleAlert(db, p.pond_id);
        continue;
      }

      const hasReading = p.recorded_at !== null && p.recorded_at !== undefined;
      const age = hasReading ? Number(p.reading_age_s) : Number(p.assigned_age_s ?? 0);
      const isStale = age > STALE_READING_SECONDS;

      if (!isStale) {
        if (open.length) stats.resolved += await resolveStaleAlert(db, p.pond_id);
        continue;
      }
      stats.stale++;

      const level = age > ESCALATE_AFTER_SECONDS ? 'high' : 'medium';
      const message = hasReading
        ? `No new readings from ${p.device_name} (${p.pond_name}) for ${humanAge(age)}. Last reading: ${formatDateTime(p.recorded_at)}.`
        : `${p.device_name} is online but has not delivered any reading for ${p.pond_name} in ${humanAge(age)} since it was assigned.`;

      if (!open.length) {
        await db.query(
          `INSERT INTO early_warning_notifications
             (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)`,
          [p.farm_id, p.pond_id, p.device_id, STALE_TITLE, level, message, ACTION]
        );
        stats.created++;
      } else if (LEVEL_RANK[level] > LEVEL_RANK[open[0].alert_level]) {
        // Severity went up: update the SAME alert, move it to the top and make it unread again.
        await db.query(
          'UPDATE early_warning_notifications SET alert_level = ?, alert_message = ?, is_read = 0, created_at = NOW() WHERE notification_id = ?',
          [level, message, open[0].notification_id]
        );
        stats.escalated++;
      } else {
        await db.query('UPDATE early_warning_notifications SET alert_message = ? WHERE notification_id = ?', [message, open[0].notification_id]);
        stats.updated++;
      }
    }
    return stats;
  } finally {
    try { await lockConn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch { /* connection gone: lock released with it */ }
    lockConn.release();
  }
}

function startStaleMonitor() {
  if (String(process.env.STALE_MONITOR || '').toLowerCase() === 'off') {
    console.log('Stale-reading monitor: disabled (STALE_MONITOR=off)');
    return null;
  }
  monitorState.register('staleReadings', CHECK_INTERVAL_SECONDS);
  const run = async () => {
    const started = Date.now();
    try {
      const result = await sweepStaleReadings();
      monitorState.recordRun('staleReadings', { durationMs: Date.now() - started, result });
    } catch (err) {
      console.error('Stale-reading monitor failed:', err.code || err.message);
      monitorState.recordRun('staleReadings', { durationMs: Date.now() - started, error: err.code || err.message });
    }
  };
  setTimeout(run, 8000).unref();
  const timer = setInterval(run, CHECK_INTERVAL_SECONDS * 1000);
  timer.unref();
  console.log(`Stale-reading monitor: every ${CHECK_INTERVAL_SECONDS}s, readings older than ${STALE_READING_SECONDS}s are outdated`);
  return timer;
}

module.exports = { STALE_TITLE, CHECK_INTERVAL_SECONDS, sweepStaleReadings, resolveStaleAlert, startStaleMonitor };

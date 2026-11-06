// The ONE place that moves a device between ponds. Every endpoint that can
// change monitoring_devices.pond_id (PUT /devices/:id, POST /devices/:id/assign,
// PUT /devices/:id/pond, POST /devices) goes through assignDevice(), so they
// all behave the same way:
//
//   * runs in a transaction, so a half-finished move can never be left behind;
//   * a pond holds AT MOST ONE device. If the target pond already has a device
//     it is unassigned (and reported as `displaced_device`) instead of leaving
//     two devices in one pond;
//   * stamps assigned_at, so the API knows which readings belong to the new
//     assignment;
//   * the pond the device LEFT has no device any more, so it is OFFLINE in the
//     very next API answer, and the pond it ENTERED is online straight away
//     (see utils/pondState.js).
const pool = require('../db');
const { pondSnapshot } = require('./pondState');

class AssignmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function tryAssign({ deviceId, farmId, pondId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [devs] = await conn.query(
      'SELECT device_id, device_name, pond_id FROM monitoring_devices WHERE device_id = ? AND farm_id = ? FOR UPDATE',
      [deviceId, farmId]
    );
    if (!devs.length) throw new AssignmentError(404, 'Device not found');
    const device = devs[0];

    let target = null;
    if (pondId !== null) {
      const id = Number(pondId);
      // Scoped to the caller's farm: another farm's pond answers exactly like
      // a pond that does not exist (no id probing).
      const [ponds] = await conn.query(
        'SELECT pond_id, pond_name FROM ponds WHERE pond_id = ? AND farm_id = ? FOR UPDATE',
        [Number.isInteger(id) ? id : 0, farmId]
      );
      if (!ponds.length) throw new AssignmentError(404, 'Pond not found in your farm');
      target = ponds[0];
    }

    let previousPondName = null;
    if (device.pond_id) {
      const [prev] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
      previousPondName = prev[0]?.pond_name ?? null;
    }

    const result = {
      device_id: device.device_id,
      device_name: device.device_name,
      pond_id: target ? target.pond_id : null,
      pond_name: target ? target.pond_name : null,
      previous_pond_id: device.pond_id ?? null,
      previous_pond_name: previousPondName,
      changed: false,
      displaced_device: null,
    };

    const same = (device.pond_id ?? null) === (target ? target.pond_id : null);
    if (same) {
      await conn.commit();
      return result;
    }

    if (target) {
      const [occupants] = await conn.query(
        'SELECT device_id, device_name FROM monitoring_devices WHERE pond_id = ? AND device_id <> ? FOR UPDATE',
        [target.pond_id, device.device_id]
      );
      if (occupants.length) {
        await conn.query(
          'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE pond_id = ? AND device_id <> ?',
          [target.pond_id, device.device_id]
        );
        result.displaced_device = { device_id: occupants[0].device_id, device_name: occupants[0].device_name };
      }
      await conn.query(
        'UPDATE monitoring_devices SET pond_id = ?, assigned_at = NOW() WHERE device_id = ?',
        [target.pond_id, device.device_id]
      );
    } else {
      await conn.query(
        'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE device_id = ?',
        [device.device_id]
      );
    }

    await conn.commit();
    result.changed = true;
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

// pondId: a pond id to move the device into, or null to unassign it.
async function assignDevice({ deviceId, farmId, pondId }) {
  let lastErr;
  // Two people moving devices at the same moment can deadlock each other in
  // the database; one of them is rolled back and simply tries again.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await tryAssign({ deviceId, farmId, pondId });
    } catch (err) {
      lastErr = err;
      if (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw lastErr;
}

// The reply the app gets after a move: what happened, plus the status of the
// pond that was left and of the pond that was entered, so the screen can
// update at once.
async function describeMove(farmId, move) {
  const [pond, previousPond] = await Promise.all([
    pondSnapshot(farmId, move.pond_id),
    move.previous_pond_id && move.previous_pond_id !== move.pond_id ? pondSnapshot(farmId, move.previous_pond_id) : null,
  ]);
  return { ...move, pond, previous_pond: previousPond };
}

module.exports = { assignDevice, describeMove, AssignmentError };

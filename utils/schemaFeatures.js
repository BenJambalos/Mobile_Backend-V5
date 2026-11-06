// Lets the backend run safely BEFORE and AFTER an additive migration is
// applied: code that wants a new optional column asks here first, and falls
// back to the old behaviour when it is not there yet. Positive answers are
// cached for good; negative ones are re-checked every minute so applying a
// migration takes effect without restarting the server.
const pool = require('../db');

const cache = new Map(); // "table.column" -> { present, checkedAt }
const RECHECK_MS = 60 * 1000;

async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  const hit = cache.get(key);
  if (hit && (hit.present || Date.now() - hit.checkedAt < RECHECK_MS)) return hit.present;
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  const present = Number(rows[0].n) > 0;
  cache.set(key, { present, checkedAt: Date.now() });
  return present;
}

function resetSchemaCache() {
  cache.clear();
}

module.exports = { hasColumn, resetSchemaCache };

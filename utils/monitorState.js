// What the background monitors have done lately, so a deployed server can PROVE
// they are running: GET /api/health/monitors shows when each one last ran.
// (In-memory, per process: it says "this instance's timer is alive", which is
// exactly the thing worth checking after a deploy.)
const state = {};

function register(name, intervalSeconds) {
  state[name] = { name, intervalSeconds, startedAt: new Date().toISOString(), lastRunAt: null, lastDurationMs: null, runs: 0, lastError: null, last: null };
}

function recordRun(name, { durationMs, result, error }) {
  const s = state[name] || (state[name] = { name, intervalSeconds: null, startedAt: null, runs: 0 });
  s.lastRunAt = new Date().toISOString();
  s.lastDurationMs = durationMs;
  s.runs = (s.runs || 0) + 1;
  s.lastError = error ? String(error).slice(0, 200) : null;
  if (result !== undefined) s.last = result;
}

function snapshot() {
  const now = Date.now();
  return Object.values(state).map((s) => {
    const ageSeconds = s.lastRunAt ? Math.round((now - Date.parse(s.lastRunAt)) / 1000) : null;
    // "healthy" = it ran within two intervals and the last run did not fail.
    const healthy = s.lastRunAt !== null && s.lastError === null && s.intervalSeconds !== null && ageSeconds <= s.intervalSeconds * 2 + 15;
    return { ...s, secondsSinceLastRun: ageSeconds, healthy };
  });
}

module.exports = { register, recordRun, snapshot };

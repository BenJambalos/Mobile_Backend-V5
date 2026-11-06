// Threshold-based status computation.
//
// This is a starting heuristic, not a certified aquaculture risk model:
// a reading strictly inside [min, max] is "normal"; just outside it
// (within a 15%-of-range buffer) is "warning"; further outside is
// "critical". Swap this out for a real model/rules engine whenever you
// have one — every caller only needs the returned status string.

// 'unavailable' / 'stale' are NOT water-quality results. A missing or outdated
// value is never "normal" (green): it is its own state. They are kept out of
// the worst-of comparison below and rank above 'offline' only so a sort puts
// them last.
const STATUS_RANK = { normal: 0, warning: 1, critical: 2, offline: 3, stale: 4, unavailable: 4 };

function paramStatus(value, min, max) {
  // No measurement is NOT a good measurement. Callers decide how to present it.
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'unavailable';
  const lo = min !== null && min !== undefined ? Number(min) : null;
  const hi = max !== null && max !== undefined ? Number(max) : null;
  const v = Number(value);

  const range = hi !== null && lo !== null ? hi - lo : Math.max(Math.abs(lo ?? hi ?? 1), 1);
  const buffer = Math.max(range * 0.15, 0.01);

  // Outside the safe range: warning if just outside (within the
  // buffer), critical if further out.
  if (lo !== null && v < lo) {
    return lo - v <= buffer ? 'warning' : 'critical';
  }
  if (hi !== null && v > hi) {
    return v - hi <= buffer ? 'warning' : 'critical';
  }
  // Inside the safe range, but hugging a boundary closely enough that
  // it's worth flagging as trending toward risk (this matches the app's
  // design: e.g. DO at 5.1 with a floor of 5.0 is technically compliant
  // but shown as "Warning" because it's right on the edge).
  if (lo !== null && v - lo <= buffer) return 'warning';
  if (hi !== null && hi - v <= buffer) return 'warning';
  return 'normal';
}

/**
 * @param {object} reading {temperature, ph_level, dissolved_oxygen, salinity} or null
 * @param {object} thresholds map: { temperature:{min,max}, ph:{min,max}, dissolved_oxygen:{min,max}, salinity:{min,max} }
 * @param {boolean} deviceOnline
 * @returns {{overall: string, byParameter: object}}
 */
function computePondStatus(reading, thresholds, deviceOnline) {
  if (!deviceOnline || !reading) {
    return { overall: 'offline', byParameter: {} };
  }
  const map = {
    temperature: paramStatus(reading.temperature, thresholds.temperature?.min, thresholds.temperature?.max),
    ph: paramStatus(reading.ph_level, thresholds.ph?.min, thresholds.ph?.max),
    dissolved_oxygen: paramStatus(reading.dissolved_oxygen, thresholds.dissolved_oxygen?.min, thresholds.dissolved_oxygen?.max),
    salinity: paramStatus(reading.salinity, thresholds.salinity?.min, thresholds.salinity?.max),
  };
  // Judge only the parameters that actually have a value. If a sensor sent
  // nothing for a parameter it is 'unavailable', not 'normal'. If NOTHING was
  // measured at all the pond has no usable data: 'stale', never 'normal'.
  const known = Object.values(map).filter((s) => s !== 'unavailable');
  if (!known.length) return { overall: 'stale', byParameter: map };
  let overall = 'normal';
  for (const s of known) {
    if (STATUS_RANK[s] > STATUS_RANK[overall]) overall = s;
  }
  return { overall, byParameter: map };
}

/** 0..1 fill fraction for a progress bar, clamped, for display only. */
function progressFraction(value, min, max) {
  if (value === null || value === undefined || min === null || min === undefined) return 0;
  const lo = Number(min);
  const hi = max !== null && max !== undefined ? Number(max) : lo * 2;
  const frac = (Number(value) - lo) / (hi - lo);
  return Math.max(0, Math.min(1, frac));
}

const PARAM_LABELS = {
  temperature: 'Temperature',
  ph: 'pH Level',
  dissolved_oxygen: 'Dissolved Oxygen',
  salinity: 'Salinity',
};

const PARAM_UNITS = {
  temperature: '°C',
  ph: 'pH',
  dissolved_oxygen: 'mg/L',
  salinity: 'ppt',
};

module.exports = { paramStatus, computePondStatus, progressFraction, PARAM_LABELS, PARAM_UNITS, STATUS_RANK };

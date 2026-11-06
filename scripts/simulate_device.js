// Pretends to be an ESP32 so you can try the whole system without hardware.
// It does what the real firmware does: asks the API which pond it belongs
// to, sends a status heartbeat, and uploads a reading, on a timer.
//
//   node scripts/simulate_device.js <API_BASE> <DEVICE_ID> <DEVICE_KEY> [seconds-between-readings] [critical]
//   node scripts/simulate_device.js https://your-app.up.railway.app/api 1 dk_abc123... 10
//   node scripts/simulate_device.js https://your-app.up.railway.app/api 1 dk_abc123... 10 critical
//
// Things to try while it runs:
//   * move the device to another pond in the app  -> the log shows the new pond, the old
//                                                    pond turns OFFLINE and the new one online at once
//   * press Ctrl+C (the "power cut")              -> after ~3 minutes the app shows OFFLINE
//   * add the word  critical  (last argument)     -> dissolved oxygen is sent far below the safe
//                                                    range, so the app's loud alarm goes off
const [base, deviceId, deviceKey, everyArg, mode] = process.argv.slice(2);
const critical = String(mode || '').toLowerCase() === 'critical';
if (!base || !deviceId || !deviceKey) {
  console.error('Usage: node scripts/simulate_device.js <API_BASE> <DEVICE_ID> <DEVICE_KEY> [seconds] [critical]');
  process.exit(1);
}
const every = Math.max(2, Number(everyArg) || 10) * 1000;
const api = base.replace(/\/+$/, '');

let pondId = null;
let pondName = null;
let temp = 28.4, ph = 7.8, dox = 6.0, sal = 14;
const walk = (v, step, lo, hi) => Math.max(lo, Math.min(hi, v + (Math.random() * 2 - 1) * step));

async function call(method, path, body, headers = {}) {
  const res = await fetch(api + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

function learn(cfg, source) {
  if (!cfg) return;
  const newId = cfg.pond_id ?? null;
  if (newId !== pondId) {
    console.log(`[${source}] pond assignment: ${pondId ?? 'none'} -> ${newId ?? 'none'}${cfg.pond_name ? ` (${cfg.pond_name})` : ''}`);
  }
  pondId = newId;
  pondName = cfg.pond_name ?? null;
}

async function tick(n) {
  try {
    const c = await call('GET', `/devices/${deviceId}/config`, null, { 'x-device-key': deviceKey });
    if (c.status === 200) learn(c.body, 'config');
    else console.log(`config poll failed: HTTP ${c.status} ${JSON.stringify(c.body)}`);

    const s = await call('POST', '/ingest/status', {
      deviceKey, batteryPercentage: 87, isCharging: true, connectivityStatus: 'online',
      signalStrength: 'Stable', activeSensorsCount: 4,
    });
    if (s.status !== 200) console.log(`status failed: HTTP ${s.status} ${JSON.stringify(s.body)}`);

    if (!pondId) { console.log('not assigned to a pond - not recording readings'); return; }
    temp = walk(temp, 0.2, 25, 32); ph = walk(ph, 0.05, 6.8, 8.3); dox = walk(dox, 0.2, 3, 8); sal = walk(sal, 0.2, 10, 20);
    // "critical" mode: dissolved oxygen far below the 5.0 mg/L floor.
    if (critical) dox = walk(2.0, 0.2, 1.5, 2.5);
    const r = await call('POST', '/ingest/readings', {
      // pondIdAtCapture is what the real firmware sends (pondId is the older name)
      deviceKey, pondIdAtCapture: pondId, temperature: +temp.toFixed(2), phLevel: +ph.toFixed(2),
      dissolvedOxygen: +dox.toFixed(2), salinity: +sal.toFixed(2),
    });
    if (r.status === 201 || r.status === 200) {
      learn(r.body.config, 'upload');
      console.log(`#${n} sent to ${pondName ?? pondId}: T=${temp.toFixed(1)} pH=${ph.toFixed(2)} DO=${dox.toFixed(1)} Sal=${sal.toFixed(1)}`);
    } else {
      console.log(`reading rejected: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (err) {
    console.log(`network problem (${err.cause?.code || err.message}) - a real device would queue this on its SD card`);
  }
}

console.log(`Simulating device ${deviceId} against ${api} every ${every / 1000}s${critical ? ' in CRITICAL mode (low dissolved oxygen)' : ''}. Ctrl+C = power cut.`);
let n = 0;
tick(++n);
setInterval(() => tick(++n), every);

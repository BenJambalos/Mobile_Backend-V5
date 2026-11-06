# HyQual Backend

A real REST API for the HyQual app: Node.js + Express + MySQL, JWT auth,
bcrypt password hashing, and SQL-driven reports (real AVG/MIN/MAX
aggregation over `water_quality_readings`, not fake numbers).

Tested end-to-end against a live MySQL instance before delivery — every
endpoint below was hit with real HTTP requests and verified to return
correct data (see the "What was actually tested" section).

## 1. Set up the database

You need MySQL or MariaDB running. Then:

```bash
mysql -u root -p -e "CREATE DATABASE hyquai_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p hyquai_db < database1/schema.sql
mysql -u root -p hyquai_db < database1/seed_data.sql
```

`database1/schema.sql` is **your** ERD schema (from `ERD2.mwb`) with
corrections — each one is marked with a `-- CORRECTION` comment in the
file explaining exactly what changed and why (short version: forecasts
and notifications needed a `pond_id` since your farms have multiple
ponds; notifications needed `is_read` separate from `is_resolved`;
devices needed a `device_key` for IoT auth; added a `password_resets`
table for the Forgot Password flow; accounts got `pending`/`rejected`
and `super_admin`; **`device_status` is one row per device** and
**`water_quality_readings` carries the `pond_id` it was taken in**).
Everything else is untouched.

No `mysql` command line? Every `mysql ... < file.sql` above works as
`node scripts/run_sql.js file.sql` with the target set in `DB_URL` (or in
`.env`) — see the Railway section.

**Already have a database with data?** Do NOT re-run `schema.sql`. Run the
migrations in order instead: `001_account_approval.sql`, then
`002_device_status_and_reading_pond.sql`, then
`003_one_device_per_pond.sql` (see the notes at the top of each; each is safe
to repeat). 003 is the one that makes moving a device between ponds instant
and correct.

`database1/seed_data.sql` populates it with the same demo data the app
already shows: farm owner Juan Dela Cruz, 4 ponds (Normal/Warning/
Critical/Offline), 5 devices, ~7 days of realistic readings, and 5
notifications. Login with `farmer@hyquai.demo` / `HyQuai123!`.

Then create a database user for the app (or reuse root for local dev):

```sql
CREATE USER 'hyquai_app'@'localhost' IDENTIFIED BY 'choose_a_real_password';
GRANT ALL PRIVILEGES ON hyquai_db.* TO 'hyquai_app'@'localhost';
FLUSH PRIVILEGES;
```

## 2. Configure and run the server

```bash
cp .env.example .env
# edit .env: set DB_USER/DB_PASSWORD to what you created above,
# and set JWT_SECRET to a real random string:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm install
node server.js
```

You should see `HyQual API listening on port 4000`. Check it's alive:

```bash
curl http://localhost:4000/api/health
```

## 3. Point the Flutter app at it

Open `lib/data/api_client.dart` in the Flutter project and set `baseUrl`
to wherever this server is reachable from your phone/emulator — see the
comment block right above it for the Android-emulator-vs-physical-phone
gotchas (this is the #1 thing that trips people up: `localhost` from a
phone means the phone itself, not your computer).

## Regenerating demo data

`seed_generator.js` (in this folder) is the script that built
`seed_data.sql` — it writes realistic random-walk readings directly into
a running MySQL instance, then you'd `mysqldump` the result. Useful if
you want a fresh batch with today's timestamps:

```bash
node seed_generator.js
```

## API overview

- `POST /api/auth/login`, `/signup`, `/forgot-password`, `/reset-password`
  - `signup` now creates the account as **PENDING** and returns no token.
  - `login` answers 403 (`code: ACCOUNT_PENDING` / `ACCOUNT_REJECTED`) until a Super Admin approves; on success it also returns `role`, `accountStatus` and `setup` (`hasFarm`, `pondCount`, `deviceCount`).
- `GET /api/auth/me` — same account/setup state, for resuming setup
- `PUT /api/auth/change-password` (requires current password)
- `GET/PUT /api/profile`, `GET/PUT /api/farm`, `POST /api/farm` (create the farm during setup, once approved)
- **Super Admin only** — `GET /api/admin/accounts/pending`, `PUT /api/admin/accounts/:accountId/approve`, `PUT /api/admin/accounts/:accountId/reject`
- `GET/POST /api/ponds`, `PUT/DELETE /api/ponds/:id`, `GET /api/ponds/:id` (detail), `GET /api/ponds/:id/forecast`
- `GET/POST /api/devices`, `PUT/DELETE /api/devices/:id`, `GET /api/devices/:id`, `POST /api/devices/:id/assign`
- `PUT /api/devices/:id/pond` `{ "pond_id": 2 }` — remote reassignment from the app (pond must belong to the caller's farm). It takes effect at once and the reply says what happened: `{ changed, device_id, pond_id, pond_name, previous_pond_id, previous_pond_name, displaced_device, pond: {status, awaitingReading…}, previous_pond: {status…}, message }`. The pond the device left is `offline` and the pond it entered is online ("waiting for first reading") in that same reply and in the very next `GET /ponds`. A pond holds ONE device: moving a device into an occupied pond unassigns the other one (`displaced_device`). `POST /devices/:id/assign`, `PUT /devices/:id {pondId}` and `POST /devices {pondId}` use the same logic (`utils/deviceAssignment.js`).
- `GET /api/alarms` — every parameter that is CRITICAL right now in a pond whose device is online and has sent a fresh reading since it was assigned: `{ count, alarms: [{ key, pondId, pondName, parameter, label, value, unit, min, max, direction, message }] }`. The app polls it every 10 s and sounds its loud alarm while the list is not empty. Warnings, offline ponds, ponds still waiting for their first reading, and readings older than `ALARM_MAX_READING_AGE_SECONDS` (20 min) never ring.
- `GET /api/devices/:deviceId/config` — polled by the ESP32; authenticates with header `x-device-key` (not a user JWT) and returns `{ device_id, farm_id, pond_id, pond_name }`
- `POST /api/ingest/readings`, `POST /api/ingest/status` — called by the physical device (authenticated via `device_key`, not a user JWT). Posting a reading automatically creates or resolves alerts by comparing against `parameter_thresholds` — see `routes/ingest.js`.
  - **Readings** `{ deviceKey, temperature, phLevel, dissolvedOxygen, salinity, pondId?, recordedAt? }` (the firmware sends the capture time as `createdAt`; it is accepted as a lenient fallback for `recordedAt` and never causes a rejection). The stored row carries the pond it was taken in (`water_quality_readings.pond_id`). A device that queued a reading on its SD card sends the `pondId` it had and the `recordedAt` time (epoch seconds or ISO) of the moment it was taken, so a later pond change can't re-label it. Without `pondId` the device's current pond is used; without `recordedAt` the server time is used. Re-sending the same `recordedAt` is answered `200 {duplicate:true}` (no second row). `422` means "will never be accepted" (unknown/deleted pond, impossible timestamp, no usable value) — the device should drop it; `409` = device has no pond and none was given. Values outside a physical range (pH 99…) are stored as NULL and listed in `ignored`. Readings older than 10 minutes, and readings that belong to a pond the device has since been moved out of, are stored but raise no new alerts.
  - **Status** `{ deviceKey, batteryPercentage, isCharging, connectivityStatus, signalStrength, activeSensorsCount }` updates the device's ONE `device_status` row in place (never inserts a second). Both replies include `config: { pond_id, pond_name }` = the device's current pond.
  - **Online/offline** is never reported by the device. Every contact (heartbeat, reading, config poll) stamps `device_status.last_seen_at`; a device silent for `DEVICE_OFFLINE_AFTER_SECONDS` (default 180) is OFFLINE in every API response, even if the server was restarted, and a once-a-minute job raises one "Device Offline" notification per outage and resolves it when the device returns (`utils/deviceHealth.js`).
- `GET /api/notifications` (+ `PUT .../read`, `PUT .../mark-all-read`)
- `GET /api/reports/trend`, `/reading-logs`, `/alert-logs`, `/summary`, `/list` — the real SQL aggregation endpoints

Every mutating/list endpoint except `/auth/*`, `/ingest/*` and
`GET /devices/:deviceId/config` requires `Authorization: Bearer <token>`
from login. Farm-scoped endpoints (ponds, devices, notifications, reports)
answer `409 { code: "FARM_REQUIRED" }` until the account has created its farm.

## Device moves and history

`monitoring_devices.pond_id` is where a device is assigned NOW. Everything
historical uses `water_quality_readings.pond_id` instead: ponds, reports,
trend charts and forecasts read "the readings taken in this pond", so
moving a device never moves old data with it. Deleting a pond deletes its
readings (the schema's `ON DELETE CASCADE`).

## Account approval (Super Admin)

New registrations are `accounts.status = 'pending'`. A Super Admin
(`accounts.role = 'super_admin'`, `status = 'active'`) approves or rejects
them. Mapping used by the API: `pending` = PENDING, `active` = APPROVED
(the status that already existed), `rejected` = REJECTED.

**Existing database (local or Railway):** run
`database1/migrations/001_account_approval.sql` once. It only ALTERs two
columns on `accounts`; existing accounts stay `active`. Check your live
column values first (the file explains how). Fresh installs get the same
change from `database1/schema.sql`.

**Create the Super Admin yourself** (SQL example at the bottom of the
migration file). It needs a bcrypt hash:
`node -e "console.log(require('bcryptjs').hashSync('YourPassword',10))"`.

## Deploying on Railway

1. Railway project with a **MySQL** service and a service from this repo
   (set the service's *Root Directory* to `hyqual_backend`; start command
   is `npm start`).
2. On the Node service add variables: `JWT_SECRET` (long random string),
   `NODE_ENV=production`, and reference the MySQL service's `MYSQLHOST`,
   `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`
   (`${{MySQL.MYSQLHOST}}` etc. — use your MySQL service's actual name).
   `db.js` reads these automatically; `DB_*` is only for local `.env`.
3. Settings > Networking > **Generate Domain** on the Node service. That
   HTTPS URL is what the Flutter app and the ESP32 use (never localhost).
4. Load the database from your own computer with the public connection
   string (MySQL service > Variables > `MYSQL_PUBLIC_URL`). No `mysql`
   client needed:

   ```bash
   # macOS / Linux
   export DB_URL='mysql://root:PASSWORD@HOST:PORT/railway'
   # Windows PowerShell:   $env:DB_URL='mysql://root:PASSWORD@HOST:PORT/railway'
   # Windows CMD:          set DB_URL=mysql://root:PASSWORD@HOST:PORT/railway

   node scripts/run_sql.js database1/schema.sql          # NEW database
   node scripts/run_sql.js database1/seed_data.sql       # optional demo data
   node scripts/create_super_admin.js you@example.com 'a-strong-password' First Last
   ```

   Existing Railway database with data? Take a backup, then instead of
   `schema.sql` run `database1/migrations/001_...sql`, `002_...sql` and
   `003_...sql` the same way (each is safe to repeat; skip the ones you
   already ran).
5. Check it: open `https://<domain>/api/health/db` — it must say
   `{"status":"ok","db":"ok"}`. The deploy log shows `Database connection OK`.
6. Flutter: `flutter run --dart-define=API_BASE_URL=https://<domain>/api`
   (or `flutter build apk --dart-define=API_BASE_URL=...`).
7. Try it without hardware: `node scripts/simulate_device.js https://<domain>/api <DEVICE_ID> <DEVICE_KEY> 10`
   behaves like the ESP32 (config poll, heartbeat, readings). Ctrl+C is the
   "power cut": the app shows the device OFFLINE after about 3 minutes.

## Scripts

| Script | What it does |
|---|---|
| `scripts/run_sql.js <file.sql>` / `-e "SQL"` | Runs SQL against `DB_URL` (or `.env`); no mysql client needed |
| `scripts/create_super_admin.js <email> <password> [First] [Last]` | Creates / resets the Super Admin login |
| `scripts/simulate_device.js <apiBase> <id> <key> [secs] [critical]` | Pretends to be an ESP32. Add `critical` to send dangerously low dissolved oxygen and trigger the app's alarm |

## Tests

Run against a LOCAL server + database (they create accounts and readings):

```bash
export SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=...
node tests/approval_flow.js    # register, pending, reject, approve, farm/pond/device setup, cross-farm protections
node tests/device_flow.js      # one status row per device, OFFLINE detection, readings keep their pond,
                               # queued (SD-card) readings, duplicates, bad input, history after a device moves
node tests/reassign_flow.js    # moving a device: old pond offline / new pond online at once, one device per pond,
                               # no stale data after moving back, the critical-level alarm endpoint
node ../esp32/host_test/firmware_e2e.js   # the real firmware logic against this API (see esp32/README.md)
```

Both need the demo seed loaded (they use the demo farm's pond as "someone
else's pond") and a Super Admin.

## What was actually tested

Every endpoint above was exercised with real HTTP requests against a
live MySQL database during development, including: signup, duplicate-
signup rejection, login, change password + re-login, forgot password,
full pond/device CRUD, device assignment, a simulated device posting a
threshold-breaching reading (confirmed it auto-created a CRITICAL
notification with the right message) followed by a normal reading
(confirmed the notification auto-resolved), and the reports summary
endpoint's AVG/MIN/MAX numbers were spot-checked against a manual SQL
query. A fresh database loaded from *only* `schema.sql` + `seed_data.sql`
was used for the final pass, so what you're getting is exactly what was
tested.

**Not tested:** the Flutter side calling this API. There's no Flutter
SDK in the environment this was built in, so the Dart code was written
carefully and cross-checked field-by-field against these exact API
response shapes, but not run. If something doesn't line up, it's most
likely a small field-name mismatch — paste the error back and it's a
quick fix.

## Known gaps (clearly marked with `TODO(db)` / `TODO(email)` in the code)

- CSV/XLSX report export and real PDF generation are stubbed (show a
  confirmation message but don't produce a real file yet)
- Forgot-password generates a real token but doesn't email it (needs a
  mail provider — logs the token to the server console for now)
- Forecast values are a simple heuristic based on the current reading,
  not a real prediction model


## Device pond history and online/offline fix

This version implements the following behavior:

- `water_quality_readings.pond_id` is the pond where a reading was taken.
- The ESP32 sends `pondIdAtCapture` with each reading. The API accepts this field and keeps `pondId` as a backward-compatible alias. If an SD-card reading uploads after reassignment, the captured pond ID is used rather than the device's current pond.
- The captured pond must exist in the same farm as the registered device. If no pond ID is sent (older firmware), the API falls back to the current assignment.
- `device_status` is a current-state snapshot: one row per device, updated using an upsert. Registration creates an initial OFFLINE row; first successful device contact changes it to ONLINE.
- The backend marks devices OFFLINE after `DEVICE_OFFLINE_AFTER_SECONDS` without contact (default 180 seconds; minimum 30 seconds). The offline monitor runs once per minute. Configure `DEVICE_OFFLINE_AFTER_SECONDS` in Railway if your ESP32 reports less often.
- `last_seen_at` is the actual last contact. A newly created device has `last_seen_at = NULL`, so the app can show `never` rather than a fake recent sync.
- Historical readings are retained for machine learning. Do not run `database1/reset_all_tables.sql` on a database containing real data.

### Railway deployment steps

1. Back up the Railway MySQL database before changing its schema.
2. If Railway already has the old schema, run `database1/migrations/002_device_status_and_reading_pond.sql` against that database. If the database is brand new, use `database1/schema.sql` instead. Do not import a full seed file into a populated production database.
3. Deploy this backend folder to Railway and ensure its start command runs `node server.js` (or `npm start`).
4. Set `DEVICE_OFFLINE_AFTER_SECONDS=180` if you want the default three-minute timeout.
5. Upload the matching updated ESP32 `.ino` firmware that sends `pondIdAtCapture` and stores that field in each SD-card queued reading.
6. Verify `GET /api/health/db`, then test: assign to Pond A, send a reading, reassign to Pond B, send another reading, and confirm the two rows have different `pond_id` values. Also confirm repeated status heartbeats still leave one row in `device_status`.

Important limitation: historical readings created before `pond_id` existed cannot be perfectly attributed after a device has moved. The migration backfills them from the device's current pond because older assignment history was not stored. New readings will preserve their pond association.

## Moving a device between ponds (instant) and the critical alarm

**What the API now does when a device is moved from Pond A to Pond B**

- Pond A has no device any more, so it is `offline` in the same reply and in the next `GET /ponds`.
- Pond B is online straight away. Until the device has sent a reading taken after the move it shows `status: "normal"`, `updatedAgo: "waiting for first reading"`, `awaitingReading: true`. The updated ESP32 firmware sends that reading within seconds of learning about the move (config is polled every 10 s). If none arrives within `POND_FIRST_READING_GRACE_SECONDS` (default 600) the pond goes `offline` (device alive but delivering no data).
- Only readings taken since the device entered the pond (`monitoring_devices.assigned_at`) count as the pond's current reading. Moving a device back into a pond it was in earlier does not revive that pond's old readings.
- A pond holds at most one device (`UNIQUE(monitoring_devices.pond_id)`). Before, two devices in one pond made that pond appear twice in the list.

**Where this lives:** `utils/pondState.js` (what a pond looks like, shared by `/ponds`, `/ponds/:id`, the move reply and `/alarms`), `utils/deviceAssignment.js` (the only code that changes a device's pond), `routes/alarms.js`, migration `003_one_device_per_pond.sql`.

**Optional settings** (Railway Variables or `.env`): `POND_FIRST_READING_GRACE_SECONDS` (600), `ALARM_MAX_READING_AGE_SECONDS` (1200).

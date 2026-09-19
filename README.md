# Stone

Telemetry dashboard and procedural 3D stone studio for Raspberry Pi Pico field
devices.

Two deployables:

| Part | Stack | Host |
|---|---|---|
| `frontend/` | React 18 · TypeScript · Vite · three.js · MapLibre | GitHub Pages (static) |
| `backend/` | Fastify · TypeScript · SQLite (WAL) | Fly.io (Docker + volume) |

The device posts readings to the backend over HTTPS with a device key. The
frontend never talks to the device, and never to any third party directly.

---

## The one rule

**Nothing in `frontend/` may contain a credential.** Everything the build emits
is served publicly from GitHub Pages — treat the bundle as a published
document. No API keys, tokens, connection strings, service-account files, or
signing secrets in source, in build-time environment variables, in committed
config, or in comments.

The only runtime configuration the bundle carries is the public API base URL
and non-sensitive feature flags.

Every credentialed call is proxied. The backend holds the secret, authenticates
the user, and makes the outbound request on their behalf. `npm run build` runs
a bundle scanner that fails the build if a likely secret appears in the output,
and the deploy workflow runs the same check.

See [SECURITY.md](./SECURITY.md) for where secrets live and what to rotate.

---

## Quick start

Requires Node 22+.

```bash
# --- backend -------------------------------------------------------------
cd backend
npm install
cp .env.example .env          # defaults work for local development
npm run seed -- --email you@example.com --password 'a-long-enough-password'
npm run dev                   # http://localhost:8080

# --- frontend (second terminal) -----------------------------------------
cd frontend
npm install
cp .env.example .env          # points at http://localhost:8080
npm run dev                   # http://localhost:5173
```

Sign in with the credentials you passed to the seed. It generates three weeks
of simulated telemetry across two devices, so the dashboard has something real
to render before hardware exists.

### A note on cookies in development

Session cookies are `SameSite=None; Secure` because the SPA and the API are on
different origins in production. Browsers treat `localhost` as a trustworthy
origin, so `Secure` cookies are accepted over plain HTTP there and local
development needs no override.

---

## Commands

### Backend

| Command | Does |
|---|---|
| `npm run dev` | Watch-mode server on `:8080` |
| `npm test` | Typecheck plus 62 tests (auth, ownership, ingest) |
| `npm run typecheck` | Types only, including the test files |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run seed` | Generate a demo account and simulated telemetry |

Seed options: `--email`, `--password`, `--days` (default 21), `--reset`.

### Frontend

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server on `:5173` |
| `npm test` | 13 generator tests (determinism, dimensions, untrusted input) |
| `npm run typecheck` | All three TS projects |
| `npm run build` | Typecheck, build, then **scan the bundle for secrets** |
| `npm run scan` | Run the secret scan against an existing `dist/` |
| `npm run preview` | Serve the built bundle locally |

---

## Data model

```
users ──┬── sessions
        ├── devices ─── readings        (append-only)
        └── designs ─── design_shares
```

A **device** belongs to exactly one user: id, display name, SHA-256 of its key,
a non-secret key prefix for identification, and timestamps.

A **reading** belongs to exactly one device and records:

- `recorded_at` (device clock) and `received_at` (server clock), both UTC, plus
  the computed `clock_skew_ms` between them
- `latitude`, `longitude`, optional `altitude_m` and `gps_accuracy_m`
- per-wheel pressure and temperature for four positions
- ambient temperature, humidity, barometric pressure, three-axis acceleration,
  battery voltage
- `extra` — a JSON column holding every field the device sent that the schema
  does not name, so unknown keys are preserved rather than dropped

`user_id` is denormalised onto `readings` so every read path scopes by owner in
the `WHERE` clause without a join.

**Readings are immutable.** A SQLite `BEFORE UPDATE` trigger raises on any
attempt to modify one, and no endpoint exposes a mutation. Deleting a device
cascades to its readings — immutable is not the same as undeletable, and a user
must be able to remove their own data.

---

## Posting readings from a device

```http
POST https://your-api.fly.dev/api/ingest
Authorization: Bearer stk_<device-key>
Content-Type: application/json
```

```json
{
  "recorded_at": "2026-09-19T10:04:00Z",
  "latitude": 42.3398,
  "longitude": -71.0892,
  "altitude_m": 14.2,
  "gps_accuracy_m": 4.5,
  "tires": {
    "front_left":  { "pressure_kpa": 228.4, "temp_c": 31.2 },
    "front_right": { "pressure_kpa": 229.1, "temp_c": 30.8 },
    "rear_left":   { "pressure_kpa": 235.0, "temp_c": 33.4 },
    "rear_right":  { "pressure_kpa": 234.2, "temp_c": 33.1 }
  },
  "sensors": {
    "ambient_temp_c": 18.4,
    "humidity_pct": 61.2,
    "barometric_pressure_hpa": 1014.2,
    "accel_x_g": 0.02,
    "accel_y_g": -0.01,
    "accel_z_g": 1.00,
    "battery_voltage_v": 12.4
  },
  "firmware": "1.4.2",
  "rssi_dbm": -58
}
```

- Send one reading, or a batch as `{"readings": [...]}` (default max 200).
- A batch is all-or-nothing: one invalid reading rejects the whole request.
- Unrecognised top-level keys (`firmware`, `rssi_dbm` above) land in `extra` and
  appear on the reading detail page.
- Validation failures return `422` with a per-field `issues` array naming the
  offending key.
- Rate-limited per device (default 120/min). A throttled device gets `429` with
  a `Retry-After` header.

---

## API

```
POST   /api/auth/register        POST   /api/auth/login       POST /api/auth/logout
POST   /api/auth/logout-all      POST   /api/auth/refresh
GET    /api/auth/me              GET    /api/auth/csrf

GET    /api/devices              POST   /api/devices          GET    /api/devices/:id
PATCH  /api/devices/:id          DELETE /api/devices/:id      POST   /api/devices/:id/rotate-key

GET    /api/readings             GET    /api/readings/:id
GET    /api/readings/stats       GET    /api/readings/series  GET    /api/readings/export

POST   /api/ingest               (device key, not a session)

GET    /api/designs              POST   /api/designs          GET    /api/designs/:id
PUT    /api/designs/:id          DELETE /api/designs/:id
POST   /api/designs/:id/share    DELETE /api/designs/:id/share
GET    /api/share/:token         (unauthenticated; one design, no owner data)

GET    /api/geo/style.json       GET    /api/geo/tiles/:z/:x/:y   GET /api/geo/search

GET    /health
```

Every endpoint except `/health`, `/api/ingest`, `/api/share/:token`, and the
auth entry points requires a session, re-derives the caller from the cookie,
and scopes its queries by `user_id`.

---

## The studio

A stone is **parameters, not geometry**. The mesh is regenerated
deterministically in the browser from a seed, so a saved design is a few
hundred bytes and a share link reproduces exactly what its author saw.

- The seed comes from the chosen coordinates, rounded to five decimal places
  (about a metre). The same place always yields the same stone.
- Generation runs in a web worker and is debounced, so dragging a slider does
  not stall the UI. Level 6 (~82,000 triangles) generates in roughly 150 ms.
- The mesh is scaled so its bounding box **exactly** matches the requested
  length, width, and height — the dimension fields are not decorative.
- Pipeline: subdivided icosahedron → layered gradient-noise displacement →
  optional convex-polytope intersection for fracture faces → taper and flatten
  → exact rescale → normals blended smooth-to-flat, plus vertex colours for
  mineral veining and crevice shading.

Export is glTF (`.glb`) or OBJ, in millimetres at the origin with the viewer's
presentation transform removed. Sharing is either an encoded parameter URL
(no server involved) or a revocable backend share token.

---

## Deploying

### Backend → Fly.io

```bash
cd backend
fly launch --no-deploy            # or `fly apps create stone-api`
fly volumes create stone_data --size 1 --region bos

# Secrets are set once and live only in Fly's secret store.
fly secrets set MAP_TILES_URL='https://api.maptiler.com/maps/dataviz-dark/{z}/{x}/{y}.png?key={key}'
fly secrets set MAP_TILES_KEY='your-maptiler-key'
fly secrets set GEOCODE_URL='https://api.maptiler.com/geocoding/{q}.json?key={key}'
fly secrets set GEOCODE_KEY='your-maptiler-key'

# Point CORS at your Pages origin before the first deploy.
fly secrets set ALLOWED_ORIGINS='https://tykephoon.github.io'

fly deploy
```

`fly.toml` pins `min_machines_running = 1`: SQLite lives on one volume, and
exactly one machine may hold the write lock.

Map credentials are optional. With none configured the proxy falls back to
keyless OpenStreetMap tiles and Nominatim, which is fine for development but is
not an appropriate production tile source under OSM's usage policy.

### Frontend → GitHub Pages

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables** — add
   `VITE_API_BASE_URL` = your API origin, e.g. `https://stone-api.fly.dev`.
   A **variable**, not a secret: it is a public URL, and the build refuses to
   consume secrets.
3. Push to `main`. The workflow typechecks, tests, builds, scans the bundle for
   secrets, copies `index.html` to `404.html`, and publishes.

The app uses a hash router, so deep links survive a refresh with no server
rewrite; the `404.html` copy covers anyone arriving on a path-style URL. Asset
paths are relative (`base: './'`), so the same bundle works at
`https://tykephoon.github.io/STONE_UI/` and at a domain root without a rebuild.

Finally, set the backend's `ALLOWED_ORIGINS` to exactly the Pages origin — it
must match scheme, host, and port, and the API's Content-Security-Policy is
derived from the same value at build time.

---

## Branding

Drop replacements into `frontend/public/` using these exact filenames; no code
changes needed.

| File | Used for |
|---|---|
| `favicon.svg` | Browser tab icon |
| `apple-touch-icon.png` | 180×180, iOS home screen |
| `logo.svg` | In-app mark, roughly 132×32 |

The placeholders currently in place are clearly marked as such.

---

## Project layout

```
backend/
  src/
    config.ts            Environment parsing — every secret enters here
    app.ts               Fastify factory: CORS, cookies, rate limits, error handler
    db/                  Connection and forward-only migrations
    domain/              Zod schemas — the authoritative validators
    lib/                 Crypto, sessions, errors, rate limiting, ids
    plugins/auth.ts      Session resolution, CSRF, requireUser
    routes/              One module per resource
    scripts/seed.ts      Simulated telemetry generator
  test/                  auth · ownership · ingest

frontend/
  scripts/check-bundle-secrets.mjs   Pre-publish bundle audit
  src/
    api/                 The only place that performs network calls
    auth/                Session context and route guards
    components/          ui · charts · layout · map · filters
    features/            auth · dashboard · readings · devices · studio
    hooks/  lib/  styles/
  test/                  Generator determinism and untrusted input
```

`src/api/` is the single home for endpoints and request logic — no UI component
calls `fetch` directly.

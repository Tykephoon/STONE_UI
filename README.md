# Stone

Telemetry dashboard and procedural 3D stone studio. Runs entirely in the
browser, hosted free on GitHub Pages.

**No server. No accounts. No hosting bill.** Data lives in your browser, arrives
by file import or manual entry, and leaves by export.

- **Live site:** https://tykephoon.github.io/STONE_UI/
- Stack: React 18 · TypeScript · Vite · three.js · MapLibre

---

## How it works

```
GitHub Pages ──► static bundle ──► IndexedDB in your browser
                                    ▲
                                    └── CSV / JSON import, or typed by hand
```

There is nothing to deploy beyond the static site, and nothing to pay for. Maps
come from OpenStreetMap, which needs no key.

### What that costs you

- **Data is per-browser.** It does not follow you to another machine or another
  browser unless you export a backup and import it there.
- **Clearing site data deletes it.** The export file is the only copy.
- **No live device ingest.** A Pico cannot POST to this; see
  [Live ingest](#live-ingest-optional) if that changes.

---

## Quick start

Requires Node 22+.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

That is the whole setup. On first run the app loads a bundled sample dataset —
three weeks of simulated telemetry across two devices, including a slow leak on
one rear-left tyre — so the dashboard has something real to render immediately.

Delete it any time from **Import → Delete everything**.

---

## Getting your own data in

Three ways, all on the **Import** page.

**1. Upload a file.** Drop a CSV, or click to choose one.

**2. Paste rows.** Copy straight out of a spreadsheet into the paste box.

**3. Type a reading.** A form for a single value read off a gauge.

Nothing is saved until you have seen the preview: how many rows parsed, which
columns were recognised, and exactly which rows had problems and why.

### CSV format

Only three columns are required:

| Column | Notes |
|---|---|
| `recorded_at` | ISO-8601 (`2026-09-19T10:04:00Z`) or `YYYY-MM-DD HH:MM:SS`, read as UTC |
| `latitude` | −90 to 90 |
| `longitude` | −180 to 180 |

Everything else is optional: `altitude_m`, `gps_accuracy_m`, `ambient_temp_c`,
`humidity_pct`, `barometric_pressure_hpa`, `battery_voltage_v`, `accel_x_g`
(and `_y_`, `_z_`), plus `tire_fl_pressure_kpa` / `tire_fl_temp_c` style names
for all four wheels (`fl`, `fr`, `rl`, `rr`).

Common aliases are recognised automatically — `lat`, `lon`, `timestamp`,
`temperature`, `battery`, `front_left_pressure`, and others. Case and spacing do
not matter.

**Unrecognised columns are kept**, not dropped. They appear on each reading's
detail page alongside the raw record.

```csv
recorded_at,latitude,longitude,ambient_temp_c,tire_fl_pressure_kpa,rssi_dbm
2026-09-19T10:04:00Z,42.3398,-71.0892,18.4,228.4,-58
2026-09-19T10:09:00Z,42.3401,-71.0885,18.5,228.1,-61
```

There is a **Download a template** button on the Import page.

### Validation

Values are range-checked on the way in, so a unit mix-up is caught rather than
charted. A tyre pressure of 2200 is rejected as a psi/kPa confusion; a latitude
of 999 is rejected outright. A bad row is skipped and reported with its line
number — the rest of the file still imports.

An empty cell becomes "no reading", never zero. A missing sensor leaves a gap in
the chart rather than a line dropping to the axis.

### Backups

**Import → Export backup** writes a single JSON file containing every reading,
device, and saved design. Restoring it on another machine is how data moves.
Re-importing the same file is safe: records merge by id rather than duplicating.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Dev server on `:5173` |
| `npm test` | 54 tests — CSV import, generator determinism, sample data |
| `npm run typecheck` | All four TypeScript projects |
| `npm run build` | Typecheck, build, then **scan the bundle for secrets** |
| `npm run scan` | Run the secret scan against an existing `dist/` |
| `npm run preview` | Serve the built bundle locally |

---

## Deploying

Already configured. Push to `main` and the workflow builds, tests, scans, and
publishes.

One-time setup:

1. **Settings → Pages → Source: GitHub Actions**

That is the entire list. The build takes no configuration and no secrets.

Deep links work: the app uses a hash router, and the build also writes a
`404.html` copy of `index.html`. Asset paths are relative, so the same bundle
runs at `https://tykephoon.github.io/STONE_UI/` or at a domain root unchanged.

---

## The studio

A stone is **parameters, not geometry**. The mesh is regenerated
deterministically in the browser from a seed, so a saved design is a few hundred
bytes and a shared link reproduces exactly what its author saw.

- The seed comes from coordinates you pick on a map, rounded to five decimal
  places. The same place always yields the same stone.
- Generation runs in a web worker and is debounced, so dragging a slider does
  not stall the interface. Level 6 (~82,000 triangles) takes about 150 ms.
- The mesh is scaled so its bounding box **exactly** matches the length, width,
  and height you ask for — the dimension fields are not decorative.
- Pipeline: subdivided icosahedron → layered gradient-noise displacement →
  optional convex-polytope intersection for fracture faces → taper and flatten →
  exact rescale → normals blended smooth-to-flat, plus vertex colours for
  mineral veining and crevice shading.

Export is glTF (`.glb`) or OBJ, in millimetres at the origin.

**Sharing** encodes the whole design into the URL — an editable link that opens
in the studio, or a read-only viewer link. Both work with no server, which also
means they cannot be revoked. Treat a link as public.

---

## Live ingest (optional)

If a real Pico ever needs to POST readings, `backend/` holds a complete Fastify
+ SQLite API that does exactly that: device-key authentication, range
validation, batching, rate limiting, and immutable rows.

It is **not used by the frontend** and needs a host that costs money. It is kept
because the ingest endpoint is the one thing a browser cannot do, and rebuilding
it later would be wasted work.

```bash
cd backend
npm install && npm test     # 48 tests
npm run seed                # simulated telemetry
npm run dev                 # http://localhost:8080
npm run device -- add "Pico-01"
```

Readings collected by it can be exported to CSV and imported here, so the two
halves interoperate without the frontend depending on the backend.

---

## Branding

Drop replacements into `frontend/public/`; no code changes needed.

| File | Used for |
|---|---|
| `favicon.svg` | Browser tab icon |
| `apple-touch-icon.png` | 180×180, iOS home screen |
| `logo.svg` | In-app mark, roughly 132×32 |

The placeholders currently in place are clearly marked as such.

---

## Project layout

```
frontend/
  scripts/check-bundle-secrets.mjs   Pre-publish bundle audit
  public/data/sample-telemetry.json  First-run dataset
  src/
    data/              Everything that touches storage lives here
      db.ts              IndexedDB wrapper
      store.ts           Queries, mutations, in-memory cache
      csv.ts             Parsing, column mapping, validation, export
      sample.ts          First-run dataset loader
      geo.ts             OpenStreetMap tiles and geocoding
      export.ts          File downloads and backups
    components/        ui · charts · layout · map · filters
    features/          dashboard · readings · devices · import · studio
    hooks/  lib/  styles/
  test/                CSV import · generator · sample data

backend/               Optional. Unused by the frontend — see Live ingest.
```

`src/data/` is the single home for storage and network access; no UI component
reads or writes directly.

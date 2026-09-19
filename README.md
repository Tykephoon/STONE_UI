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
- **No sample data.** The dashboard is empty until you import something.

---

## Quick start

Requires Node 22+.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

That is the whole setup. The app starts empty — there is no demo or sample data
anywhere in it. Import a CSV, or open the Studio, which needs no data at all.

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
| `npm test` | 60 tests — CSV import, generator, STL export and print stats |
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

### Sculpting it

Fourteen control points sit on the stone's surface as small dots, evenly spread
via a Fibonacci sphere so the top is not over-controlled and the waist
under-controlled. Hover one and a ring shows the area it affects; drag it
outward to raise a bump, inward to press a dent.

Pulls are **local, not uniform**. Influence falls off smoothly with angular
distance, so a pull shapes a region rather than scaling the whole stone.
Overlapping pulls reinforce each other. The **Pull reach** slider sets how far
each one spreads, and dots tint green outward or red inward so the sculpt reads
at a glance.

While you drag, the mesh rebuilds at level 4 — about 10 ms, against 150 ms at
level 6 — so the surface follows the pointer. Full detail returns the moment you
let go.

Overall size stays with the three dimension fields, and the mesh is rescaled
after sculpting, so those figures remain exact however much you carve.

### Size reference

The **Scale** tab holds real objects — coins, a bank card, a drinks can, a
brick, a tennis ball, a person — grouped into categories. Click to drop one into
the scene, then **drag it around the ground plane** to line it up against the
stone.

Every dimension is a published measurement with its source in the tooltip: the
US quarter is 24.26 mm because the Mint says so, the bank card is ISO/IEC 7810
ID-1. A scale reference that is only approximate teaches the wrong size
confidently, so none of them are guesses.

The list also shows how many of each object span the stone's longest axis.

### 3D printing

The **Print** tab exports **STL** at true millimetre scale, rotated Y-up to
Z-up so it lands on the build plate the way it sat on the grid. No rescaling is
needed on import.

Before you export it shows:

- **Watertight check** — whether every edge is shared by exactly two triangles.
  A mesh with holes is either silently "repaired" by the slicer into something
  you did not design, or rejected. Worth knowing before a nine-hour print.
- **Solid volume and surface area**
- **Estimated mass and filament length** for PLA, PETG, ABS, resin, or nylon at
  a chosen infill
- **Build-volume fit** against common printers, testing both footprint
  orientations

glTF and OBJ are also available: glTF keeps the vertex colours for rendering,
OBJ is the lowest common denominator for other CAD tools. STL carries geometry
only — no colour — which is what a slicer wants.

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
| `favicon.svg` | Browser tab icon, 96×96 viewBox |
| `apple-touch-icon.png` | 180×180, iOS home screen |
| `logo.svg` | In-app mark, 132×32 viewBox |

All three carry the OPN STONE seal. The seal is fine line art, so `favicon.svg`
and `logo.svg` embed it as a small PNG rather than tracing it to vector paths;
`apple-touch-icon.png` is flattened onto `#0c0d10` because iOS discards alpha.

To swap them, replace the files — the app reads them by name and needs no code
change.

---

## Project layout

```
frontend/
  scripts/check-bundle-secrets.mjs   Pre-publish bundle audit
  src/
    data/              Everything that touches storage lives here
      db.ts              IndexedDB wrapper
      store.ts           Queries, mutations, in-memory cache
      csv.ts             Parsing, column mapping, validation, export
      geo.ts             OpenStreetMap tiles and geocoding
      export.ts          File downloads and backups
    components/        ui · charts · layout · map · filters
    features/
      dashboard/ readings/ devices/ import/
      studio/            generator · viewer · gizmos · printing · references
    hooks/  lib/  styles/
  test/                CSV import · generator · STL and print stats

backend/               Optional. Unused by the frontend — see Live ingest.
```

`src/data/` is the single home for storage and network access; no UI component
reads or writes directly.

# Security

## Read this first: what this deployment exposes

**This installation has no user accounts.** That is a deliberate choice, and it
has consequences worth stating plainly rather than burying:

- **Anyone who knows the API URL can read every reading you have collected** —
  timestamps, sensor values, and **the GPS coordinates of every reading**.
- **Anyone can create, edit, and delete saved 3D designs.** The design library
  is shared and writable.
- **A private GitHub repository does not change any of this.** It hides the
  source, not the deployed site, and not the API — which is a separate
  deployment on a different host. On a Free plan, making the repo private
  disables GitHub Pages entirely; on a paid plan the site is published and
  world-readable regardless.

If the location history in your telemetry is sensitive — and location history
usually is — this model is the wrong one. Restoring authentication is the fix;
see *Putting auth back* at the end.

### What is still protected

- **Writing readings requires a device key.** Nobody can inject fake telemetry
  into your database without one.
- **No credential ships in the browser bundle.** Map and geocoding keys stay on
  the server.
- **Readings cannot be altered or deleted through the API by anyone.**

---

## Where secrets live

| Secret | Where it is set | Reaches the browser? |
|---|---|---|
| `MAP_TILES_KEY` | `fly secrets set` → backend env | No — substituted server-side |
| `GEOCODE_KEY` | `fly secrets set` → backend env | No — substituted server-side |
| Device keys | Only the SHA-256 is stored in the database | Shown once by the CLI, never by the API |
| Share tokens | Only the SHA-256 is stored | Returned once when minted |

The frontend bundle carries exactly two values: the public API base URL and a
cosmetic environment label. Both are `VITE_*` variables, both are inlined as
literal strings, and both are public by design.

There is **no password hashing, no session store, and no cookie** anywhere in
this codebase. The API sets no `Set-Cookie` header on any response.

### Why there is no map key in the browser

Tiles and geocoding are keyed services, so the naive implementation puts a key
in the client. This project does not:

- `GET /api/geo/style.json` — a MapLibre style whose tile URLs point back at us
- `GET /api/geo/tiles/:z/:x/:y` — server-side fetch to the upstream provider
  with the key from the environment, streamed back
- `GET /api/geo/search?q=` — proxied geocoding, reshaped into a fixed structure

If a future feature genuinely cannot avoid a browser-side map SDK key, treat it
as public: restrict by HTTP referrer to the Pages origin, enable only the APIs
in use, set hard daily quotas and billing alerts, and document it in the README
as exposed by design. Never use a server-side or unrestricted key that way. No
such key exists in this project today.

---

## The device key is the whole write-side security model

Reads are public, so the only thing standing between a stranger and your
readings table is that they cannot obtain a device key. Two properties keep
that true:

1. **There is no HTTP route that creates, rotates, or deletes a device.** Not a
   protected one — none at all. `POST /api/devices` returns 404 because no such
   route is registered. Provisioning is a local command:

   ```bash
   npm run device -- add "Pico-01 · Trail Rig"
   npm run device -- rotate dev_xxxxxxxxxxxxxxxxxx
   npm run device -- remove dev_xxxxxxxxxxxxxxxxxx
   ```

   Minting a key therefore requires access to the server or its volume, not
   merely access to the API. On Fly.io:

   ```bash
   fly ssh console -C "node /app/dist/scripts/device.js add 'Pico-01'"
   ```

2. **Keys are 256-bit CSPRNG output, stored only as SHA-256.** A database leak
   yields no usable keys, and a lost key is rotated rather than recovered.

`backend/test/ingest.test.ts` asserts property 1 directly: it attempts `POST`,
`PATCH`, `DELETE`, and `PUT` against the device routes and requires a 404 from
each. If someone later adds a provisioning endpoint, that test fails.

A slow hash is deliberately not used here. Argon2 is the right answer for
human-chosen passwords; for a full-entropy machine key there is no dictionary to
search, so it would add latency to every ingest request and buy nothing.

---

## What protects the rest

Reads and design writes are unauthenticated, so the controls are structural
rather than identity-based.

- **Rate limiting.** A global IP-keyed limiter (300 requests/minute), plus
  per-device ingest limits (120/minute) and separate per-IP ceilings on the map
  proxy (600 tiles/minute, 30 searches/minute). With no accounts these are the
  main backstop against abuse.
- **A library ceiling.** The design table is capped at 200 rows so a script
  cannot fill the volume.
- **Bounded payloads.** 256 KiB for most routes, 1 MiB for ingest, 200 readings
  per batch, 64 KiB for a single `extra` blob.
- **CORS with an explicit allowlist**, and `credentials: false` because nothing
  sends a cookie. An unknown origin receives no CORS headers at all. This stops
  casual embedding; it is not an access control, since anything that is not a
  browser ignores CORS entirely.

---

## Input handling and output hygiene

- **Validation.** Zod schemas are the authoritative validator, with physical
  plausibility ranges on every sensor field so a unit mix-up (psi sent as kPa)
  is rejected rather than stored. The client validates too, but only for speed
  of feedback.
- **SQL.** Every value is a bound parameter. Column, metric, and sort names come
  from server-side allowlists, because identifiers cannot be parameterised —
  that is an injection concern independent of authentication.
- **Rendering.** All device-supplied strings are rendered as React text
  children. There is no `dangerouslySetInnerHTML` anywhere in the tree, so an
  `extra` field containing markup round-trips as an inert string.
- **CSV injection.** Exported cells beginning with `=`, `+`, `-`, or `@` are
  prefixed with an apostrophe, because device names and the `extra` blob are
  attacker-influenced and a spreadsheet will execute a formula.
- **Errors fail closed.** One handler converts errors to responses. Known
  `ApiError`s carry a message written for a user; everything else collapses to a
  generic `500`. Stack traces, SQL text, file paths, and upstream provider
  responses are logged server-side and never serialised.
- **Response headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive
  `Permissions-Policy`, and HSTS in production.
- **Immutable readings.** Enforced by a `BEFORE UPDATE` trigger in SQLite, not
  by the absence of an `UPDATE` statement.
- **Untrusted design parameters.** Parameters arriving from a share URL are
  clamped by `sanitiseParams` before reaching the generator, so a tampered link
  cannot request a ten-million-triangle mesh or a negative dimension.

### Content-Security-Policy

Injected into `index.html` at build time so `connect-src` always matches the
configured API origin. No `unsafe-inline` or `unsafe-eval` for scripts.
`style-src` allows inline styles because MapLibre injects rules at runtime; that
is a style directive and cannot execute code.

GitHub Pages cannot set response headers, so the policy ships as a meta tag —
which cannot express `frame-ancestors` or `report-uri`. Behind a host that can
set headers, use:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self' https://your-api.fly.dev;
  worker-src 'self' blob:;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests
```

---

## Build-time guarantees

`npm run build` in `frontend/` runs `scripts/check-bundle-secrets.mjs` against
the output and fails on:

- AWS access key ids, Google API keys, Slack and GitHub tokens, Stripe keys,
  Mapbox/MapTiler secret tokens, JWTs, private-key blocks, database connection
  strings with inline credentials, service-account key fields, and this
  project's own `stk_` device-key format
- long opaque literals assigned to credential-shaped names
- forbidden files reaching the bundle (`.env*`, `*.pem`, `id_rsa`,
  `credentials.json`, `service-account*.json`)

The deploy workflow runs the same check and injects no repository secret. **If a
repository secret is ever needed at build time, the design is wrong** — the
feature belongs behind a backend proxy route.

The scanner is a backstop, not the control. The control is that the backend
holds every credential and the frontend has no code path that would use one.

---

## If something leaks

### A map or geocoding key

1. Issue a new key at the provider and delete the old one.
2. `fly secrets set MAP_TILES_KEY=... GEOCODE_KEY=...` — this restarts the app.
3. Nothing in the frontend changes; it never had the key.
4. Check the provider's usage graph for the exposure window.

### A device key

1. `npm run device -- rotate <device-id>` on the server. The previous key stops
   working the instant the command returns; only the hash is stored, so there is
   nothing to revoke separately.
2. Reconfigure the device with the new key.
3. Existing readings are unaffected. If bogus readings were ingested,
   `npm run device -- remove <device-id>` deletes the device and cascades to its
   readings; then register a fresh one.

### A share link

`Studio → Share → Revoke all`, or delete the rows from `design_shares`. Note
that with no accounts this only revokes the permalink — the design remains
readable through `GET /api/designs` like everything else.

### The database file

The volume holds device-key hashes and telemetry, including location history.
No plaintext credential is in it, but the telemetry itself is the sensitive
part.

1. Rotate every device key.
2. Rotate the map and geocoding keys, since an attacker with volume access
   likely had environment access too.
3. Treat the location history as disclosed.

---

## Putting auth back

If the exposure above is not acceptable, the smallest change that closes it is
to require a single shared credential on the read routes. Sketch:

1. Add `API_ACCESS_TOKEN` to the backend environment (a `fly secret`).
2. Add an `onRequest` hook that requires `Authorization: Bearer <token>` on
   everything except `/health` and `/api/ingest`.
3. **Do not put that token in the frontend bundle** — it would be published.
   The frontend would need a real login form that exchanges a password for an
   httpOnly cookie, which is the session model this project had before it was
   removed and which is recoverable from the git history.

The intermediate options are all worse than they look: an IP allowlist breaks on
mobile networks, and a token in `localStorage` is readable by any injected
script and still ships in the bundle if it is a build-time constant.

---

## Reporting

Open a private security advisory on the repository. Please do not file a public
issue for an unpatched vulnerability.

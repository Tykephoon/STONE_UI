# Security

## Where secrets live

**Every secret lives in the backend process environment. There are none
anywhere else.**

| Secret | Where it is set | Reaches the browser? |
|---|---|---|
| `MAP_TILES_KEY` | `fly secrets set` → backend env | No — substituted server-side |
| `GEOCODE_KEY` | `fly secrets set` → backend env | No — substituted server-side |
| Password hashes | `users.password_hash` (Argon2id) | No |
| Session tokens | Only the SHA-256 is stored; the token is in an httpOnly cookie | Only as a cookie script cannot read |
| Device keys | Only the SHA-256 is stored | Shown once at creation, never again |
| Share tokens | Only the SHA-256 is stored | Returned once when minted |

The frontend bundle carries exactly two values: the public API base URL and a
cosmetic environment label. Both are `VITE_*` variables, both are inlined as
literal strings, and both are public by design.

### Why there is no key in the browser

Map tiles and geocoding are keyed services, so the naive implementation puts a
key in the client. This project does not:

- `GET /api/geo/style.json` — a MapLibre style whose tile URLs point back at us
- `GET /api/geo/tiles/:z/:x/:y` — server-side fetch to the upstream provider
  with the key from the environment, streamed back
- `GET /api/geo/search?q=` — proxied geocoding, reshaped into a fixed structure

MapLibre reaches these through `transformRequest`, which attaches
`credentials: 'include'`, so they are authenticated like any other endpoint.

If a future feature genuinely cannot avoid a browser-side map SDK key, treat it
as public: restrict it by HTTP referrer to the Pages origin, enable only the
specific APIs in use, set hard daily quotas and billing alerts, and document it
in the README as exposed by design. Never use a server-side or unrestricted key
that way. No such key exists in this project today.

---

## How the proxy routes are protected

Three properties stop `/api/geo/*` from becoming an open relay:

1. **Authentication.** `requireUser` runs first. Anonymous callers get `401`.
2. **Per-user rate limits**, independent of the global IP limiter — 600
   tiles/min and 30 searches/min by default (`GEO_TILE_RATE_PER_MINUTE`,
   `GEO_SEARCH_RATE_PER_MINUTE`).
3. **No caller-controlled URL.** The upstream URL is built from a server-side
   template. `z`, `x`, and `y` are parsed as integers and range-checked against
   the tile pyramid (`x, y < 2^z`), and the search term is URL-encoded into a
   `{q}` placeholder. No part of a request is ever treated as a URL, so the
   proxy cannot be pointed at an arbitrary host.

Additionally, upstream responses are validated before being forwarded: a tile
must carry an image or vector-tile content type, and geocoder output is
reshaped into a fixed `{label, latitude, longitude, kind}` structure rather
than passed through, so provider metadata cannot leak into the client. Tile
responses are `Cache-Control: private` — the route is authenticated and a
shared cache must not serve one user's tile to another.

---

## Session handling

- **Transport.** Opaque 256-bit token in a cookie: `HttpOnly; Secure;
  SameSite=None; Path=/`. Never in `localStorage` or `sessionStorage`, so an
  injected script has nothing to read.
- **Storage.** Only `sha256(token)` is persisted. A database leak yields no
  usable sessions.
- **Lifetime.** 30-minute sliding window inside a 7-day absolute cap that is
  never extended. The SPA refreshes silently every 12 minutes and reactively
  once on a `401`.
- **Rotation.** `POST /api/auth/refresh` issues a new token and retires the old
  one, bounding the useful life of a stolen token.
- **Logout.** Deletes the session row. Clearing the cookie is incidental — the
  invalidation is the delete, so a captured cookie is dead immediately.
  `POST /api/auth/logout-all` revokes every session for the account.

### CSRF

Cookies are sent cross-site automatically because `SameSite=None` is required
for a `github.io` frontend talking to an API on another domain. Two independent
checks guard every state-changing request:

1. **Synchroniser token.** A non-httpOnly `stone_csrf` cookie is mirrored into
   an `X-CSRF-Token` header and compared against the value stored on the
   session row with a constant-time comparison. A cross-origin page can cause
   the browser to *send* the cookie but cannot *read* it to echo it back.
2. **Origin allowlist.** The `Origin` header is checked against
   `ALLOWED_ORIGINS` on the same requests.

Either failing rejects with `403`. `/api/ingest` is exempt because it
authenticates with a bearer device key, which a browser will never attach on
its own, and there is therefore no ambient authority to abuse.

### CORS

An explicit allowlist with `credentials: true`, never a wildcard — and a
wildcard would be rejected by the browser anyway once credentials are involved.
An unknown origin receives no CORS headers at all.

### Login hardening

- Unknown email and wrong password return an identical body and status, and the
  unknown-email path performs a dummy Argon2 verification so response timing
  does not enumerate accounts.
- Per-account throttle in the database: 8 failures in 15 minutes locks the
  account for 15 minutes. It survives restarts and IP rotation, which an
  IP-keyed limiter alone does not.
- A separate IP-keyed HTTP limiter caps login at 10 attempts per 5 minutes and
  registration at 5 per 15 minutes.

Registration necessarily reveals whether an address is already in use — there
is no way to create an account at an address that already exists. The
mitigation is the rate limit, not a vague message.

---

## Authorisation

**The backend is the only trust boundary.** Route guards in the SPA are
navigation convenience; the code is written on the assumption that they can be
bypassed, because they can.

Every protected handler:

- re-derives the caller from the session cookie on that request,
- puts `user_id` in the SQL `WHERE` clause rather than filtering after the
  fetch, so ownership cannot be accidentally omitted, and
- returns `404` rather than `403` for records owned by someone else, so probing
  cannot confirm that an id exists.

This is covered by `backend/test/ownership.test.ts`, which assumes an attacker
who knows the exact id of another user's record and holds a valid session of
their own.

---

## Other controls

- **Content-Security-Policy.** Injected into `index.html` at build time so
  `connect-src` always matches the configured API origin. No `unsafe-inline` or
  `unsafe-eval` for scripts. `style-src` allows inline styles because MapLibre
  injects rules at runtime; that is a style directive and cannot execute code.
- **Rendering.** All device- and user-supplied strings are rendered as React
  text children. There is no `dangerouslySetInnerHTML` anywhere in the tree.
  Telemetry `extra` fields and device names reach the DOM only as text.
- **CSV injection.** Exported cells beginning with `=`, `+`, `-`, or `@` are
  prefixed with an apostrophe, because device names and the `extra` blob are
  attacker-influenced and a spreadsheet will execute a formula.
- **Errors fail closed.** One handler converts errors to responses. Known
  `ApiError`s carry a message written for a user; everything else collapses to
  a generic `500`. Stack traces, SQL text, file paths, and upstream provider
  responses are logged server-side and never serialised.
- **Response headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive
  `Permissions-Policy`, and HSTS in production.
- **Share links.** A share token identifies one design, not a user and not a
  session. The response carries no owner identity, no internal design id, and
  no sibling designs. Tokens are revocable and stored hashed. Presenting one as
  a session cookie or bearer token authenticates nothing — covered by a test.
- **Untrusted parameters.** Design parameters arriving from a URL are clamped
  by `sanitiseParams` before reaching the generator, so a tampered link cannot
  request a ten-million-triangle mesh or a negative dimension.
- **Immutable readings.** Enforced by a database trigger, not by the absence of
  an `UPDATE` statement.

### The CSP header, for hosts that can set one

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

The deploy workflow runs the same check and injects no repository secret. **If
a repository secret is ever needed at build time, the design is wrong** — the
feature belongs behind a backend proxy route.

The scanner is a backstop, not the control. The control is that the backend
holds every credential and the frontend has no code path that would use one.

---

## If something leaks

Rotate in this order. Each step is independent.

### A map or geocoding key

1. Issue a new key at the provider and delete the old one.
2. `fly secrets set MAP_TILES_KEY=... GEOCODE_KEY=...` — this restarts the app.
3. Nothing in the frontend changes; it never had the key.
4. Check the provider's usage graph for the exposure window.

### A device key

1. **Devices → Rotate key.** The previous key stops working the instant the
   request returns; only the hash is stored, so there is nothing to revoke
   separately.
2. Reconfigure the device with the new key.
3. Existing readings are unaffected. If bogus readings were ingested, delete
   the device (which cascades to its readings) and register a fresh one.

### A user password

1. Sign in and change it, then **sign out everywhere**
   (`POST /api/auth/logout-all`) to revoke every session immediately.
2. If the account is compromised and inaccessible, delete its sessions
   server-side: `DELETE FROM sessions WHERE user_id = ?`.

### A session token

`POST /api/auth/logout-all` for that user. Tokens are opaque and stored hashed,
so there is no signing key to rotate and no other session is affected.

### A share link

**Studio → Share → Revoke all.** All outstanding links for that design stop
working immediately. Other designs are unaffected — a share token has never
granted more than the single design it names.

### The database file

The Fly volume holds password hashes (Argon2id), session hashes, device-key
hashes, and telemetry. No plaintext credential is in it. Still:

1. Rotate every device key (each user, each device).
2. `DELETE FROM sessions` to force universal re-authentication.
3. Require password resets — Argon2id is expensive to attack, but a leaked hash
   is a leaked hash.
4. Rotate the map and geocoding keys, since an attacker with volume access
   likely had environment access too.

---

## Reporting

Open a private security advisory on the repository. Please do not file a public
issue for an unpatched vulnerability.

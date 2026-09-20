# Security

## The short version

The deployed app is a **static bundle with no server and no accounts**. It holds
no credentials because it has none to hold, and it stores your data in your own
browser rather than on someone else's computer.

That removes most of the attack surface a web app usually has — there is no
session to steal, no API to authenticate against, no database to breach. What
remains is worth understanding.

| Question | Answer |
|---|---|
| Where is my telemetry? | IndexedDB, in the browser you imported it into. It never leaves. |
| Who else can see it? | Nobody, unless they have access to your device or browser profile. |
| Are there any API keys? | None. Every map, imagery, and elevation source is keyless, and the photo analysis runs locally rather than calling a model. |
| Does anything phone home? | Only map tiles, aerial imagery, elevation data, and place searches. |
| Is the site itself private? | No. The **site** is public; your **data** is not in it. |

---

## What "no server" does and does not protect

**Does protect.** Your readings and their GPS coordinates are never transmitted
anywhere. There is no server to compromise, no database to dump, and no
operator — including the person who deployed the site — who can read your data.

**Does not protect.** Anyone with access to your unlocked device can open the
app and read everything, exactly as they could open your files. Browser storage
is not encrypted at rest and is not protected by a password. If the machine is
shared, treat the data as visible to whoever else uses it.

**Also worth knowing.** A private GitHub repository would hide the source, not
the published site. GitHub Pages sites are world-readable regardless of
repository visibility (and on a Free plan, making the repo private disables
Pages entirely). The site being public is fine here precisely *because* it
carries no data — only code.

---

## Where secrets live

Nowhere. There are none.

- **No API keys.** Map tiles come from `tile.openstreetmap.org`, place search
  from `nominatim.openstreetmap.org`, aerial imagery from
  `server.arcgisonline.com`, and elevation from the public tile set on
  `s3.amazonaws.com`. All four are keyless.
- **No passwords or sessions.** There are no accounts.
- **No build-time secrets.** The deploy workflow injects nothing; the build takes
  no configuration at all.

The bundle's only inlined value is an optional cosmetic environment label.

### Why the photo analysis is not a model call

The Photo tab reads a rock out of a picture. It would be easier and probably
better to send that picture to a hosted vision model — and it is not done,
for the same reason the map has no key. A hosted model needs an API key, this
is a static site, and a key in a static bundle is published the moment it
deploys. There is no server to hold one.

So the analysis is local computer vision in
`frontend/src/features/studio/rockAnalysis.ts`: background segmentation,
gradient statistics, structure-tensor coherence, and a radial profile of the
outline. A second consequence is worth stating plainly, because it is the part
users care about: **the image never leaves the machine.** It is decoded in the
tab and measured in the tab. There is no upload, and `connect-src` lists no
host that could receive one.

### Why there is no Google Earth

Google Earth and Google Maps were asked for by name, and are deliberately not
used. Two reasons, either one sufficient:

1. **The key would be published.** Their tiles require a browser API key. This
   is a static site with no server, so a browser key is a key in the bundle,
   and the bundle is world-readable. There is nowhere to hide it.
2. **The terms forbid the use.** Google's terms prohibit deriving a dataset
   from their imagery or elevation, which is precisely what the studio does —
   it reads the ground and turns it into a 3D model you then own and print.

What is there instead does the same job without either problem: Esri's World
Imagery for the aerial view, the open global elevation model for relief, and
MapLibre's terrain renderer to combine them into a view you can tilt and fly.
Both sources are attributed in the map control, as their terms require.

### If a keyed provider is ever adopted

A keyed map provider (MapTiler, Mapbox) would be a meaningful upgrade in tile
quality, and it is the one change most likely to reintroduce a credential.
**Do not put the key in the frontend** — Vite inlines `VITE_*` variables as
literal strings and the bundle is world-readable, so it would be published the
moment it deployed.

The correct shape is the proxy that already exists in `backend/src/routes/geo.ts`:
the key stays in the server's environment, the browser calls
`/api/geo/tiles/:z/:x/:y`, and the server substitutes the key. That code is
still in the repository for exactly this reason.

If a browser-side SDK key genuinely cannot be avoided, treat it as public:
restrict it by HTTP referrer to the Pages origin, enable only the APIs in use,
set hard daily quotas and billing alerts, and document it as exposed by design.
Never use a server-side or unrestricted key that way.

---

## Outbound network traffic

The app contacts exactly four hosts, all declared in one place —
`EXTERNAL_HOSTS` in `frontend/vite.config.ts` — which is also what generates the
Content-Security-Policy. Adding a host there means adding a party that can
observe traffic from the page.

| Host | Why | What it sees |
|---|---|---|
| `tile.openstreetmap.org` | Street basemap | Which map areas you view, and your IP |
| `nominatim.openstreetmap.org` | Place search in the studio | Your search terms, and your IP |
| `server.arcgisonline.com` | Aerial imagery | Which map areas you view, and your IP |
| `s3.amazonaws.com` | Elevation data, for map relief and for deriving a stone | Which areas you view or pin, and your IP |

None of them receives your telemetry. Tiles are requested for the area you are
viewing, which does reveal roughly where your readings are — if that matters,
the map can be left closed and every other view still works. Dropping a pin
requests elevation around it, which reveals that location with more precision
than browsing does.

Nominatim's usage policy allows one request per second. Search-as-you-type
makes that load-bearing rather than precautionary, so it is enforced twice:
the input debounces and aborts, and `data/geo.ts` holds a queue that spaces
whatever survives. The queue is the guarantee; the debounce is only an
optimisation.

---

## Content-Security-Policy

Generated at build time from the host list above and injected into
`index.html`:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://tile.openstreetmap.org https://nominatim.openstreetmap.org
        https://server.arcgisonline.com https://s3.amazonaws.com;
font-src 'self' data:;
media-src 'self' blob:;
connect-src 'self' https://tile.openstreetmap.org https://nominatim.openstreetmap.org
            https://server.arcgisonline.com https://s3.amazonaws.com;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

No `unsafe-inline` or `unsafe-eval` for scripts. `style-src` permits inline
styles because MapLibre injects rules at runtime — that is a style directive and
cannot execute code.

A meta tag cannot express `frame-ancestors`; the directive is included above for
any host that can set real headers, but on GitHub Pages it has no effect.

---

## Handling untrusted input

Everything the app reads is untrusted: CSV files come from other people's tools,
and share links come from whoever sent them.

- **Rendering.** All imported strings reach the DOM as React text children.
  There is no `dangerouslySetInnerHTML` anywhere in the tree, so a CSV cell
  containing `<img src=x onerror=...>` is displayed as those characters.
- **CSV parsing.** A hand-written RFC 4180 parser with no `eval` and no regex
  backtracking hazards. Malformed input produces reported issues, not
  exceptions.
- **Range validation.** Every numeric field is bounded before storage, so a
  transposed unit or a corrupt row is rejected rather than charted.
- **CSV export.** Cells beginning with `=`, `+`, `-`, or `@` are prefixed with an
  apostrophe. Imported device names and extra fields are attacker-influenced,
  and a spreadsheet will execute `=cmd|...` on open. Extra fields are
  additionally JSON-wrapped, so a formula inside them can never begin a cell.
- **Share links.** Design parameters decoded from a URL are clamped by
  `sanitiseParams` before reaching the generator, so a tampered link cannot
  request a ten-million-triangle mesh or a negative dimension. A link that
  cannot be decoded shows an error rather than throwing.
- **Storage limits.** Imports are capped at 100,000 readings and 500 designs, so
  a pathological file cannot exhaust the origin's storage quota.
- **STL export.** Written from the same in-memory geometry the viewer shows, with
  no server round trip and no external tool. The watertight check is advisory —
  it reports what a slicer will find, it does not modify the mesh.

---

## Build-time guarantees

`npm run build` runs `scripts/check-bundle-secrets.mjs` against the output and
fails on:

- AWS access key ids, Google API keys, Slack and GitHub tokens, Stripe keys,
  Mapbox/MapTiler secret tokens, JWTs, private-key blocks, database connection
  strings with inline credentials, and service-account key fields
- long opaque literals assigned to credential-shaped names
- forbidden files reaching the bundle (`.env*`, `*.pem`, `id_rsa`,
  `credentials.json`, `service-account*.json`)

CI runs the same check. **The deploy workflow injects no secret. If it ever
needs one, the design has gone wrong.**

The scanner is a backstop, not the control. The control is that the app has no
code path that would use a credential.

---

## Sharing a design

A share link carries the design's parameters encoded in the URL fragment. That
makes it work forever with no server — and means it **cannot be revoked**. The
studio says so where the link is generated.

It exposes only the stone: dimensions, shape, and material. No telemetry, no
other designs, nothing about you.

---

## Your data is only as safe as your backup

There is no server, so there is also no backup. Browser storage is deleted by:

- clearing site data or browsing history with "cookies and site data" selected
- some "clean up disk space" tools
- private or incognito windows, when the window closes
- browser storage eviction under heavy disk pressure (rare, but possible)

**Import → Export backup** is the only copy. Take one before clearing history or
switching machines.

---

## If something goes wrong

**I imported the wrong file.** Import → Delete all readings, then re-import.
Devices and designs are untouched.

**I want to wipe the browser copy.** Import → Delete everything. The app returns
to its empty state; there is no sample data to fall back to.

**A shared link is circulating and I want it dead.** You cannot revoke it — the
design travels inside the link. It only ever exposed that one stone.

**The machine was compromised.** Assume the local data was readable. There are
no credentials to rotate, and nothing was ever transmitted, so the exposure is
limited to whatever was in that browser profile.

---

## The optional backend

`backend/` contains a Fastify + SQLite API for live device ingest. It is **not
used by the deployed frontend** and is not running anywhere by default.

If you do deploy it, it carries its own considerations: device keys are the only
credential, provisioning is deliberately CLI-only so no HTTP route can mint one,
reads are unauthenticated, and CORS uses an explicit origin allowlist. Those
decisions and their trade-offs are documented in the module headers and asserted
by `backend/test/access.test.ts`.

---

## Reporting

Open a private security advisory on the repository. Please do not file a public
issue for an unpatched vulnerability.

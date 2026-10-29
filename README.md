# safesight-mdt-demo

A small Flask app that plays a **Mobile Data Terminal** (an in-vehicle terminal for
emergency responders) against the SafeSight REST API. It signs
in with a SafeSight account, lists the user's Areas of Interest (AOIs), downloads the
files inside a chosen AOI to a local cache, and shows them on an OpenStreetMap base map
with a file preview panel. Synced files still open after SafeSight becomes unreachable.

The app only reads from SafeSight. It never uploads, edits or deletes.

> Screenshot: _placeholder. Add `docs/images/mdt-map.png` once the app has been run
> against a seeded SafeSight instance._

## Prerequisites

- Python 3.13 or newer and [uv](https://docs.astral.sh/uv/)
- A reachable SafeSight instance and an account on it
- Internet access in the browser for OpenStreetMap tiles (Leaflet and Bulma are vendored)

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `SAFESIGHT_BASE_URL` | required | Base URL of SafeSight, e.g. `http://localhost:10000` |
| `MDT_CACHE_DIR` | `./mdt-cache` | Where synced files and manifests are stored |
| `MDT_SECRET_KEY` | random per start | Flask session signing key. Set it to keep cookies valid across restarts |
| `SAFESIGHT_VERIFY_TLS` | `true` | Set `false` to skip TLS verification (development only) |
| `SAFESIGHT_TIMEOUT` | `30` | Per-request timeout in seconds |
| `MDT_MAX_SYNC_BYTES` | `524288000` | Size cap per AOI sync (500 MB). Remaining files are marked failed |

## Run

```bash
uv sync
export SAFESIGHT_BASE_URL=http://localhost:10000
uv run flask --app mdt.app run --port 10100
# or: uv run python -m mdt
```

Open <http://localhost:10100> and sign in with a SafeSight username and password.

## Tests

```bash
uv run pytest -q
uv run ruff format . && uv run ruff check --fix .
```

Tests mock all HTTP with `responses`; no network or SafeSight instance is needed.

## Browser / iOS version

`pwa/` is a second implementation of the same MDT that needs no server of its own: plain static
files that run in the browser (including iOS Safari), call SafeSight directly over CORS, keep
synced files in IndexedDB, and work offline through a service worker. It needs the page's origin
in SafeSight's `CORS_ALLOWED_ORIGINS`. The Flask app above is unchanged. See
[pwa/README.md](pwa/README.md) to serve it, add it to an iPhone's Home Screen, and run its tests.

## Seeding a SafeSight instance

`scripts/seed_safesight_demo.py` creates a demo organisation, user, AOI and located
files. It runs inside SafeSight via its Django shell and only changes the target
database. From inside the SafeSight checkout:

```bash
uv run python manage.py shell < /path/to/safesight-mdt-demo/scripts/seed_safesight_demo.py
```

It creates an "Oxford city centre" AOI holding 6 files: a PNG, a PDF, text, an SVG,
a coverage-polygon-only file, and a file shared in from a second organisation by
SafeSight's own spatial matching. A seventh file lies outside the AOI as a negative
control. Sign in to the MDT as:

| User | Role | What you'll see |
|---|---|---|
| `mdt_demo` | `user` | Sync downloads all 6 files |
| `mdt_viewer` | `viewer` | Every file is marked **Denied**, because SafeSight returns 403 to viewers |

The password is `$MDT_DEMO_PASSWORD`. If that is unset, the script generates a
random password and prints it at the end.
Never run the script against production.

## Design

See [docs/architecture.md](docs/architecture.md) for the module layout, the SafeSight API
contract the app relies on, and how AOI membership is found (the AOI files endpoint when supported, else a client-side scan).

## Known limitations

- **Offline tiles.** Base-map tiles need the network unless the browser has cached them.
  Synced files and AOI outlines work offline; the map background may not.
- **Tokens are in memory.** SafeSight tokens live in a server-side in-memory store, so
  restarting the app signs everyone out, and the cached data cannot be browsed until you
  sign in again (which needs SafeSight to be reachable).
- Single-process development server; not hardened for production or many concurrent users.
- The MDT uses SafeSight's AOI files endpoint (fixed in SafeSight #396) only when its
  results include `can_download`. Against a server without that field, or an older one
  that still returns 500, a sync scans every file the user can see, which is fine at
  demo scale.
- The browser UI (`app.js`) is not covered by the pytest suite. It was checked end to
  end with Playwright against a live, seeded SafeSight instance.

## SafeSight issues found while building this

These were found against a live instance. This repo does not modify SafeSight, so both
are recorded here as history and have since been fixed upstream:

1. `GET /api/v1/areas-of-interest/{id}/files/` and `POST /api/v1/files/spatial_search/`
   returned **500**, because the `distance` annotation is a GeoDjango `Distance` object
   but `SpatialSearchResultSerializer.distance` is a `FloatField`. Fixed upstream in
   [SafeSight #396](https://github.com/John-Howard/safesight/pull/396): both endpoints
   no longer return 500, and `distance` is float metres or null. The GeoJSON selector is
   now `?output=geojson`; `?format=geojson` still returns **404**, because `format` is
   DRF's reserved renderer-override parameter. See the AOI files note in
   `docs/architecture.md` for how the MDT uses the endpoint.
2. **View-only spatial shares were downloadable.** `user_can_download_file` in
   `files/permissions.py` never checked the match's `permission_level`, so a share set
   to `view` returned `can_download: true` and HTTP 200 on `/download/`. Fixed upstream in
   [SafeSight #397](https://github.com/John-Howard/safesight/pull/397).

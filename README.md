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
contract the app relies on, and why AOI membership is computed client-side.

## Known limitations

- **Offline tiles.** Base-map tiles need the network unless the browser has cached them.
  Synced files and AOI outlines work offline; the map background may not.
- **Tokens are in memory.** SafeSight tokens live in a server-side in-memory store, so
  restarting the app signs everyone out, and the cached data cannot be browsed until you
  sign in again (which needs SafeSight to be reachable).
- Single-process development server; not hardened for production or many concurrent users.
- A sync scans every file the user can see (SafeSight's own AOI files endpoint is broken),
  which is fine at demo scale.
- The browser UI (`app.js`) is not covered by the pytest suite. It was checked end to
  end with Playwright against a live, seeded SafeSight instance.

## SafeSight issues found while building this

These were found against a live instance and are **not** fixed here, because this repo
does not modify SafeSight:

1. `GET /api/v1/areas-of-interest/{id}/files/` and `POST /api/v1/files/spatial_search/`
   return **500**. The `distance` annotation is a GeoDjango `Distance` object, but
   `SpatialSearchResultSerializer.distance` is a `FloatField`. Their `?format=geojson`
   mode returns **404**, because `format` is DRF's reserved renderer-override parameter.
2. **View-only spatial shares are still downloadable.** `user_can_download_file` in
   `files/permissions.py` never checks the match's `permission_level`. A share set to
   `view` returns `can_download: true` and HTTP 200 on `/download/`.

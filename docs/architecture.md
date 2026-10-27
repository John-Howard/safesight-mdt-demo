# SafeSight MDT Demonstrator — Architecture

A small Flask app that plays the role of a **Mobile Data Terminal** (an in-vehicle
terminal for emergency responders). It signs in to a SafeSight server over the REST
API, lists the user's Areas of Interest (AOIs), downloads the files inside a chosen
AOI to a local cache, and shows them over an OpenStreetMap base map. A file that has
been synced can still be displayed after the network drops, as an MDT would need.

The app only ever *reads* from SafeSight. It never uploads, edits, or deletes.

## Shape

```
 Browser (Leaflet + vanilla JS)          Flask MDT app (this repo)             SafeSight
 ──────────────────────────────          ─────────────────────────             ─────────
 map, AOI list, file list,   ──/api──▶   routes.py  ──▶ safesight_client.py ──JWT──▶ /api/v1/...
 preview panel               ◀─JSON───   (BFF)      ──▶ cache.py ──▶ MDT_CACHE_DIR/
                                         geometry.py (normalise to GeoJSON)
```

The Flask app is a **backend-for-frontend**:

- The browser never sees the SafeSight JWT. Tokens live in a server-side store
  (`token_store.py`) keyed by an opaque id in the Flask session cookie.
- The browser talks only to the Flask app's own `/api/...` JSON routes and to the OSM
  tile server.
- Downloaded files are served to the browser from the local cache, not proxied live.
  The preview therefore works offline once an area has been synced.

## SafeSight API contract used

Read from the SafeSight source (`config/urls.py`, `config/api/v1/urls.py`,
`organizations/api/views.py`, `files/views.py`, `files/permissions.py`,
`files/serializers.py`), then **checked against a running SafeSight instance**
seeded with `scripts/seed_safesight_demo.py`. SafeSight's own API docs are older
than its code, so they were not relied on.

| Purpose | Call | Notes |
|---|---|---|
| Sign in | `POST /api/token/` `{"username","password"}` → `{"access","refresh"}` | simplejwt. Access token 60 min, refresh token 1 day. Header is `Authorization: Bearer <access>`. DRF `TokenAuthentication` is deliberately **not** enabled. django-axes locks an account out after repeated failures. |
| Refresh | `POST /api/token/refresh/` `{"refresh"}` → `{"access","refresh"}` | `ROTATE_REFRESH_TOKENS=True` + blacklist: **store the new refresh token every time**, because the old one is now dead. |
| List AOIs | `GET /api/v1/areas-of-interest/geojson/` | Unpaginated GeoJSON `FeatureCollection` (`application/geo+json`) of the AOIs the user can access (their org's and their groups'). Geometry is a `MultiPolygon`. Properties: `id, name, description, purpose, organization_name, group_name, ...`. |
| File list | `GET /api/v1/files/?is_published=true&page_size=200` | Paginated `count/next/previous/results`. Per file: `id, original_filename, mime_type, file_size, organization_name, group_name, uploaded_at, has_location, ...`. Includes the user's org files, group files, and files spatially shared to their org. |
| File points | `GET /api/v1/files/geojson/?is_published=true&page_size=200` | Paginated, but `results` is a GeoJSON `FeatureCollection` of files **with a point location**. Each feature's properties include `can_download` (SafeSight's role-based check). |
| File detail | `GET /api/v1/files/{id}/` | Only needed for files with no point location. `coverage_area_dual_crs.epsg_4326` is a GeoJSON polygon (or `null`). |
| Download | `GET /api/v1/files/{id}/download/` | Streams the bytes as `attachment`. **403** `{"error": "...viewers cannot download"}` for role `viewer`, and for group files where the user's group role is `viewer`. Every attempt is written to SafeSight's `FileAccessLog`, and downloads of spatially shared files notify the owning organisation. |

### How the MDT finds "files in an AOI"

SafeSight has an endpoint built for this, `GET /api/v1/areas-of-interest/{id}/files/`,
and it is **broken**. Verified against a running instance:

- With the default JSON output it **returns 500**: `TypeError: float() argument must
  be a string or a real number, not 'Distance'`. The view annotates `distance` with
  GeoDjango's `Distance()`, which yields a `Distance` measure object, but
  `SpatialSearchResultSerializer.distance` is a `FloatField`.
- `?format=geojson`, the view's other output mode, **returns 404** because `format` is
  DRF's reserved renderer-override parameter and only a JSON renderer is installed.
- `POST /api/v1/files/spatial_search/` uses the same serializer and also **returns 500**.

This app does not modify SafeSight, so it computes AOI membership itself
(`safesight_client.iter_area_files`) using the same predicate as SafeSight's
spatial matching engine:

1. Walk the file list, which gives sizes and the `has_location` flag.
2. Walk the file-points GeoJSON, which gives geometry and `can_download`.
3. For files with no point location, fetch the detail and use the coverage polygon.
4. Keep a file when its point lies inside the AOI or its coverage polygon intersects
   it (`shapely`).

Cost: two paginated walks plus one request per coverage-only file. That is fine at
demo scale, but it scans every file the user can see. Once SafeSight's AOI endpoint
is fixed, `iter_area_files` should switch to it.

### Other traps

1. **Never send a `format` query parameter**, for the reason above.
2. **Thumbnails are not reachable with a JWT.** `thumbnail_url` is a `/media/` path
   that SafeSight serves only in `DEBUG`, and the `/files/<id>/thumbnail/` page view
   needs a session login. The MDT renders previews from the downloaded file itself.
3. **Pagination caps at 200 per page** (`max_page_size`). The client walks `next`
   until it runs out.
4. **Throttles.** Users get 5000 requests/hour overall, which is ample for a demo
   sync.
5. **Skip downloads that would be denied.** When `can_download` is false, mark the
   file `denied` without requesting it, so the MDT does not fill the owning
   organisation's audit log with denied attempts.
6. **The user's own soft-deleted uploads.** `get_files_for_user` returns a user's own
   uploads whatever their published or deleted state, and the list endpoint does not
   expose `is_deleted`. Filtering with `is_published=true` removes most of these, but
   a published upload the same user later soft-deleted can still appear. This is
   rare for an MDT account, which normally only reads.

## Modules

| Module | Responsibility |
|---|---|
| `mdt/config.py` | Settings from env vars: `SAFESIGHT_BASE_URL` (required), `MDT_CACHE_DIR` (default `./mdt-cache`), `MDT_SECRET_KEY`, `SAFESIGHT_VERIFY_TLS` (default true), `SAFESIGHT_TIMEOUT` (default 30 s), `MDT_MAX_SYNC_BYTES` (default 500 MB per AOI). |
| `mdt/safesight_client.py` | Functions, not a class: `obtain_tokens`, `refresh_tokens`, `get_areas_geojson`, `iter_area_files(session, aoi_geometry)` (the client-side AOI filter described above, yielding one dict per file: `id, original_filename, mime_type, file_size, organization_name, group_name, uploaded_at, can_download, geometry`), `get_file_detail`, `download_file_to`. Each takes an `ApiSession` (base URL + tokens). On a 401 it refreshes once, retries, and stores the rotated tokens. Raises `SafeSightError` subclasses (`AuthError`, `PermissionDenied`, `NotFound`, `RateLimited`, `ServerUnavailable`). |
| `mdt/token_store.py` | Thread-safe in-memory map `session_id → Tokens`. Tokens are not persisted, so a restart signs everyone out. |
| `mdt/geometry.py` | `to_geojson(value) -> Optional[dict]` for GeoJSON dicts and, defensively, WKT/EWKT strings (via shapely). `intersects(geometry, aoi_geometry) -> bool` (False for missing or invalid input). `file_feature(file_dict) -> dict` builds a GeoJSON Feature from an `iter_area_files` item; geometry may be null. |
| `mdt/cache.py` | **Per-user**, per-AOI cache: `MDT_CACHE_DIR/<user_id>/<aoi_id>/manifest.json` + `files/<file_id>`, where `<user_id>` is the SafeSight user's UUID (`cache.user_root`). Users never share cached files, so a viewer SafeSight refuses to let download, or a user in another organisation, cannot read what someone else synced. Writes the manifest atomically (temp file + rename). Each entry records status `downloaded`, `denied` (403), or `failed` with the reason. A re-sync skips files already present with the same `file_size`. File ids must be UUIDs, so a hostile id cannot become a path. |
| `mdt/sync.py` | `sync_area(session, aoi_id, cache_root)`: fetch the AOI geometry, list the AOI's files, and download each one, recording a per-file outcome. Files with `can_download` false become `denied` without a request. One failure does not stop the run. Returns a summary. |
| `mdt/routes.py` | Flask blueprint: `/` (map page), `/login` and `/logout`, plus JSON routes `/api/areas`, `/api/areas/<id>/files` (live list merged with cache status), `/api/areas/<id>/sync` (POST), `/api/areas/<id>/cached` (offline view from the signed-in user's manifest), `/files/<aoi>/<file_id>` (serves the cached bytes; `inline` only for safe preview types). |
| `mdt/app.py` | `create_app(config)` factory. |

## UI

- Full-height Leaflet map with OSM tiles from `tile.openstreetmap.org`, carrying the
  required attribution. Leaflet and Bulma are **vendored** under `mdt/static/vendor/`
  rather than loaded from a CDN, so the UI still loads with no network. Base-map
  tiles still need the network unless the browser has already cached them.
- Left panel: AOI list. Clicking an AOI draws its polygon, zooms to it, and lists its
  files.
- Files appear as markers (points) or outlines (coverage polygons). The marker colour
  shows cache state: synced, not yet synced, or denied.
- A **Sync area** button downloads everything and shows a progress summary
  (downloaded, skipped, denied, failed).
- Clicking a file opens a preview panel. Images render inline, PDFs in an `<iframe>`,
  and text as escaped `<pre>`. Any other type gets a "Save" link.
- An **Offline** indicator. When SafeSight cannot be reached, the AOI view falls back
  to the cached manifest so synced areas still work.

Security: Jinja autoescaping, and the JS builds DOM with `textContent` rather than
`innerHTML` for every server-supplied string (filenames come from other
organisations). The cache is namespaced per SafeSight user: at login the app reads the `user_id` claim from the access JWT (payload only, no signature check, since it arrived from SafeSight over our own connection), requires it to be a UUID or refuses the login, and keeps it in the Flask session. Every cache, sync and route call, including the offline area list, works inside that user's directory. The app sets its own CSP and serves cached files with
`X-Content-Type-Options: nosniff`. Inline display is limited to an allow-list
(`image/png|jpeg|gif|webp`, `application/pdf`, `text/plain`), and **SVG and HTML are
always served as downloads**, because they can carry script.

## Testing

- Unit tests (pytest + `responses` to mock HTTP, with fixtures shaped like real
  SafeSight responses): token refresh and rotation, 401 → refresh → retry, pagination
  walk, client-side AOI filter (point in, point out, coverage-only intersecting),
  never sending `format`, 403 handled per file, geometry parsing, cache path safety, manifest round-trip, route auth, and the
  content-type allow-list.
- Integration: run against a real SafeSight instance seeded with
  `scripts/seed_safesight_demo.py`. That script runs *inside* SafeSight via
  `manage.py shell` and creates a demo org, user, AOI, and located files. It changes
  only the target database, never SafeSight's code.

## Out of scope

Uploading from the MDT, push notifications, background sync, multiple concurrent
users at scale, and token persistence across restarts.

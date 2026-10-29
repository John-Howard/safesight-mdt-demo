# SafeSight MDT: browser / iOS version (PWA)

A static-files version of the MDT. It runs entirely in the browser (iOS Safari included), signs
in to SafeSight directly over CORS, caches synced files in IndexedDB, and works offline through a
service worker. There is no server of its own: the Flask app in `mdt/` is untouched and still the
right choice when you want a backend-for-frontend that keeps tokens out of the browser.

The behaviour is a port of the Flask app: same sign-in, same AOI list and file list, same sync
rules (denied without requesting, size limit, skip unchanged files), same preview allow-list.
The SafeSight API contract and its traps are in [../docs/architecture.md](../docs/architecture.md)
and apply unchanged.

## Run it

```bash
python3 -m http.server 10200 -d pwa     # then open http://localhost:10200
```

`localhost` counts as a secure context, so the service worker works there. Anywhere else the
page must be served over **HTTPS**, or the browser refuses to register the service worker (and on
iOS, offline use and Add to Home Screen both depend on it). For an iPhone, put the `pwa/` folder
behind any HTTPS file server, for example Caddy (the certificate must be one the phone trusts):

```caddyfile
mdt.example.com {
    root * /srv/mdt-pwa
    file_server
}
```

Sign in with the SafeSight URL, a username and a password. The URL is remembered for next time.

## Let SafeSight accept the page: CORS

The browser calls SafeSight directly, so SafeSight must allow this page's origin. Add it to
SafeSight's `CORS_ALLOWED_ORIGINS` (django-cors-headers), for example
`CORS_ALLOWED_ORIGINS=https://mdt.example.com`. An origin is scheme + host + port, with no path
and no trailing slash. The default allowed request headers already include `authorization` and
`content-type`, which are the only two the app sends.

If the origin is missing, sign-in shows "Could not reach SafeSight. Check the URL, that the
server is up, and that this app's origin (...) is in SafeSight's CORS_ALLOWED_ORIGINS." A browser
cannot tell a CORS refusal from a server that is down, so the message names both. Mixed content
is another cause: an `https://` page cannot call a plain `http://` SafeSight (except on
localhost).

## Add to Home Screen (iOS)

In Safari, Share, then **Add to Home Screen**. Do this for anything you rely on offline:

- Safari deletes the site data (IndexedDB, caches, localStorage) of a site that has not been used
  in the browser for seven days. A page added to the Home Screen is exempt from that rule.
- It launches full screen without Safari's toolbars.

The app also calls `navigator.storage.persist()` after sign-in and shows the result under the
sidebar, but Safari may decline; Home Screen is the dependable route.

## Storage

Synced files are Blobs in IndexedDB (`manifests` and `blobs` object stores), keyed by the SafeSight
user id, so two people signing in on one device never see each other's files. The sidebar shows
`navigator.storage.estimate()` usage and quota. Quotas depend on the browser and the free space on
the device, and a full device fails a file with "device storage full" (the remaining downloads are
marked failed too, rather than retried). **Delete cached area** frees an area's space. Signing out
keeps the cache on the device; deleting it is explicit. A sync is capped at 100 MB per area
(`maxSyncBytes` in `config.js`).

Map tiles come from OpenStreetMap. The service worker keeps only tiles you have viewed (up to
2000, oldest dropped first) and never prefetches, per the OSM tile usage policy. Areas you have
not browsed online have no base map offline; the area outline and file markers still draw.

## Security notes

- The access and refresh tokens are stored in `localStorage`, so any script on this origin can read
  them. That is accepted for a demo and API-testing tool, and mitigated by the CSP in `index.html`
  (`script-src 'self'`, no inline scripts, no third-party scripts) and by writing every
  server-supplied string to the DOM with `textContent`. Use the Flask app if that is not good
  enough. The password is never stored.
- The bearer token is only ever sent to the SafeSight base URL you entered: pagination `next` links
  are followed by path and query only.
- Inline preview is limited to PNG, JPEG, GIF, WebP, PDF and plain text. **SVG and HTML are never
  rendered**: they get a Save link whose Blob is re-typed as `application/octet-stream`.
- The CSP's `connect-src` allows any `https:` host because the SafeSight URL is typed at runtime.

## Updating the app

The service worker serves the app shell cache-first, so an installed copy keeps running the old
files until the worker changes. When you change anything the page loads, bump `SHELL_VERSION` in
`sw.js` (the cache name becomes `mdt-shell-v2` and so on; old shell caches are deleted on
activate) and keep the `SHELL_FILES` list in step with the files. `tests/shell.test.js` fails if a
file the page needs is missing from that list.

## Layout

| Path | Purpose |
|---|---|
| `index.html`, `app.css`, `manifest.webmanifest`, `icons/` | the page: sign-in view and map view, toggled with `hidden` |
| `config.js` | defaults: base URL, 100 MB sync cap, 30 s request timeout |
| `js/errors.js`, `js/ids.js` | error classes; UUID validation shared by the client and the store |
| `js/geometry.js` | WKT/EWKT parsing and 2D intersection (replaces shapely) |
| `js/client.js` | SafeSight API client (fetch injected): tokens, pagination, AOI files endpoint with scan fallback |
| `js/store.js` | per-user manifests and file Blobs: IndexedDB and in-memory backends |
| `js/sync.js` | `syncArea` |
| `js/auth.js` | token persistence in `localStorage` (`mdt.auth`, `mdt.baseUrl`), sign-in and sign-out |
| `js/main.js` | the UI; the only module that touches `document` |
| `sw.js` | app shell precache, OSM tile cache |
| `vendor/` | Leaflet and Bulma, copied from `mdt/static/vendor/` |
| `tools/make-icons.mjs` | regenerates `icons/` (plain PNGs, no dependencies) |
| `tests/` | unit tests; `e2e/` the browser run |

## Tests

Unit tests use Node 22's built-in runner and no dependencies:

```bash
node --test "pwa/tests/*.test.js"     # or: cd pwa && npm test
```

(Node 22 does not accept a bare directory argument, so the glob is quoted.)

The end-to-end run drives Chromium with the preinstalled Playwright (no `playwright install`).
It starts a mock SafeSight on port 10300 (real fixtures, JWT-shaped tokens, strict CORS preflight)
and serves `pwa/` on port 10200, then signs in, syncs, previews, stops the mock, and reloads
offline. It fails on any console error, page error or CSP violation, and uses an iPhone-sized
viewport (390x844) for the phone layout run:

```bash
node pwa/e2e/e2e.mjs
```

`e2e/staging.mjs` runs the same journey against a real SafeSight (staging by default) before its
CORS settings list this app's origin. The test sends SafeSight requests from Node and adds the
CORS header itself, so everything except CORS is real. Each download is logged in SafeSight's
`FileAccessLog`; set `MDT_STAGING_SYNC=0` to skip the sync. A rejected sign-in stops the run
without retrying, because django-axes locks accounts. The header of the script lists every
variable.

```bash
MDT_STAGING_PASSWORD=... NODE_USE_ENV_PROXY=1 node pwa/e2e/staging.mjs
```

`NODE_USE_ENV_PROXY=1` is needed only behind an HTTPS proxy (Node 22.21 or later).

Only Chromium is tested. Nothing here has been run on a real iPhone: iOS-specific behaviour (the
seven-day eviction, PDF in an iframe showing only the first page, `download` on Blob links, quota
sizes) follows from documented WebKit behaviour and is unverified.

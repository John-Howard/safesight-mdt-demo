// Service worker: makes the app shell available offline and keeps tiles the user has viewed.
//
// It touches exactly two kinds of request:
//   1. same-origin GETs for files in SHELL_FILES (and navigations to the app root): cache-first;
//   2. OpenStreetMap tiles: stale-while-revalidate into `mdt-tiles`, capped at TILE_LIMIT entries.
// Everything else, above all the SafeSight API (a different origin, or the same one), is left
// alone so it always reaches the network.
//
// Tiles are cached only after the user has viewed them. Nothing is ever prefetched (OSM tile
// usage policy). Bump SHELL_VERSION whenever a shell file changes, or installed copies keep
// serving the old one: the shell is cache-first by design.

"use strict";

const SHELL_VERSION = "v1";
const SHELL_CACHE = `mdt-shell-${SHELL_VERSION}`;
const SHELL_PREFIX = "mdt-shell-";
const TILE_CACHE = "mdt-tiles";
const TILE_LIMIT = 2000;
const TILE_HOST = /^(?:[a-z0-9-]+\.)?tile\.openstreetmap\.org$/;

// Every file the page needs, by explicit list (tests/shell.test.js checks it against index.html
// and the module imports). Paths are relative to this file.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.css",
  "./config.js",
  "./manifest.webmanifest",
  "./js/auth.js",
  "./js/client.js",
  "./js/errors.js",
  "./js/geometry.js",
  "./js/ids.js",
  "./js/main.js",
  "./js/store.js",
  "./js/sync.js",
  "./vendor/bulma.min.css",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/images/layers.png",
  "./vendor/images/layers-2x.png",
  "./vendor/images/marker-icon.png",
  "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

const shellPaths = () =>
  new Set(SHELL_FILES.map((file) => new URL(file, self.registration.scope).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // cache: "reload" so a new version never precaches a stale copy from the HTTP cache
        cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: "reload" }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (!shellPaths().has(url.pathname)) return; // not ours: the network handles it
    event.respondWith(shellResponse(request, url));
    return;
  }
  if (url.protocol === "https:" && TILE_HOST.test(url.hostname)) {
    event.respondWith(tileResponse(event));
  }
  // Any other cross-origin request (the SafeSight API) is never intercepted.
});

async function shellResponse(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === "navigate") {
    const index = await cache.match(new URL("./index.html", self.registration.scope).href);
    if (index) return index;
  }
  return fetch(request);
}

async function tileResponse(event) {
  const { request } = event;
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache, TILE_LIMIT);
    }
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => {})); // offline or rate-limited: the stale tile stands
    return cached;
  }
  try {
    return await refresh;
  } catch {
    return Response.error();
  }
}

/** Keep at most `limit` entries, deleting the oldest (Cache.keys() is in insertion order). */
async function trimCache(cache, limit) {
  const keys = await cache.keys();
  const excess = keys.length - limit;
  for (let i = 0; i < excess; i += 1) await cache.delete(keys[i]);
}

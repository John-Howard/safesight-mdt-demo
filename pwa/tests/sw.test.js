// Loads sw.js into a vm sandbox with a fake Cache Storage and fetch, then dispatches fake events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const ORIGIN = "http://localhost:10200";
const SCOPE = `${ORIGIN}/`;

class FakeCache {
  constructor() {
    this.entries = new Map(); // url -> Response, in insertion order
  }
  _key(request) {
    return typeof request === "string" ? new URL(request, SCOPE).href : request.url;
  }
  async put(request, response) {
    const key = this._key(request);
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async match(request, options = {}) {
    const wanted = new URL(this._key(request));
    for (const [key, response] of this.entries) {
      const url = new URL(key);
      const sameSearch = options.ignoreSearch || url.search === wanted.search;
      if (url.origin === wanted.origin && url.pathname === wanted.pathname && sameSearch) return response.clone();
    }
    return undefined;
  }
  async addAll(requests) {
    for (const request of requests) {
      const response = await this.fetchFn(request);
      if (!response.ok) throw new TypeError(`addAll: ${request.url} answered ${response.status}`);
      await this.put(request, response);
    }
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request) {
    return this.entries.delete(this._key(request));
  }
}

function createSandbox({ fetchImpl, installedCaches = {} } = {}) {
  const handlers = {};
  const stores = new Map(Object.entries(installedCaches));
  const fetched = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      const cache = stores.get(name);
      cache.fetchFn = (request) => sandbox.fetch(request);
      return cache;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request, options) {
      for (const cache of stores.values()) {
        const hit = await cache.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { scope: SCOPE },
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const sandbox = {
    self,
    caches,
    // In a real worker a relative URL resolves against the worker's own location.
    Request: class extends Request {
      constructor(input, init) {
        super(typeof input === "string" ? new URL(input, SCOPE).href : input, init);
      }
    },
    Response,
    URL,
    Promise,
    fetch: async (request) => {
      const url = typeof request === "string" ? request : request.url;
      fetched.push(url);
      return fetchImpl ? fetchImpl(request) : new Response(`net:${url}`, { status: 200 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);
  return { handlers, stores, fetched, caches };
}

async function lifecycle(env, type) {
  const waits = [];
  env.handlers[type]({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

async function fetchEvent(env, url, { method = "GET", mode = "cors" } = {}) {
  const event = {
    request: { url, method, mode },
    responded: undefined,
    waits: [],
    respondWith(p) {
      this.responded = Promise.resolve(p);
    },
    waitUntil(p) {
      this.waits.push(p);
    },
  };
  env.handlers.fetch(event);
  const response = event.responded ? await event.responded : undefined;
  await Promise.all(event.waits);
  return { handled: Boolean(event.responded), response, event };
}

const shellFiles = () => {
  const block = /const SHELL_FILES = \[([\s\S]*?)\];/.exec(SW_SOURCE)[1];
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

async function installed(options) {
  const env = createSandbox(options);
  await lifecycle(env, "install");
  return env;
}

test("install precaches every shell file in mdt-shell-v1", async () => {
  const env = await installed();
  const cache = env.stores.get("mdt-shell-v1");
  assert.ok(cache, "shell cache created");
  const files = shellFiles();
  assert.ok(files.length > 10);
  assert.equal(cache.entries.size, files.length);
  for (const file of files) {
    assert.ok(await cache.match(new URL(file, SCOPE).href), `${file} cached`);
  }
});

test("activate deletes old shell caches but keeps the current shell and tile caches", async () => {
  const env = createSandbox({
    installedCaches: {
      "mdt-shell-v0": new FakeCache(),
      "mdt-shell-v1": new FakeCache(),
      "mdt-tiles": new FakeCache(),
      "someone-elses": new FakeCache(),
    },
  });
  await lifecycle(env, "activate");
  assert.deepEqual([...env.stores.keys()].sort(), ["mdt-shell-v1", "mdt-tiles", "someone-elses"]);
});

test("shell requests are served cache-first without touching the network", async () => {
  const env = await installed();
  env.fetched.length = 0;
  const { handled, response } = await fetchEvent(env, `${ORIGIN}/js/main.js`);
  assert.equal(handled, true);
  assert.match(await response.text(), /^net:/); // the body the install-time fetch stored
  assert.deepEqual(env.fetched, []);
});

test("a shell request that is not cached falls back to the network", async () => {
  const env = createSandbox();
  const { handled, response } = await fetchEvent(env, `${ORIGIN}/app.css`);
  assert.equal(handled, true);
  assert.equal(await response.text(), `net:${ORIGIN}/app.css`);
});

test("navigation to the app root or index.html is served from the cache, query ignored", async () => {
  const env = await installed();
  env.fetched.length = 0;
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/index.html`, `${ORIGIN}/?utm=1`, `${ORIGIN}/index.html?x=y`]) {
    const { handled, response } = await fetchEvent(env, url, { mode: "navigate" });
    assert.equal(handled, true, url);
    assert.equal(response.status, 200, url);
  }
  assert.deepEqual(env.fetched, []);
});

test("same-origin requests outside the shell are not intercepted (a same-origin SafeSight still works)", async () => {
  const env = await installed();
  for (const url of [`${ORIGIN}/api/v1/files/`, `${ORIGIN}/admin/`, `${ORIGIN}/api/token/`]) {
    assert.equal((await fetchEvent(env, url)).handled, false, url);
    assert.equal((await fetchEvent(env, url, { mode: "navigate" })).handled, false, url);
  }
});

test("non-GET requests are never intercepted", async () => {
  const env = await installed();
  assert.equal((await fetchEvent(env, `${ORIGIN}/index.html`, { method: "POST" })).handled, false);
  assert.equal((await fetchEvent(env, "https://a.tile.openstreetmap.org/1/1/1.png", { method: "POST" })).handled, false);
});

test("cross-origin requests to anything but OSM tiles are never intercepted", async () => {
  const env = await installed();
  const urls = [
    "https://safesight.example.com/api/v1/files/",
    "https://safesight.example.com/api/token/",
    "http://localhost:10300/api/v1/areas-of-interest/geojson/",
    "https://evil.example.com/tile.openstreetmap.org/1/1/1.png",
    "https://tile.openstreetmap.org.evil.example.com/1/1/1.png",
    "https://nottile.openstreetmap.org/1/1/1.png",
    "http://tile.openstreetmap.org/1/1/1.png",
  ];
  for (const url of urls) assert.equal((await fetchEvent(env, url)).handled, false, url);
});

test("tiles: first view goes to the network and is cached; the second is served from the cache", async () => {
  let version = 0;
  const env = await installed({
    fetchImpl: (r) => new Response(r.url.includes("tile.openstreetmap.org") ? `tile-v${(version += 1)}` : "shell", { status: 200 }),
  });
  const url = "https://a.tile.openstreetmap.org/12/2030/1360.png";

  const first = await fetchEvent(env, url);
  assert.equal(first.handled, true);
  assert.equal(await first.response.text(), "tile-v1");
  const cache = env.stores.get("mdt-tiles");
  assert.equal(cache.entries.size, 1);

  const second = await fetchEvent(env, url);
  assert.equal(await second.response.text(), "tile-v1"); // stale copy returned...
  assert.equal(await (await cache.match(url)).text(), "tile-v2"); // ...and refreshed behind it
});

test("tiles: the bare host and every subdomain are handled", async () => {
  const env = await installed();
  for (const host of ["tile.openstreetmap.org", "a.tile.openstreetmap.org", "b.tile.openstreetmap.org", "c.tile.openstreetmap.org"]) {
    assert.equal((await fetchEvent(env, `https://${host}/1/0/0.png`)).handled, true, host);
  }
});

test("tiles: offline with a cached tile serves it, offline without one is a network error", async () => {
  let online = true;
  const env = await installed({
    fetchImpl: () => {
      if (!online) throw new TypeError("offline");
      return new Response("png", { status: 200 });
    },
  });
  const seen = "https://a.tile.openstreetmap.org/12/1/1.png";
  await fetchEvent(env, seen);
  online = false;
  assert.equal(await (await fetchEvent(env, seen)).response.text(), "png");
  const unseen = await fetchEvent(env, "https://a.tile.openstreetmap.org/12/9/9.png");
  assert.equal(unseen.response.type, "error");
});

test("tiles: failed responses are not cached", async () => {
  const env = await installed({
    fetchImpl: (r) => new Response("body", { status: r.url.includes("tile.openstreetmap.org") ? 429 : 200 }),
  });
  const { response } = await fetchEvent(env, "https://a.tile.openstreetmap.org/1/1/1.png");
  assert.equal(response.status, 429);
  assert.equal(env.stores.get("mdt-tiles").entries.size, 0);
});

test("tiles: the cache is capped at 2000 entries and the oldest go first", async () => {
  const env = await installed();
  const cache = await env.caches.open("mdt-tiles");
  for (let i = 0; i < 2000; i += 1) await cache.put(`https://a.tile.openstreetmap.org/15/${i}/0.png`, new Response("t"));
  assert.equal(cache.entries.size, 2000);

  await fetchEvent(env, "https://a.tile.openstreetmap.org/15/9999/0.png");
  await fetchEvent(env, "https://a.tile.openstreetmap.org/15/9998/0.png");

  assert.equal(cache.entries.size, 2000);
  const urls = [...cache.entries.keys()];
  assert.ok(!urls.includes("https://a.tile.openstreetmap.org/15/0/0.png"));
  assert.ok(!urls.includes("https://a.tile.openstreetmap.org/15/1/0.png"));
  assert.ok(urls.includes("https://a.tile.openstreetmap.org/15/2/0.png"));
  assert.ok(urls.includes("https://a.tile.openstreetmap.org/15/9999/0.png"));
});

test("tiles are only fetched when requested: install never touches the tile servers", async () => {
  const env = await installed();
  assert.ok(env.fetched.every((u) => u.startsWith(ORIGIN)), env.fetched.join("\n"));
  assert.ok(!env.stores.has("mdt-tiles") || env.stores.get("mdt-tiles").entries.size === 0);
});

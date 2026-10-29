// A small fake `fetch` for the tests: routes by method + URL, records every call.
//
//   const fake = createFakeFetch();
//   fake.on("GET", url, reply({ ok: true }), reply({}, 500));  // answered in order, last one sticks
//   fake.on("GET", url, new TypeError("down"));                // rejects like a network failure
//   fake.on("GET", url, HANG);                                 // never answers; honours abort
//
// A route registered without a query string also matches that URL with any query string.
// Registering the same method + URL again replaces the earlier route (like `responses.replace`).

export const HANG = Symbol("hang");

/** Describe a JSON reply. */
export function reply(body, status = 200, headers = {}) {
  return { status, json: body, headers };
}

/** Describe a raw-body reply (bytes or text) with a content type. */
export function raw(body, contentType, status = 200) {
  return { status, body, headers: { "content-type": contentType } };
}

function toResponse(spec) {
  const headers = new Headers(spec.headers || {});
  if (spec.json !== undefined) {
    headers.set("content-type", headers.get("content-type") || "application/json");
    return new Response(JSON.stringify(spec.json), { status: spec.status ?? 200, headers });
  }
  const bodyless = spec.body === undefined || spec.status === 204;
  return new Response(bodyless ? null : spec.body, { status: spec.status ?? 200, headers });
}

function abortable(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createFakeFetch() {
  const routes = new Map(); // "METHOD url" -> { responders, next }
  const calls = [];
  const unmatched = [];

  function find(method, url) {
    const exact = routes.get(`${method} ${url}`);
    if (exact) return exact;
    const bare = routes.get(`${method} ${url.split("?")[0]}`);
    return bare && !bare.key.includes("?") ? bare : undefined;
  }

  async function fakeFetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const call = {
      method,
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers || {})),
      body: init.body,
      json: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(call);
    const route = find(method, call.url);
    if (!route) {
      unmatched.push(call);
      throw new TypeError(`fake fetch: no route for ${method} ${call.url}`);
    }
    const responder = route.responders[Math.min(route.next, route.responders.length - 1)];
    route.next += 1;
    const resolved = typeof responder === "function" ? responder(call) : responder;
    if (resolved === HANG) return abortable(init.signal);
    if (resolved instanceof Error) throw resolved;
    return toResponse(resolved);
  }

  fakeFetch.on = (method, url, ...responders) => {
    const key = `${method.toUpperCase()} ${url}`;
    routes.set(key, { key: url, responders, next: 0 });
  };
  fakeFetch.calls = calls;
  fakeFetch.unmatched = unmatched;
  fakeFetch.urls = () => calls.map((c) => c.url);
  fakeFetch.count = (needle) => calls.filter((c) => c.url.includes(needle)).length;
  return fakeFetch;
}

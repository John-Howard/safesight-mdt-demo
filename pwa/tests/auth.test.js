import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_KEY,
  BASE_URL_KEY,
  loadAuth,
  normalizeBaseUrl,
  rememberedBaseUrl,
  saveTokens,
  signIn,
  signOut,
} from "../js/auth.js";
import { AuthError, InvalidTokenError, SafeSightError, ServerUnavailable } from "../js/errors.js";
import { createFakeFetch, reply } from "./helpers/fake-fetch.js";
import { BASE, USER_A, makeJwt } from "./helpers/fixtures.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    data,
  };
}

const throwingStorage = {
  getItem() {
    throw new DOMException("denied", "SecurityError");
  },
  setItem() {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem() {
    throw new DOMException("denied", "SecurityError");
  },
};

function loginFake(access = makeJwt(USER_A)) {
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, reply({ access, refresh: "R1" }));
  return fake;
}

test("normalizeBaseUrl trims, strips trailing slashes, and keeps a path prefix", () => {
  assert.equal(normalizeBaseUrl("  https://ss.example.com/  "), "https://ss.example.com");
  assert.equal(normalizeBaseUrl("http://localhost:10000///"), "http://localhost:10000");
  assert.equal(normalizeBaseUrl("https://ss.example.com/safesight/"), "https://ss.example.com/safesight");
});

test("normalizeBaseUrl drops credentials, query and fragment from the URL", () => {
  assert.equal(normalizeBaseUrl("https://user:pw@ss.example.com/?a=1#x"), "https://ss.example.com");
});

test("normalizeBaseUrl rejects anything that is not a full http(s) URL", () => {
  for (const bad of ["", "   ", "ss.example.com", "/api", "ftp://x.example.com", "javascript:alert(1)", "http://", null, undefined]) {
    assert.throws(() => normalizeBaseUrl(bad), SafeSightError, String(bad));
  }
});

test("signIn gets tokens, reads the user id, persists auth and remembers the base URL", async () => {
  const storage = memoryStorage();
  const fake = loginFake(makeJwt(USER_A.toUpperCase()));
  const auth = await signIn({ baseUrl: `${BASE}/`, username: "bob", password: "pw", fetch: fake, storage });

  assert.equal(auth.baseUrl, BASE);
  assert.equal(auth.username, "bob");
  assert.equal(auth.userId, USER_A);
  assert.equal(auth.tokens.refresh, "R1");
  assert.deepEqual(fake.calls[0].json, { username: "bob", password: "pw" });

  assert.deepEqual(loadAuth({ storage }), auth);
  assert.equal(storage.getItem(BASE_URL_KEY), BASE);
  assert.equal(rememberedBaseUrl({ storage }), BASE);
});

test("the password is never persisted", async () => {
  const storage = memoryStorage();
  await signIn({ baseUrl: BASE, username: "bob", password: "hunter2-secret", fetch: loginFake(), storage });
  for (const value of storage.data.values()) assert.ok(!value.includes("hunter2-secret"));
});

test("a failed sign-in stores nothing", async () => {
  const storage = memoryStorage();
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, reply({ detail: "no" }, 401));
  await assert.rejects(signIn({ baseUrl: BASE, username: "bob", password: "x", fetch: fake, storage }), AuthError);
  assert.equal(storage.data.size, 0);
});

test("an unreachable server surfaces ServerUnavailable carrying the original TypeError", async () => {
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, new TypeError("Failed to fetch"));
  await assert.rejects(signIn({ baseUrl: BASE, username: "bob", password: "x", fetch: fake, storage: memoryStorage() }), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
});

test("a token without a usable user id is refused and nothing is stored", async () => {
  const storage = memoryStorage();
  await assert.rejects(
    signIn({ baseUrl: BASE, username: "bob", password: "x", fetch: loginFake(makeJwt(null)), storage }),
    InvalidTokenError,
  );
  assert.equal(storage.data.size, 0);
});

test("signIn with a malformed URL fails before any request", async () => {
  const fake = loginFake();
  await assert.rejects(signIn({ baseUrl: "nonsense", username: "a", password: "b", fetch: fake, storage: memoryStorage() }), SafeSightError);
  assert.equal(fake.calls.length, 0);
});

test("signOut clears the auth but keeps the remembered base URL", async () => {
  const storage = memoryStorage();
  await signIn({ baseUrl: BASE, username: "bob", password: "pw", fetch: loginFake(), storage });
  signOut({ storage });
  assert.equal(loadAuth({ storage }), null);
  assert.equal(storage.getItem(AUTH_KEY), null);
  assert.equal(rememberedBaseUrl({ storage }), BASE);
});

test("saveTokens updates the stored tokens after a refresh", async () => {
  const storage = memoryStorage();
  await signIn({ baseUrl: BASE, username: "bob", password: "pw", fetch: loginFake(), storage });
  saveTokens({ access: "A2", refresh: "R2" }, { storage });
  const auth = loadAuth({ storage });
  assert.deepEqual(auth.tokens, { access: "A2", refresh: "R2" });
  assert.equal(auth.userId, USER_A);
});

test("saveTokens does nothing when nobody is signed in", () => {
  const storage = memoryStorage();
  saveTokens({ access: "A", refresh: "R" }, { storage });
  assert.equal(storage.data.size, 0);
});

test("loadAuth returns null for missing, corrupt or wrongly shaped data", () => {
  assert.equal(loadAuth({ storage: memoryStorage() }), null);
  const bad = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ baseUrl: BASE }),
    JSON.stringify({ baseUrl: BASE, username: "b", userId: "nope", tokens: { access: "a", refresh: "r" } }),
    JSON.stringify({ baseUrl: BASE, username: "b", userId: USER_A, tokens: { access: "a" } }),
    JSON.stringify({ baseUrl: "javascript:1", username: "b", userId: USER_A, tokens: { access: "a", refresh: "r" } }),
  ];
  for (const value of bad) {
    assert.equal(loadAuth({ storage: memoryStorage({ [AUTH_KEY]: value }) }), null, value);
  }
});

test("storage that throws never breaks anything", async () => {
  assert.equal(loadAuth({ storage: throwingStorage }), null);
  assert.equal(rememberedBaseUrl({ storage: throwingStorage }), "");
  signOut({ storage: throwingStorage });
  saveTokens({ access: "a", refresh: "r" }, { storage: throwingStorage });
  const auth = await signIn({ baseUrl: BASE, username: "bob", password: "pw", fetch: loginFake(), storage: throwingStorage });
  assert.equal(auth.userId, USER_A); // sign-in still works for this page load
});

test("no storage at all (null) is tolerated", async () => {
  assert.equal(loadAuth({ storage: null }), null);
  assert.equal(rememberedBaseUrl({ storage: null }), "");
});

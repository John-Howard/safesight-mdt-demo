import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as client from "../js/client.js";
import {
  AuthError,
  InvalidTokenError,
  NotFound,
  PermissionDenied,
  RateLimited,
  SafeSightError,
  ServerUnavailable,
} from "../js/errors.js";
import { createFakeFetch, HANG, raw, reply } from "./helpers/fake-fetch.js";
import {
  AOI,
  AREAS_URL,
  BASE,
  FILE_A,
  FILE_B,
  FILE_C,
  USER_A,
  aoiFilesUrl,
  fileItem,
  loadFixture,
  makeJwt,
  mockListing,
  COVERAGE,
  AREA_GEOMETRY,
} from "./helpers/fixtures.js";

beforeEach(() => client.resetAoiFilesCache());

function setup(extra = {}) {
  const fake = createFakeFetch();
  const rotated = [];
  const session = client.createSession({
    baseUrl: BASE,
    tokens: { access: "acc0", refresh: "ref0" },
    fetch: fake,
    timeoutMs: 1000,
    onTokens: (t) => rotated.push({ ...t }),
    ...extra,
  });
  return { fake, session, rotated };
}

const detailUrl = (id) => `${BASE}/api/v1/files/${id}/`;
const refreshCalls = (fake) => fake.calls.filter((c) => c.url.endsWith("/api/token/refresh/"));

// ---- sessions and tokens ------------------------------------------------------------

test("createSession strips trailing slashes from the base URL", () => {
  const { session } = setup({ baseUrl: `${BASE}//` });
  assert.equal(session.baseUrl, BASE);
});

test("obtainTokens posts the credentials as JSON", async () => {
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, reply({ access: "A", refresh: "R" }));
  const tokens = await client.obtainTokens(BASE, "bob", "pw", { fetch: fake });
  assert.deepEqual(tokens, { access: "A", refresh: "R" });
  assert.deepEqual(fake.calls[0].json, { username: "bob", password: "pw" });
  assert.match(fake.calls[0].headers["content-type"], /application\/json/);
  assert.equal(fake.calls[0].headers.authorization, undefined);
});

for (const status of [400, 401]) {
  test(`obtainTokens maps ${status} to AuthError with a fixed message`, async () => {
    const fake = createFakeFetch();
    fake.on("POST", `${BASE}/api/token/`, reply({ detail: "No active account" }, status));
    await assert.rejects(
      client.obtainTokens(BASE, "bob", "bad", { fetch: fake }),
      (err) => err instanceof AuthError && err.message === "Invalid username or password",
    );
  });
}

test("obtainTokens: an unreachable server is ServerUnavailable with no status, keeping the cause", async () => {
  const fake = createFakeFetch();
  const down = new TypeError("Failed to fetch");
  fake.on("POST", `${BASE}/api/token/`, down);
  await assert.rejects(client.obtainTokens(BASE, "bob", "pw", { fetch: fake }), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.equal(err.status, null);
    assert.equal(err.cause, down);
    return true;
  });
});

test("obtainTokens: a 500 is ServerUnavailable carrying the status", async () => {
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, reply({}, 503));
  await assert.rejects(
    client.obtainTokens(BASE, "bob", "pw", { fetch: fake }),
    (err) => err instanceof ServerUnavailable && err.status === 503,
  );
});

test("obtainTokens: a malformed token response is a SafeSightError", async () => {
  const fake = createFakeFetch();
  fake.on("POST", `${BASE}/api/token/`, reply({ nope: 1 }));
  await assert.rejects(client.obtainTokens(BASE, "bob", "pw", { fetch: fake }), SafeSightError);
});

test("the bearer header is sent", async () => {
  const { fake, session } = setup();
  fake.on("GET", AREAS_URL, reply({ type: "FeatureCollection" }));
  assert.equal((await client.getAreasGeoJSON(session)).type, "FeatureCollection");
  assert.equal(fake.calls[0].headers.authorization, "Bearer acc0");
});

test("401 refreshes once, stores and announces both rotated tokens, and retries", async () => {
  const { fake, session, rotated } = setup();
  fake.on("GET", detailUrl(FILE_A), reply({}, 401), reply({ id: FILE_A }));
  fake.on("POST", `${BASE}/api/token/refresh/`, reply({ access: "acc1", refresh: "ref1" }));

  assert.deepEqual(await client.getFileDetail(session, FILE_A), { id: FILE_A });

  assert.deepEqual(session.tokens, { access: "acc1", refresh: "ref1" });
  assert.deepEqual(rotated, [{ access: "acc1", refresh: "ref1" }]);
  assert.equal(refreshCalls(fake).length, 1);
  assert.deepEqual(refreshCalls(fake)[0].json, { refresh: "ref0" });
  assert.equal(fake.calls.at(-1).headers.authorization, "Bearer acc1");
});

for (const status of [400, 401]) {
  test(`a refresh answered with ${status} raises AuthError "Session expired"`, async () => {
    const { fake, session, rotated } = setup();
    fake.on("GET", detailUrl(FILE_A), reply({}, 401));
    fake.on("POST", `${BASE}/api/token/refresh/`, reply({ detail: "blacklisted" }, status));
    await assert.rejects(
      client.getFileDetail(session, FILE_A),
      (err) => err instanceof AuthError && err.message === "Session expired; sign in again",
    );
    assert.deepEqual(rotated, []);
    assert.deepEqual(session.tokens, { access: "acc0", refresh: "ref0" });
  });
}

test("a second 401 after a refresh is an AuthError without a second refresh", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), reply({}, 401));
  fake.on("POST", `${BASE}/api/token/refresh/`, reply({ access: "acc1", refresh: "ref1" }));
  await assert.rejects(client.getFileDetail(session, FILE_A), AuthError);
  assert.equal(refreshCalls(fake).length, 1);
});

test("403 maps to PermissionDenied carrying the server's text", async () => {
  const { fake, session } = setup();
  fake.on("GET", `${BASE}/api/v1/files/${FILE_A}/download/`, reply({ error: "Viewers cannot download files" }, 403));
  await assert.rejects(client.downloadFile(session, FILE_A), (err) => {
    assert.ok(err instanceof PermissionDenied);
    assert.match(err.message, /Viewers cannot download/);
    return true;
  });
});

test("403 uses `detail` when there is no `error`, and HTTP <status> when there is neither", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), reply({ detail: "Nope" }, 403));
  await assert.rejects(client.getFileDetail(session, FILE_A), /Nope/);
  fake.on("GET", detailUrl(FILE_A), raw("<html>", "text/html", 403));
  await assert.rejects(client.getFileDetail(session, FILE_A), /HTTP 403/);
});

for (const [status, Expected] of [
  [404, NotFound],
  [429, RateLimited],
  [500, ServerUnavailable],
  [503, ServerUnavailable],
]) {
  test(`status ${status} maps to ${Expected.name}`, async () => {
    const { fake, session } = setup();
    fake.on("GET", detailUrl(FILE_A), reply({}, status));
    await assert.rejects(client.getFileDetail(session, FILE_A), (err) => {
      assert.ok(err instanceof Expected);
      if (Expected === ServerUnavailable) assert.equal(err.status, status);
      return true;
    });
  });
}

test("other 4xx statuses are a plain SafeSightError", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), reply({ detail: "bad" }, 400));
  await assert.rejects(client.getFileDetail(session, FILE_A), (err) => {
    assert.ok(err instanceof SafeSightError);
    assert.ok(!(err instanceof ServerUnavailable) && !(err instanceof AuthError));
    return true;
  });
});

test("a network failure is ServerUnavailable with status null", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), new TypeError("Failed to fetch"));
  await assert.rejects(client.getFileDetail(session, FILE_A), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.equal(err.status, null);
    return true;
  });
});

test("a timeout aborts the request and is ServerUnavailable with status null", async () => {
  const { fake, session } = setup({ timeoutMs: 20 });
  fake.on("GET", detailUrl(FILE_A), HANG);
  await assert.rejects(client.getFileDetail(session, FILE_A), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.equal(err.status, null);
    return true;
  });
  assert.equal(fake.calls[0].signal.aborted, true);
});

test("invalid JSON where JSON is expected is ServerUnavailable with status null", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), raw("<html>not json</html>", "text/html"));
  await assert.rejects(client.getFileDetail(session, FILE_A), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.equal(err.status, null);
    return true;
  });
});

test("a base URL with a path prefix is kept in every request", async () => {
  const { fake, session } = setup({ baseUrl: `${BASE}/safesight/` });
  fake.on("GET", `${BASE}/safesight/api/v1/files/${FILE_A}/`, reply({ id: FILE_A }));
  assert.deepEqual(await client.getFileDetail(session, FILE_A), { id: FILE_A });
});

// ---- user id from the access token -------------------------------------------------

test("userIdFromAccessToken reads and lower-cases the user_id claim", () => {
  assert.equal(client.userIdFromAccessToken(makeJwt(USER_A.toUpperCase())), USER_A);
});

test("userIdFromAccessToken decodes UTF-8 payloads", () => {
  assert.equal(client.userIdFromAccessToken(makeJwt(USER_A, { name: "Zoë ☃" })), USER_A);
});

test("userIdFromAccessToken rejects bad tokens", () => {
  const bad = [makeJwt(null), makeJwt("nope"), makeJwt(123), "garbage", "a.!!!.c", "a..c", "", null, undefined];
  for (const token of bad) {
    assert.throws(() => client.userIdFromAccessToken(token), InvalidTokenError, String(token));
  }
});

// ---- areas ---------------------------------------------------------------------------

test("getAreaFeature finds an area by id, and raises NotFound otherwise", async () => {
  const { fake, session } = setup();
  fake.on("GET", AREAS_URL, reply(loadFixture("areas_geojson.json")));
  const feat = await client.getAreaFeature(session, "f7374155-7d73-4c47-995e-ae427a2b4262");
  assert.equal(feat.properties.name, "Oxford city centre");
  await assert.rejects(client.getAreaFeature(session, AOI), NotFound);
});

// ---- the scan: real fixtures ---------------------------------------------------------

const aoiGeometry = () => loadFixture("areas_geojson.json").features[0].geometry;

function mockFixtureListing(fake) {
  fake.on("GET", aoiFilesUrl(), reply({}, 500));
  fake.on("GET", `${BASE}/api/v1/files/`, reply(loadFixture("files_list.json")));
  fake.on("GET", `${BASE}/api/v1/files/geojson/`, reply(loadFixture("files_geojson.json")));
  const detail = loadFixture("file_detail_coverage_only.json");
  fake.on("GET", detailUrl(detail.id), reply(detail));
}

test("scan with the real fixtures: six files in, one out", async () => {
  const { fake, session } = setup();
  mockFixtureListing(fake);
  const got = await client.listAreaFiles(session, AOI, aoiGeometry());
  const names = got.map((f) => f.original_filename).sort();
  assert.equal(got.length, 6);
  assert.deepEqual(names, [
    "ambulance-staging-point.png",
    "carfax-scene-photo.png",
    "hydrant-layout.svg",
    "hydrant-notes.txt",
    "river-flood-extent.txt",
    "station-incident-report.pdf",
  ]);
  assert.ok(!names.includes("headington-outside-area.txt"));
});

test("scan: item shape, and the coverage fallback for a file with no point", async () => {
  const { fake, session } = setup();
  mockFixtureListing(fake);
  const byName = Object.fromEntries(
    (await client.listAreaFiles(session, AOI, aoiGeometry())).map((f) => [f.original_filename, f]),
  );
  for (const item of Object.values(byName)) {
    assert.deepEqual(new Set(Object.keys(item)), ITEM_KEYS);
  }
  const point = byName["ambulance-staging-point.png"];
  assert.equal(point.geometry.type, "Point");
  assert.equal(point.can_download, true);
  assert.equal(point.file_size, 2771);
  const coverage = byName["river-flood-extent.txt"];
  assert.equal(coverage.geometry.type, "Polygon");
  assert.equal(coverage.can_download, true); // default when the geojson has no flag
});

const ITEM_KEYS = new Set([
  "id",
  "original_filename",
  "mime_type",
  "file_size",
  "organization_name",
  "group_name",
  "uploaded_at",
  "can_download",
  "geometry",
]);

test("scan: detail is fetched only for files without a point", async () => {
  const { fake, session } = setup();
  mockFixtureListing(fake);
  await client.listAreaFiles(session, AOI, aoiGeometry());
  const details = fake.calls.filter((c) => /\/api\/v1\/files\/[0-9a-f-]{36}\/$/.test(c.url));
  assert.equal(details.length, 1);
  assert.ok(details[0].url.includes("83ff6d17-79d0-46ad-9c5b-167fd6a88ace"));
});

test("scan: requests are safe (no format, no spatial_search, published, page_size)", async () => {
  const { fake, session } = setup();
  mockFixtureListing(fake);
  await client.listAreaFiles(session, AOI, aoiGeometry());
  for (const url of fake.urls()) {
    assert.ok(!url.includes("format"), url);
    assert.ok(!url.includes("spatial_search"), url);
  }
  const first = fake.calls[1].url; // calls[0] is the 500 AOI probe
  assert.ok(first.includes("is_published=true"));
  assert.ok(first.includes("page_size=200"));
});

test("scan: can_download false is carried through", async () => {
  const { fake, session } = setup();
  mockListing(fake, fileItem(FILE_A, { canDownload: false }));
  const [item] = await client.listAreaFiles(session, AOI, AREA_GEOMETRY);
  assert.equal(item.can_download, false);
});

test("scan: a coverage-less file with no point is dropped", async () => {
  const { fake, session } = setup();
  mockListing(
    fake,
    fileItem(FILE_A, { point: null, coverage: null }),
    fileItem(FILE_B, { point: null, coverage: COVERAGE }),
  );
  const ids = (await client.listAreaFiles(session, AOI, AREA_GEOMETRY)).map((f) => f.id);
  assert.deepEqual(ids, [FILE_B]);
});

test("scan: both walks follow next links", async () => {
  const { fake, session } = setup();
  fake.on("GET", aoiFilesUrl(), reply({}, 500));
  const list = `${BASE}/api/v1/files/`;
  const geo = `${BASE}/api/v1/files/geojson/`;
  const row = (id) => ({
    id, original_filename: id, mime_type: "text/plain", file_size: 1,
    organization_name: "O", group_name: null, uploaded_at: "t", has_location: true,
  });
  const feat = (id) => ({
    type: "Feature", id, geometry: { type: "Point", coordinates: [-1.25, 51.75] },
    properties: { id, can_download: true },
  });
  const fc = (...features) => ({ type: "FeatureCollection", features });
  fake.on("GET", list, reply({ next: `${list}?page=2&page_size=200`, results: [row("1")] }));
  fake.on("GET", `${list}?page=2&page_size=200`, reply({ next: null, results: [row("2")] }));
  fake.on("GET", geo, reply({ next: `${geo}?page=2&page_size=200`, results: fc(feat("1")) }));
  fake.on("GET", `${geo}?page=2&page_size=200`, reply({ next: null, results: fc(feat("2")) }));
  const got = (await client.listAreaFiles(session, AOI, AREA_GEOMETRY)).map((f) => f.id);
  assert.deepEqual(got, ["1", "2"]);
});

test("a next link on a foreign host: only its path is followed, on our own host", async () => {
  const { fake, session } = setup();
  fake.on("GET", aoiFilesUrl(), reply({}, 500));
  fake.on("GET", `${BASE}/api/v1/files/`, reply({ next: "http://evil.test/steal/?page=2", results: [] }));
  fake.on("GET", `${BASE}/steal/?page=2`, reply({ next: null, results: [] }));
  fake.on("GET", `${BASE}/api/v1/files/geojson/`, reply({ next: null, results: { features: [] } }));
  await client.listAreaFiles(session, AOI, AREA_GEOMETRY);
  assert.ok(fake.urls().every((u) => u.startsWith(BASE)), fake.urls().join("\n"));
  assert.ok(fake.urls().includes(`${BASE}/steal/?page=2`));
  assert.ok(fake.calls.every((c) => !c.url.includes("evil.test")));
});

test("the bearer token is never sent to another host", async () => {
  const { fake, session } = setup();
  fake.on("GET", aoiFilesUrl(), reply({}, 500));
  fake.on("GET", `${BASE}/api/v1/files/`, reply({ next: "https://evil.test/api/v1/files/?page=2", results: [] }));
  fake.on("GET", `${BASE}/api/v1/files/?page=2`, reply({ next: null, results: [] }));
  fake.on("GET", `${BASE}/api/v1/files/geojson/`, reply({ next: null, results: { features: [] } }));
  await client.listAreaFiles(session, AOI, AREA_GEOMETRY);
  for (const call of fake.calls) assert.ok(call.url.startsWith(`${BASE}/`), call.url);
});

test("next links on a base URL with a path prefix do not double the prefix", async () => {
  const { fake, session } = setup({ baseUrl: `${BASE}/safesight` });
  const endpoint = `${BASE}/safesight/api/v1/areas-of-interest/${AOI}/files/`;
  fake.on("GET", endpoint, reply(page([result(FILE_A, { location: point(), can_download: true })], `${endpoint}?page=2&page_size=200`)));
  fake.on("GET", `${endpoint}?page=2&page_size=200`, reply(page([result(FILE_B, { location: point(), can_download: true })])));
  const got = await client.listAreaFiles(session, AOI, AREA_GEOMETRY);
  assert.deepEqual(got.map((f) => f.id), [FILE_A, FILE_B]);
});

// ---- downloads -----------------------------------------------------------------------

test("downloadFile returns the blob and a bare lower-case media type", async () => {
  const { fake, session } = setup();
  fake.on("GET", `${BASE}/api/v1/files/${FILE_A}/download/`, raw("PNGDATA", "Image/PNG; charset=binary"));
  const { blob, contentType } = await client.downloadFile(session, FILE_A);
  assert.equal(contentType, "image/png");
  assert.equal(await blob.text(), "PNGDATA");
  assert.ok(!fake.calls[0].url.includes("format"));
});

test("downloadFile with no Content-Type gives an empty media type", async () => {
  const { fake, session } = setup();
  fake.on("GET", `${BASE}/api/v1/files/${FILE_A}/download/`, { status: 200, body: new Uint8Array([1, 2, 3]) });
  const { blob, contentType } = await client.downloadFile(session, FILE_A);
  assert.equal(blob.size, 3);
  assert.equal(contentType, "");
});

test("downloadFile refreshes on 401 and keeps the rotated tokens", async () => {
  const { fake, session, rotated } = setup();
  const url = `${BASE}/api/v1/files/${FILE_A}/download/`;
  fake.on("GET", url, reply({}, 401), raw("ok", "text/plain"));
  fake.on("POST", `${BASE}/api/token/refresh/`, reply({ access: "n", refresh: "m" }));
  assert.equal((await client.downloadFile(session, FILE_A)).contentType, "text/plain");
  assert.deepEqual(session.tokens, { access: "n", refresh: "m" });
  assert.equal(rotated.length, 1);
});

test("downloadFile: a 403 raises PermissionDenied", async () => {
  const { fake, session } = setup();
  fake.on("GET", `${BASE}/api/v1/files/${FILE_A}/download/`, reply({ error: "no" }, 403));
  await assert.rejects(client.downloadFile(session, FILE_A), PermissionDenied);
});

test("downloadFile: a body that fails mid-stream is ServerUnavailable with status null", async () => {
  const { fake, session } = setup();
  fake.on("GET", `${BASE}/api/v1/files/${FILE_A}/download/`, () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("network error"));
      },
    });
    return { status: 200, body, headers: { "content-type": "image/png" } };
  });
  await assert.rejects(client.downloadFile(session, FILE_A), (err) => {
    assert.ok(err instanceof ServerUnavailable);
    assert.equal(err.status, null);
    return true;
  });
});

// ---- the AOI files endpoint (port of tests/test_aoi_files_endpoint.py) ----------------

const ENDPOINT = aoiFilesUrl();
const POINT_WKT = "SRID=4326;POINT(-1.25 51.75)";
const COVERAGE_WKT = "SRID=4326;POLYGON((-1.26 51.74, -1.25 51.74, -1.25 51.75, -1.26 51.75, -1.26 51.74))";

function result(id, { location = null, coverage = null, can_download } = {}) {
  const row = {
    id,
    original_filename: `${id.slice(0, 4)}.png`,
    description: "",
    file_size: 5,
    mime_type: "image/png",
    location,
    location_status: "ok",
    coverage_area: coverage,
    organization: "99999999-9999-4999-8999-999999999999",
    organization_name: "Org",
    group: null,
    group_name: null,
    uploaded_by: "u",
    uploaded_by_username: "bob",
    uploaded_at: "2026-01-01T00:00:00Z",
    is_published: true,
    distance: null,
  };
  if (can_download !== undefined) row.can_download = can_download;
  return row;
}

const page = (rows, next = null) => ({ count: rows.length, next, previous: null, results: rows });
const point = (lon = -1.25, lat = 51.75) => ({ type: "Point", coordinates: [lon, lat] });
const run = (session) => client.listAreaFiles(session, AOI, AREA_GEOMETRY);
const probes = (fake) => fake.urls().filter((u) => u === `${ENDPOINT}?page_size=200`).length;

test("endpoint: a supported server costs one request and no detail or geojson calls", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })])));
  const [item] = await run(session);
  assert.deepEqual(new Set(Object.keys(item)), ITEM_KEYS);
  assert.equal(item.id, FILE_A);
  assert.equal(item.can_download, true);
  assert.deepEqual(item.geometry, point());
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.urls()[0].includes("page_size=200"));
  assert.ok(!fake.urls()[0].includes("/api/v1/files/"));
});

test("endpoint: can_download false is carried through", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: false })])));
  assert.equal((await run(session))[0].can_download, false);
});

test("endpoint: two pages, one request each", async () => {
  const { fake, session } = setup();
  const second = `${ENDPOINT}?page=2&page_size=200`;
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })], second)));
  fake.on("GET", second, reply(page([result(FILE_B, { location: point(), can_download: true })])));
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A, FILE_B]);
  assert.equal(fake.calls.length, 2);
});

test("endpoint: a next link on a foreign host is not followed", async () => {
  const { fake, session } = setup();
  fake.on(
    "GET",
    ENDPOINT,
    reply(page([result(FILE_A, { location: point(), can_download: true })], "http://evil.test/steal/?page=2")),
  );
  fake.on("GET", `${BASE}/steal/?page=2`, reply(page([])));
  await run(session);
  assert.ok(fake.urls().every((u) => u.startsWith(BASE)));
});

test("endpoint: never sends a format parameter", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })])));
  await run(session);
  assert.ok(fake.urls().every((u) => !u.includes("format")));
});

test("endpoint: EWKT and GeoJSON geometry are both normalised", async () => {
  const { fake, session } = setup();
  fake.on(
    "GET",
    ENDPOINT,
    reply(page([
      result(FILE_A, { location: POINT_WKT, can_download: true }),
      result(FILE_B, { location: point(), can_download: true }),
    ])),
  );
  const byId = Object.fromEntries((await run(session)).map((f) => [f.id, f]));
  assert.equal(byId[FILE_A].geometry.type, "Point");
  assert.deepEqual(byId[FILE_A].geometry.coordinates, [-1.25, 51.75]);
  assert.deepEqual(byId[FILE_B].geometry, point());
});

for (const [label, coverage] of [["GeoJSON", COVERAGE], ["WKT", COVERAGE_WKT]]) {
  test(`endpoint: a coverage-only result (${label}) yields its polygon`, async () => {
    const { fake, session } = setup();
    fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { coverage, can_download: true })])));
    const [item] = await run(session);
    assert.equal(item.geometry.type, "Polygon");
    assert.deepEqual(item.geometry.coordinates[0][0], [-1.26, 51.74]);
  });
}

test("endpoint: the point wins over the coverage polygon", async () => {
  const { fake, session } = setup();
  fake.on(
    "GET",
    ENDPOINT,
    reply(page([result(FILE_A, { location: POINT_WKT, coverage: COVERAGE, can_download: true })])),
  );
  assert.equal((await run(session))[0].geometry.type, "Point");
});

test("endpoint: a result with no geometry is yielded with null geometry", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { can_download: true })])));
  assert.equal((await run(session))[0].geometry, null);
});

function mockScanOfTwoFiles(fake) {
  mockListing(
    fake,
    fileItem(FILE_A, { canDownload: false }),
    fileItem(FILE_B, { point: null, coverage: COVERAGE }),
  );
}

test("endpoint: results without can_download fall back to the scan", async () => {
  const { fake, session } = setup();
  mockScanOfTwoFiles(fake);
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point() }), result(FILE_B, { coverage: COVERAGE })])));
  const got = Object.fromEntries((await run(session)).map((f) => [f.id, f]));
  assert.deepEqual(new Set(Object.keys(got)), new Set([FILE_A, FILE_B]));
  assert.equal(got[FILE_A].can_download, false); // only the scan knows this
  assert.ok(fake.urls().some((u) => u.includes("/api/v1/files/geojson/")));
});

test("endpoint: one result missing can_download is enough to fall back", async () => {
  const { fake, session } = setup();
  mockScanOfTwoFiles(fake);
  fake.on(
    "GET",
    ENDPOINT,
    reply(page([result(FILE_A, { location: point(), can_download: true }), result(FILE_B, { coverage: COVERAGE })])),
  );
  const got = Object.fromEntries((await run(session)).map((f) => [f.id, f]));
  assert.equal(got[FILE_A].can_download, false);
});

test("endpoint: the fallback set matches the scan set", async () => {
  const { fake, session } = setup();
  mockScanOfTwoFiles(fake);
  const scanIds = new Set((await run(session)).map((f) => f.id)); // the endpoint answers 500 here
  client.resetAoiFilesCache();
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point() })])));
  assert.deepEqual(new Set((await run(session)).map((f) => f.id)), scanIds);
});

for (const status of [500, 502, 404]) {
  test(`old server (${status}): falls back, and the second call does not re-probe`, async () => {
    const { fake, session } = setup();
    mockListing(fake, fileItem(FILE_A));
    fake.on("GET", ENDPOINT, reply({}, status));
    assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
    assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
    assert.equal(probes(fake), 1);
  });
}

test("the unsupported verdict is remembered per base URL", async () => {
  const { fake, session } = setup();
  mockListing(fake, fileItem(FILE_A));
  await run(session);
  const other = client.createSession({ baseUrl: "http://other.test", tokens: { access: "a", refresh: "r" }, fetch: fake });
  fake.on("GET", `http://other.test/api/v1/areas-of-interest/${AOI}/files/`, reply({}, 500));
  fake.on("GET", "http://other.test/api/v1/files/", reply(page([])));
  fake.on("GET", "http://other.test/api/v1/files/geojson/", reply({ next: null, results: { features: [] } }));
  await client.listAreaFiles(other, AOI, AREA_GEOMETRY);
  assert.ok(fake.urls().some((u) => u.startsWith("http://other.test/api/v1/areas-of-interest/")));
});

test("a network failure propagates without the scan and without being remembered", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, new TypeError("down"));
  await assert.rejects(run(session), (err) => err instanceof ServerUnavailable && err.status === null);
  assert.deepEqual(fake.urls(), [`${ENDPOINT}?page_size=200`]);

  const slow = setup({ timeoutMs: 20 });
  slow.fake.on("GET", ENDPOINT, HANG);
  await assert.rejects(run(slow.session), ServerUnavailable);
  assert.ok(slow.fake.urls().every((u) => u.includes("areas-of-interest")));

  // nothing was cached: once the server answers, the endpoint is tried again
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })])));
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
});

for (const [status, Expected] of [[401, AuthError], [403, PermissionDenied], [429, RateLimited]]) {
  test(`endpoint: ${status} propagates without the scan`, async () => {
    const { fake, session } = setup();
    fake.on("GET", ENDPOINT, reply({}, status));
    if (status === 401) fake.on("POST", `${BASE}/api/token/refresh/`, reply({}, 401));
    await assert.rejects(run(session), Expected);
    assert.ok(fake.urls().every((u) => !u.includes("/api/v1/files/")));
  });
}

test("endpoint: an error on the second page falls back before returning anything", async () => {
  const { fake, session } = setup();
  mockListing(fake, fileItem(FILE_C));
  const second = `${ENDPOINT}?page=2&page_size=200`;
  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })], second)));
  fake.on("GET", second, reply({}, 500));
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_C]);
});

test("endpoint: empty results are supported for this call but not remembered", async () => {
  const { fake, session } = setup();
  fake.on("GET", ENDPOINT, reply(page([])));
  assert.deepEqual(await run(session), []);
  assert.equal(fake.calls.length, 1); // treated as supported: no scan

  fake.on("GET", ENDPOINT, reply(page([result(FILE_A, { location: point(), can_download: true })])));
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
  assert.equal(fake.calls.length, 2); // the empty verdict did not stick
});

test("endpoint: empty results do not clear a remembered unsupported verdict", async () => {
  const { fake, session } = setup();
  mockListing(fake, fileItem(FILE_A));
  await run(session);
  fake.on("GET", ENDPOINT, reply(page([])));
  await run(session);
  assert.equal(probes(fake), 1);
});

test("ServerUnavailable carries a status only for HTTP errors", async () => {
  const { fake, session } = setup();
  fake.on("GET", detailUrl(FILE_A), reply({}, 503));
  await assert.rejects(client.getFileDetail(session, FILE_A), (e) => e.status === 503);
  fake.on("GET", detailUrl(FILE_A), new TypeError("x"));
  await assert.rejects(client.getFileDetail(session, FILE_A), (e) => e.status === null);
});

// ---- the unsupported-server TTL (injected clock) ---------------------------------------

test("TTL: the verdict expires after 900 s, a fixed server is used, and the entry is dropped", async () => {
  let now = 1_000_000;
  const { fake, session } = setup({ now: () => now });
  mockListing(fake, fileItem(FILE_A));
  await run(session); // old server: marked unsupported
  assert.equal(probes(fake), 1);

  now += 899_000;
  await run(session);
  assert.equal(probes(fake), 1); // still remembered

  now += 1_000; // 900 s after marking
  fake.on("GET", ENDPOINT, reply(page([result(FILE_B, { location: point(), can_download: true })])));
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_B]);
  assert.equal(probes(fake), 2); // re-probed

  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_B]);
  assert.equal(probes(fake), 3); // dropped, not re-marked: the endpoint keeps being used
});

test("TTL: an expired verdict on a server that is still old falls back and re-marks", async () => {
  let now = 0;
  const { fake, session } = setup({ now: () => now });
  mockListing(fake, fileItem(FILE_A));
  await run(session);
  now += 900_000;
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
  assert.equal(probes(fake), 2); // re-probed, fell back

  now += 1000;
  assert.deepEqual((await run(session)).map((f) => f.id), [FILE_A]);
  assert.equal(probes(fake), 2); // re-marked: no third probe
});

test("TTL: the default clock is real, so a fresh verdict is remembered", async () => {
  const { fake, session } = setup();
  mockListing(fake, fileItem(FILE_A));
  await run(session);
  await run(session);
  assert.equal(probes(fake), 1);
});

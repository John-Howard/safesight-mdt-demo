import { test } from "node:test";
import assert from "node:assert/strict";

import { createSession } from "../js/client.js";
import { AuthError, InvalidIdError, NotFound } from "../js/errors.js";
import { createMemoryStore } from "../js/store.js";
import { syncArea, SIZE_LIMIT_REASON, STORAGE_FULL_REASON } from "../js/sync.js";
import { createFakeFetch, raw, reply } from "./helpers/fake-fetch.js";
import {
  AOI,
  AREAS_URL,
  BASE,
  COVERAGE,
  FILE_A,
  FILE_B,
  FILE_C,
  USER_A,
  fileItem,
  loadFixture,
  mockArea,
  mockListing,
} from "./helpers/fixtures.js";
import { resetAoiFilesCache } from "../js/client.js";

function setup(overrides = {}) {
  resetAoiFilesCache();
  const fake = createFakeFetch();
  const session = createSession({ baseUrl: BASE, tokens: { access: "a", refresh: "r" }, fetch: fake, timeoutMs: 1000 });
  const store = createMemoryStore();
  const run = (extra = {}) => syncArea({ session, store, userId: USER_A, aoiId: AOI, ...overrides, ...extra });
  return { fake, session, store, run };
}

const downloadUrl = (id) => `${BASE}/api/v1/files/${id}/download/`;
const png = (body = "12345") => raw(body, "image/png");
const downloadCalls = (fake) => fake.calls.filter((c) => c.url.endsWith("/download/"));
const manifestOf = (store) => store.getManifest(USER_A, AOI);

test("downloads everything and stores the area, the entries and the blobs", async () => {
  const { fake, store, run } = setup();
  mockArea(fake, { name: "Z" });
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B, { point: null, coverage: COVERAGE }));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());

  const summary = await run();

  assert.equal(summary.downloaded, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.denied + summary.failed + summary.skipped, 0);
  assert.equal(summary.bytes, 10);
  assert.equal(await (await store.getBlob(USER_A, AOI, FILE_A)).text(), "12345");
  const manifest = await manifestOf(store);
  assert.equal(manifest.area.name, "Z");
  assert.equal(manifest.area.geometry.type, "MultiPolygon");
  assert.equal(manifest.files[FILE_A].status, "downloaded");
  assert.equal(manifest.files[FILE_A].feature.geometry.type, "Point");
  assert.equal(manifest.files[FILE_B].feature.geometry.type, "Polygon");
  assert.ok(manifest.synced_at);
});

test("an unknown area raises NotFound", async () => {
  const { fake, run } = setup();
  fake.on("GET", AREAS_URL, reply(loadFixture("areas_geojson.json")));
  await assert.rejects(run(), NotFound);
});

test("a non-UUID area id is rejected before any request", async () => {
  const { fake, run } = setup();
  await assert.rejects(run({ aoiId: "../x" }), InvalidIdError);
  assert.equal(fake.calls.length, 0);
});

test("can_download false is denied without requesting the file", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A, { canDownload: false }), fileItem(FILE_B));
  fake.on("GET", downloadUrl(FILE_B), png());
  const summary = await run();
  assert.deepEqual([summary.denied, summary.downloaded], [1, 1]);
  assert.deepEqual(downloadCalls(fake).map((c) => c.url.includes(FILE_A)), [false]);
  const entry = (await manifestOf(store)).files[FILE_A];
  assert.equal(entry.status, "denied");
  assert.ok(entry.reason);
  assert.equal(await store.getBlob(USER_A, AOI, FILE_A), null);
});

test("a 403 is denied with the server's text, and the run continues", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B));
  fake.on("GET", downloadUrl(FILE_A), reply({ error: "viewer" }, 403));
  fake.on("GET", downloadUrl(FILE_B), png());
  const summary = await run();
  assert.deepEqual([summary.denied, summary.downloaded], [1, 1]);
  const manifest = await manifestOf(store);
  assert.equal(manifest.files[FILE_A].status, "denied");
  assert.match(manifest.files[FILE_A].reason, /viewer/);
  assert.equal(manifest.files[FILE_B].status, "downloaded");
});

test("other failures are recorded and the run continues", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B), fileItem(FILE_C));
  fake.on("GET", downloadUrl(FILE_A), reply({}, 500));
  fake.on("GET", downloadUrl(FILE_B), new TypeError("down"));
  fake.on("GET", downloadUrl(FILE_C), png());
  const summary = await run();
  assert.deepEqual([summary.failed, summary.downloaded], [2, 1]);
  const manifest = await manifestOf(store);
  assert.equal(manifest.files[FILE_A].status, "failed");
  assert.ok(manifest.files[FILE_A].reason);
  assert.equal(manifest.files[FILE_B].status, "failed");
});

test("identical size is skipped, a changed size is downloaded again", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A, { size: 5 }), fileItem(FILE_B, { size: 5 }));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  await run();

  fake.calls.length = 0;
  mockListing(fake, fileItem(FILE_A, { size: 5 }), fileItem(FILE_B, { size: 7 }));
  fake.on("GET", downloadUrl(FILE_B), png("1234567"));
  const summary = await run();

  assert.deepEqual([summary.skipped, summary.downloaded], [1, 1]);
  assert.equal(await (await store.getBlob(USER_A, AOI, FILE_B)).text(), "1234567");
  assert.equal(downloadCalls(fake).length, 1);
  assert.equal((await manifestOf(store)).files[FILE_A].status, "downloaded");
});

test("skipping requires the blob to be in the store", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A));
  fake.on("GET", downloadUrl(FILE_A), png());
  await run();
  await store.deleteArea(USER_A, AOI);
  await store.putManifest(USER_A, AOI, {
    aoi_id: AOI,
    area: null,
    files: { [FILE_A]: { id: FILE_A, status: "downloaded", file_size: 5 } },
  });
  assert.equal((await run()).downloaded, 1);
});

test("the size limit stops new downloads and marks the rest failed", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A, { size: 60 }), fileItem(FILE_B, { size: 60 }), fileItem(FILE_C, { size: 10 }));
  fake.on("GET", downloadUrl(FILE_A), png("x".repeat(60)));
  const summary = await run({ maxBytes: 100 });
  assert.deepEqual([summary.downloaded, summary.failed], [1, 2]);
  const manifest = await manifestOf(store);
  assert.equal(manifest.files[FILE_B].reason, SIZE_LIMIT_REASON);
  assert.equal(SIZE_LIMIT_REASON, "sync size limit");
  assert.equal(manifest.files[FILE_C].status, "failed"); // would fit, but the limit was hit
  assert.equal(manifest.files[FILE_C].reason, SIZE_LIMIT_REASON);
  assert.equal(downloadCalls(fake).length, 1);
});

test("files already stored count toward the size limit", async () => {
  const { fake, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A, { size: 60 }));
  fake.on("GET", downloadUrl(FILE_A), png("x".repeat(60)));
  await run();
  fake.calls.length = 0;
  mockListing(fake, fileItem(FILE_A, { size: 60 }), fileItem(FILE_B, { size: 60 }));
  const summary = await run({ maxBytes: 100 });
  assert.deepEqual([summary.skipped, summary.failed], [1, 1]);
});

test("an AuthError aborts the run but the progress so far is saved", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), reply({}, 401));
  fake.on("POST", `${BASE}/api/token/refresh/`, reply({}, 401));
  await assert.rejects(run(), AuthError);
  assert.equal((await manifestOf(store)).files[FILE_A].status, "downloaded");
  assert.equal(await (await store.getBlob(USER_A, AOI, FILE_A)).text(), "12345");
});

test("an interrupted sync keeps the entries it had not reached yet", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  await run();

  // Second run: A is skipped, then B's size changed and its download hits an auth failure.
  fake.calls.length = 0;
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B, { size: 9 }));
  fake.on("GET", downloadUrl(FILE_B), reply({}, 401));
  fake.on("POST", `${BASE}/api/token/refresh/`, reply({}, 401));
  await assert.rejects(run(), AuthError);

  const manifest = await manifestOf(store);
  assert.equal(manifest.files[FILE_A].status, "downloaded");
  assert.equal(manifest.files[FILE_B].status, "downloaded"); // previous entry kept, not dropped
});

test("the manifest is written after every file, so a killed sync keeps what it got", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B), fileItem(FILE_C));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  fake.on("GET", downloadUrl(FILE_C), () => {
    // by the time C is requested, A and B are already in the saved manifest
    snapshots.push(Object.keys(saved.at(-1).files).sort());
    return png();
  });
  const saved = [];
  const snapshots = [];
  const original = store.putManifest.bind(store);
  store.putManifest = async (userId, aoiId, manifest) => {
    saved.push(structuredClone(manifest));
    return original(userId, aoiId, manifest);
  };
  await run();
  assert.deepEqual(snapshots, [[FILE_A, FILE_B].sort()]);
  assert.ok(saved.length >= 3);
});

test("a hostile file id is failed, not stored, and not requested", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  fake.on("GET", `${BASE}/api/v1/areas-of-interest/${AOI}/files/`, reply({
    count: 1, next: null, previous: null,
    results: [{ id: "../../evil", original_filename: "x", mime_type: "text/plain", file_size: 1,
      location: { type: "Point", coordinates: [-1.25, 51.75] }, can_download: true }],
  }));
  const summary = await run();
  assert.equal(summary.failed, 1);
  assert.equal(summary.total, 1);
  assert.deepEqual(downloadCalls(fake), []);
  assert.deepEqual(Object.keys((await manifestOf(store)).files), []);
});

test("a missing content type on the listing falls back to the download's", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, { ...fileItem(FILE_A), mime_type: null });
  fake.on("GET", downloadUrl(FILE_A), raw("12345", "image/jpeg"));
  await run();
  assert.equal((await manifestOf(store)).files[FILE_A].mime_type, "image/jpeg");
});

// ---- progress ----------------------------------------------------------------------------

test("onProgress reports done/total/current as files are processed", async () => {
  const { fake, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A, { name: "one.png" }), fileItem(FILE_B, { name: "two.png" }));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  const events = [];
  await run({ onProgress: (p) => events.push({ ...p }) });
  assert.deepEqual(events, [
    { done: 0, total: 2, current: "one.png" },
    { done: 1, total: 2, current: "two.png" },
    { done: 2, total: 2, current: null },
  ]);
});

// ---- device storage full -----------------------------------------------------------------

function quota() {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

test("QuotaExceededError marks that file and every remaining download failed, and stops trying", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(
    fake,
    fileItem(FILE_A),
    fileItem(FILE_B),
    fileItem(FILE_C),
    fileItem("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { canDownload: false }),
  );
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  fake.on("GET", downloadUrl(FILE_C), png());
  const original = store.putBlob.bind(store);
  store.putBlob = async (userId, aoiId, fileId, blob) => {
    if (fileId === FILE_B) throw quota();
    return original(userId, aoiId, fileId, blob);
  };

  const summary = await run();

  const manifest = await manifestOf(store);
  assert.equal(manifest.files[FILE_A].status, "downloaded");
  assert.equal(manifest.files[FILE_B].status, "failed");
  assert.equal(manifest.files[FILE_B].reason, "device storage full");
  assert.equal(STORAGE_FULL_REASON, "device storage full");
  assert.equal(manifest.files[FILE_C].status, "failed");
  assert.equal(manifest.files[FILE_C].reason, "device storage full");
  assert.equal(manifest.files["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].status, "denied"); // needs no storage
  assert.deepEqual([summary.downloaded, summary.failed, summary.denied], [1, 2, 1]);
  assert.equal(downloadCalls(fake).length, 2); // C was never requested
});

test("other store errors are recorded as that file's failure, not as storage full", async () => {
  const { fake, store, run } = setup();
  mockArea(fake);
  mockListing(fake, fileItem(FILE_A), fileItem(FILE_B));
  fake.on("GET", downloadUrl(FILE_A), png());
  fake.on("GET", downloadUrl(FILE_B), png());
  const original = store.putBlob.bind(store);
  store.putBlob = async (u, a, fileId, blob) => {
    if (fileId === FILE_A) throw new Error("disk on fire");
    return original(u, a, fileId, blob);
  };
  const summary = await run();
  assert.deepEqual([summary.failed, summary.downloaded], [1, 1]);
  const manifest = await manifestOf(store);
  assert.match(manifest.files[FILE_A].reason, /disk on fire/);
});

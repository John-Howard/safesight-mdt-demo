import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidIdError,
  createMemoryStore,
  isDownloaded,
  makeEntry,
  newManifest,
  setEntry,
} from "../js/store.js";
import { AOI, FILE_A, FILE_B, USER_A, USER_B } from "./helpers/fixtures.js";

const OTHER_AOI = "22222222-2222-4222-8222-222222222222";

function manifestFor(aoiId, name = "Zone") {
  const manifest = newManifest(aoiId, { name, geometry: null });
  setEntry(manifest, makeEntry({ id: FILE_A, original_filename: "a.png", mime_type: "image/png", file_size: 3 }, "downloaded"));
  return manifest;
}

const blobOf = (text, type = "image/png") => new Blob([text], { type });

// ---- manifest helpers (port of cache.py) ---------------------------------------------

test("newManifest has the aoi id, area and an empty files map", () => {
  assert.deepEqual(newManifest(AOI.toUpperCase(), { name: "Z" }), { aoi_id: AOI, area: { name: "Z" }, files: {} });
  assert.throws(() => newManifest("nope", null), InvalidIdError);
});

test("makeEntry records the item fields, status, reason and feature", () => {
  const item = { id: FILE_A, original_filename: "a.png", mime_type: "image/png", file_size: 3, extra: "ignored" };
  const feature = { type: "Feature" };
  const entry = makeEntry(item, "denied", { reason: "viewer", feature });
  assert.equal(entry.id, FILE_A);
  assert.equal(entry.original_filename, "a.png");
  assert.equal(entry.mime_type, "image/png");
  assert.equal(entry.file_size, 3);
  assert.equal(entry.status, "denied");
  assert.equal(entry.reason, "viewer");
  assert.equal(entry.feature, feature);
  assert.ok(!("extra" in entry));
  assert.ok(!Number.isNaN(Date.parse(entry.synced_at)));
});

test("makeEntry defaults reason and feature to null, and rejects unknown statuses", () => {
  const entry = makeEntry({ id: FILE_A }, "downloaded");
  assert.equal(entry.reason, null);
  assert.equal(entry.feature, null);
  assert.throws(() => makeEntry({ id: FILE_A }, "weird"), /unknown status/);
});

test("setEntry keys the manifest by the canonical file id and rejects bad ids", () => {
  const manifest = newManifest(AOI, null);
  setEntry(manifest, makeEntry({ id: FILE_A.toUpperCase() }, "failed"));
  assert.deepEqual(Object.keys(manifest.files), [FILE_A]);
  assert.throws(() => setEntry(manifest, makeEntry({ id: "../../evil" }, "failed")), InvalidIdError);
});

test("isDownloaded needs a downloaded entry, the same size, and the blob in the store", async () => {
  const store = createMemoryStore();
  const manifest = manifestFor(AOI);
  const item = { id: FILE_A, file_size: 3 };
  assert.equal(await isDownloaded(store, USER_A, manifest, AOI, item), false); // no blob yet

  await store.putBlob(USER_A, AOI, FILE_A, blobOf("abc"));
  assert.equal(await isDownloaded(store, USER_A, manifest, AOI, item), true);
  assert.equal(await isDownloaded(store, USER_A, manifest, AOI, { id: FILE_A, file_size: 4 }), false);
  assert.equal(await isDownloaded(store, USER_A, manifest, AOI, { id: FILE_B, file_size: 3 }), false);
  assert.equal(await isDownloaded(store, USER_A, null, AOI, item), false);
  assert.equal(await isDownloaded(store, USER_B, manifest, AOI, item), false); // another user's blob

  manifest.files[FILE_A].status = "failed";
  assert.equal(await isDownloaded(store, USER_A, manifest, AOI, item), false);
});

// ---- the store contract ----------------------------------------------------------------

test("a manifest round-trips and the store keeps its own copy", async () => {
  const store = createMemoryStore();
  const manifest = manifestFor(AOI);
  await store.putManifest(USER_A, AOI, manifest);
  manifest.area.name = "mutated after put";
  const got = await store.getManifest(USER_A, AOI);
  assert.equal(got.area.name, "Zone");
  got.files[FILE_A].status = "failed";
  assert.equal((await store.getManifest(USER_A, AOI)).files[FILE_A].status, "downloaded");
});

test("getManifest is null for an unknown area", async () => {
  assert.equal(await createMemoryStore().getManifest(USER_A, AOI), null);
});

test("blobs round-trip with their bytes and type", async () => {
  const store = createMemoryStore();
  await store.putBlob(USER_A, AOI, FILE_A, blobOf("PNGDATA"));
  const blob = await store.getBlob(USER_A, AOI, FILE_A);
  assert.equal(await blob.text(), "PNGDATA");
  assert.equal(blob.type, "image/png");
  assert.equal(await store.getBlob(USER_A, AOI, FILE_B), null);
  assert.equal(await store.hasBlob(USER_A, AOI, FILE_A), true);
  assert.equal(await store.hasBlob(USER_A, AOI, FILE_B), false);
});

test("users never see each other's manifests or blobs", async () => {
  const store = createMemoryStore();
  await store.putManifest(USER_A, AOI, manifestFor(AOI, "Alice's"));
  await store.putBlob(USER_A, AOI, FILE_A, blobOf("secret"));

  assert.equal(await store.getManifest(USER_B, AOI), null);
  assert.equal(await store.getBlob(USER_B, AOI, FILE_A), null);
  assert.deepEqual(await store.listManifests(USER_B), []);

  await store.putManifest(USER_B, AOI, manifestFor(AOI, "Bob's"));
  assert.equal((await store.getManifest(USER_A, AOI)).area.name, "Alice's");
  assert.equal((await store.getManifest(USER_B, AOI)).area.name, "Bob's");
});

test("listManifests returns this user's manifests only", async () => {
  const store = createMemoryStore();
  await store.putManifest(USER_A, AOI, manifestFor(AOI));
  await store.putManifest(USER_A, OTHER_AOI, manifestFor(OTHER_AOI));
  await store.putManifest(USER_B, AOI, manifestFor(AOI));
  const listed = await store.listManifests(USER_A);
  assert.deepEqual(listed.map((m) => m.aoi_id).sort(), [AOI, OTHER_AOI].sort());
});

test("deleteArea removes that area's manifest and blobs, and nothing else", async () => {
  const store = createMemoryStore();
  await store.putManifest(USER_A, AOI, manifestFor(AOI));
  await store.putBlob(USER_A, AOI, FILE_A, blobOf("a"));
  await store.putManifest(USER_A, OTHER_AOI, manifestFor(OTHER_AOI));
  await store.putBlob(USER_A, OTHER_AOI, FILE_A, blobOf("b"));
  await store.putManifest(USER_B, AOI, manifestFor(AOI));
  await store.putBlob(USER_B, AOI, FILE_A, blobOf("c"));

  await store.deleteArea(USER_A, AOI);

  assert.equal(await store.getManifest(USER_A, AOI), null);
  assert.equal(await store.getBlob(USER_A, AOI, FILE_A), null);
  assert.ok(await store.getManifest(USER_A, OTHER_AOI));
  assert.equal(await (await store.getBlob(USER_A, OTHER_AOI, FILE_A)).text(), "b");
  assert.ok(await store.getManifest(USER_B, AOI));
  assert.equal(await (await store.getBlob(USER_B, AOI, FILE_A)).text(), "c");
});

test("clearUser removes everything for one user only", async () => {
  const store = createMemoryStore();
  await store.putManifest(USER_A, AOI, manifestFor(AOI));
  await store.putBlob(USER_A, AOI, FILE_A, blobOf("a"));
  await store.putManifest(USER_B, AOI, manifestFor(AOI));
  await store.clearUser(USER_A);
  assert.deepEqual(await store.listManifests(USER_A), []);
  assert.equal(await store.getBlob(USER_A, AOI, FILE_A), null);
  assert.equal((await store.listManifests(USER_B)).length, 1);
});

test("ids are canonicalised, so an upper-case id reaches the same record", async () => {
  const store = createMemoryStore();
  await store.putBlob(USER_A.toUpperCase(), AOI.toUpperCase(), FILE_A.toUpperCase(), blobOf("x"));
  assert.equal(await (await store.getBlob(USER_A, AOI, FILE_A)).text(), "x");
});

test("every method rejects a non-UUID id with InvalidIdError", async () => {
  const store = createMemoryStore();
  const bad = ["../../evil", "", "12345", null, undefined, 42, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../x"];
  for (const id of bad) {
    const label = String(id);
    await assert.rejects(store.getManifest(id, AOI), InvalidIdError, `user ${label}`);
    await assert.rejects(store.getManifest(USER_A, id), InvalidIdError, `aoi ${label}`);
    await assert.rejects(store.putManifest(USER_A, id, manifestFor(AOI)), InvalidIdError);
    await assert.rejects(store.listManifests(id), InvalidIdError);
    await assert.rejects(store.getBlob(USER_A, AOI, id), InvalidIdError, `file ${label}`);
    await assert.rejects(store.putBlob(USER_A, AOI, id, blobOf("x")), InvalidIdError);
    await assert.rejects(store.hasBlob(USER_A, AOI, id), InvalidIdError);
    await assert.rejects(store.deleteArea(USER_A, id), InvalidIdError);
    await assert.rejects(store.clearUser(id), InvalidIdError);
  }
});

test("putBlob only accepts a Blob", async () => {
  await assert.rejects(createMemoryStore().putBlob(USER_A, AOI, FILE_A, "text"), TypeError);
});

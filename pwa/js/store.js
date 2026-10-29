// Per-user, per-AOI storage for synced files: a manifest per AOI and one Blob per file.
// Port of mdt/cache.py with IndexedDB in place of the cache directory.
//
// Everything is keyed by the SafeSight user's UUID (the `user_id` claim), so one user never sees
// another's cache on a shared device: a viewer SafeSight refuses to let download, or a user in
// another organisation, cannot read what someone else synced. Ids are validated as UUIDs and
// canonicalised (lower-case) before they reach a backend, so a hostile id cannot become a key.
//
// Two backends share one validating front end: createMemoryStore() for tests and
// openIdbStore() for the browser. All methods are async.

import { InvalidIdError } from "./errors.js";
import { validId } from "./ids.js";

export { InvalidIdError };

export const STATUSES = ["downloaded", "denied", "failed"];

// ---- manifest helpers ----------------------------------------------------------------

export function newManifest(aoiId, area) {
  return { aoi_id: validId(aoiId), area, files: {} };
}

export function makeEntry(item, status, { reason = null, feature = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${JSON.stringify(status)}`);
  return {
    id: item.id ?? null,
    original_filename: item.original_filename ?? null,
    mime_type: item.mime_type ?? null,
    file_size: item.file_size ?? null,
    status,
    reason,
    feature,
    synced_at: new Date().toISOString(),
  };
}

export function setEntry(manifest, entry) {
  manifest.files[validId(entry.id)] = entry;
}

/** True when the file is already stored, with the size SafeSight reports. */
export async function isDownloaded(store, userId, manifest, aoiId, item) {
  if (!manifest) return false;
  const entry = manifest.files[validId(item.id)];
  if (!entry || entry.status !== "downloaded") return false;
  if (entry.file_size !== (item.file_size ?? null)) return false;
  return store.hasBlob(userId, aoiId, item.id);
}

// ---- validating front end ------------------------------------------------------------

function withValidation(backend) {
  return {
    getManifest: (userId, aoiId) => backend.getManifest(validId(userId), validId(aoiId)),
    putManifest: (userId, aoiId, manifest) =>
      backend.putManifest(validId(userId), validId(aoiId), manifest),
    listManifests: (userId) => backend.listManifests(validId(userId)),
    getBlob: (userId, aoiId, fileId) => backend.getBlob(validId(userId), validId(aoiId), validId(fileId)),
    hasBlob: (userId, aoiId, fileId) => backend.hasBlob(validId(userId), validId(aoiId), validId(fileId)),
    putBlob: (userId, aoiId, fileId, blob) => {
      const ids = [validId(userId), validId(aoiId), validId(fileId)];
      if (!(blob instanceof Blob)) return Promise.reject(new TypeError("putBlob needs a Blob"));
      return backend.putBlob(...ids, blob);
    },
    deleteArea: (userId, aoiId) => backend.deleteArea(validId(userId), validId(aoiId)),
    clearUser: (userId) => backend.clearUser(validId(userId)),
  };
}

/** Run a synchronous validator inside an async API so bad ids reject instead of throwing. */
function asyncApi(api) {
  const wrapped = {};
  for (const [name, fn] of Object.entries(api)) {
    wrapped[name] = async (...args) => fn(...args);
  }
  return wrapped;
}

// ---- in-memory backend (tests) -------------------------------------------------------

const clone = (value) => (value === undefined ? value : structuredClone(value));

export function createMemoryStore() {
  const manifests = new Map(); // "user/aoi" -> manifest (stored as a copy)
  const blobs = new Map(); // "user/aoi/file" -> Blob

  const dropWhere = (map, prefix) => {
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  };

  return asyncApi(
    withValidation({
      async getManifest(userId, aoiId) {
        return clone(manifests.get(`${userId}/${aoiId}`) ?? null);
      },
      async putManifest(userId, aoiId, manifest) {
        manifests.set(`${userId}/${aoiId}`, clone(manifest));
      },
      async listManifests(userId) {
        return [...manifests].filter(([key]) => key.startsWith(`${userId}/`)).map(([, m]) => clone(m));
      },
      async getBlob(userId, aoiId, fileId) {
        return blobs.get(`${userId}/${aoiId}/${fileId}`) ?? null;
      },
      async hasBlob(userId, aoiId, fileId) {
        return blobs.has(`${userId}/${aoiId}/${fileId}`);
      },
      async putBlob(userId, aoiId, fileId, blob) {
        blobs.set(`${userId}/${aoiId}/${fileId}`, blob);
      },
      async deleteArea(userId, aoiId) {
        manifests.delete(`${userId}/${aoiId}`);
        dropWhere(blobs, `${userId}/${aoiId}/`);
      },
      async clearUser(userId) {
        dropWhere(manifests, `${userId}/`);
        dropWhere(blobs, `${userId}/`);
      },
    }),
  );
}

// ---- IndexedDB backend ---------------------------------------------------------------

const MANIFESTS = "manifests"; // key [userId, aoiId]
const BLOBS = "blobs"; // key [userId, aoiId, fileId]

const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Resolves when the transaction has committed; rejects with its error (e.g. QuotaExceededError). */
const transactionDone = (tx) =>
  new Promise((resolve, reject) => {
    // A failed request aborts the transaction; the abort event carries the error (tx.error).
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException("Transaction aborted", "AbortError"));
  });

// Every key under a prefix: arrays sort after strings, so [prefix, []] is above any [prefix, x].
const prefixRange = (...prefix) => IDBKeyRange.bound(prefix, [...prefix, []]);

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(MANIFESTS);
      request.result.createObjectStore(BLOBS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

/** The IndexedDB-backed store. Rejects if IndexedDB is unavailable (some private modes). */
export async function openIdbStore(name = "safesight-mdt") {
  const db = await openDatabase(name);

  async function read(storeName, fn) {
    const tx = db.transaction(storeName, "readonly");
    return requestResult(fn(tx.objectStore(storeName)));
  }

  async function write(storeNames, fn) {
    const tx = db.transaction(storeNames, "readwrite");
    const done = transactionDone(tx);
    try {
      fn(tx);
    } catch (err) {
      tx.abort();
      await done.catch(() => {});
      throw err;
    }
    return done;
  }

  return asyncApi(withValidation({
    async getManifest(userId, aoiId) {
      return (await read(MANIFESTS, (s) => s.get([userId, aoiId]))) ?? null;
    },
    putManifest(userId, aoiId, manifest) {
      return write(MANIFESTS, (tx) => tx.objectStore(MANIFESTS).put(manifest, [userId, aoiId]));
    },
    listManifests(userId) {
      return read(MANIFESTS, (s) => s.getAll(prefixRange(userId)));
    },
    async getBlob(userId, aoiId, fileId) {
      return (await read(BLOBS, (s) => s.get([userId, aoiId, fileId]))) ?? null;
    },
    async hasBlob(userId, aoiId, fileId) {
      return (await read(BLOBS, (s) => s.count([userId, aoiId, fileId]))) > 0;
    },
    putBlob(userId, aoiId, fileId, blob) {
      return write(BLOBS, (tx) => tx.objectStore(BLOBS).put(blob, [userId, aoiId, fileId]));
    },
    deleteArea(userId, aoiId) {
      return write([MANIFESTS, BLOBS], (tx) => {
        tx.objectStore(MANIFESTS).delete([userId, aoiId]);
        tx.objectStore(BLOBS).delete(prefixRange(userId, aoiId));
      });
    },
    clearUser(userId) {
      return write([MANIFESTS, BLOBS], (tx) => {
        tx.objectStore(MANIFESTS).delete(prefixRange(userId));
        tx.objectStore(BLOBS).delete(prefixRange(userId));
      });
    },
  }));
}

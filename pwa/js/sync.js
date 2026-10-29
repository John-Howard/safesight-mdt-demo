// Download every file in an AOI into the store. Port of mdt/sync.py.

import { downloadFile, getAreaFeature, listAreaFiles } from "./client.js";
import { AuthError, InvalidIdError, PermissionDenied } from "./errors.js";
import { fileFeature } from "./geometry.js";
import { validId } from "./ids.js";
import { isDownloaded, makeEntry, newManifest, setEntry } from "./store.js";

export const SIZE_LIMIT_REASON = "sync size limit";
export const NO_DOWNLOAD_REASON = "Your role cannot download this file";
export const STORAGE_FULL_REASON = "device storage full";

const sizeOf = (item) => (Number.isInteger(item.file_size) ? item.file_size : 0);
const isQuotaError = (err) => err?.name === "QuotaExceededError" || err?.code === 22;
const messageOf = (err) => err?.message || err?.name || "Error";

/**
 * Sync one AOI. Per-file problems are recorded, not thrown. Resolves to a count summary:
 * `{total, downloaded, skipped, denied, failed, bytes}`.
 *
 * Only AuthError (and NotFound for an unknown area, or a failure to list the files) is thrown.
 * The manifest is written after every downloaded file and again when the run ends, even on
 * AuthError, so an interrupted sync (iOS may suspend or kill a backgrounded page at any time)
 * keeps what it got.
 *
 * @param {object} o
 * @param {object} o.session client session
 * @param {object} o.store storage (store.js)
 * @param {string} o.userId SafeSight user id
 * @param {string} o.aoiId
 * @param {number|null} [o.maxBytes] size cap for the area; remaining files are marked failed
 * @param {(p: {done: number, total: number, current: string|null}) => void} [o.onProgress]
 */
export async function syncArea({ session, store, userId, aoiId, maxBytes = null, onProgress = () => {} }) {
  aoiId = validId(aoiId);
  const areaFeature = await getAreaFeature(session, aoiId); // NotFound if absent
  const areaGeometry = areaFeature.geometry;
  const area = { name: (areaFeature.properties || {}).name ?? null, geometry: areaGeometry };

  // Listing happens before anything is written, so a failure here leaves the old manifest alone.
  const items = await listAreaFiles(session, aoiId, areaGeometry);
  const previous = await store.getManifest(userId, aoiId);
  const manifest = newManifest(aoiId, area);
  const summary = { total: 0, downloaded: 0, skipped: 0, denied: 0, failed: 0, bytes: 0 };
  let totalBytes = 0;
  let limitHit = false;
  let storageFull = false;

  // Entries from the previous sync that this run has not reached yet. They stay in the saved
  // manifest until the run completes, so an interruption does not orphan their blobs.
  const withUnvisited = () => ({
    ...manifest,
    files: { ...Object.fromEntries(Object.entries(previous?.files ?? {}).filter(([id]) => !(id in manifest.files))), ...manifest.files },
  });

  async function save(snapshot) {
    snapshot.synced_at = new Date().toISOString();
    try {
      await store.putManifest(userId, aoiId, snapshot);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      storageFull = true;
    }
  }

  /** Download one file into the store and return its manifest entry. Throws AuthError only. */
  async function downloadOne(item, feature) {
    let result;
    try {
      result = await downloadFile(session, item.id);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof PermissionDenied) return makeEntry(item, "denied", { reason: messageOf(err), feature });
      return makeEntry(item, "failed", { reason: messageOf(err), feature });
    }
    try {
      await store.putBlob(userId, aoiId, item.id, result.blob);
    } catch (err) {
      if (isQuotaError(err)) {
        storageFull = true;
        return makeEntry(item, "failed", { reason: STORAGE_FULL_REASON, feature });
      }
      return makeEntry(item, "failed", { reason: messageOf(err), feature });
    }
    const stored = { ...item, mime_type: item.mime_type || result.contentType };
    return makeEntry(stored, "downloaded", { feature });
  }

  let completed = false;
  try {
    for (const [index, item] of items.entries()) {
      onProgress({ done: index, total: items.length, current: item.original_filename || item.id });
      summary.total += 1;
      try {
        validId(item.id);
      } catch (err) {
        if (!(err instanceof InvalidIdError)) throw err;
        summary.failed += 1;
        continue;
      }
      const feature = fileFeature(item);
      let entry;
      let changed = true;

      if (item.can_download === false) {
        entry = makeEntry(item, "denied", { reason: NO_DOWNLOAD_REASON, feature });
      } else if (await isDownloaded(store, userId, previous, aoiId, item)) {
        entry = { ...previous.files[validId(item.id)], feature };
        summary.skipped += 1;
        totalBytes += sizeOf(item);
        changed = false;
      } else if (storageFull) {
        entry = makeEntry(item, "failed", { reason: STORAGE_FULL_REASON, feature });
      } else if (limitHit || (maxBytes !== null && totalBytes + sizeOf(item) > maxBytes)) {
        limitHit = true;
        entry = makeEntry(item, "failed", { reason: SIZE_LIMIT_REASON, feature });
      } else {
        entry = await downloadOne(item, feature);
        if (entry.status === "downloaded") {
          summary.downloaded += 1;
          totalBytes += sizeOf(item);
        }
      }

      if (entry.status === "denied") summary.denied += 1;
      if (entry.status === "failed") summary.failed += 1;
      setEntry(manifest, entry);
      if (changed) await save(withUnvisited());
    }
    onProgress({ done: items.length, total: items.length, current: null });
    completed = true;
  } finally {
    // Saved even when AuthError aborts the run, so completed downloads are not lost. A completed
    // run drops entries for files that are no longer in the area; an aborted one keeps them.
    try {
      await save(completed ? manifest : withUnvisited());
    } catch (err) {
      if (completed) throw err;
      // otherwise the original failure is the one worth reporting
    }
  }

  summary.bytes = totalBytes;
  return summary;
}

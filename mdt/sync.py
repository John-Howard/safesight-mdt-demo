"""Download every file in an AOI into the local cache."""

from pathlib import Path
from typing import Optional

from mdt import cache, geometry, safesight_client
from mdt.cache import InvalidIdError
from mdt.safesight_client import ApiSession, AuthError, PermissionDenied, SafeSightError

SIZE_LIMIT_REASON = "sync size limit"
NO_DOWNLOAD_REASON = "Your role cannot download this file"


def _size(item: dict) -> int:
    size = item.get("file_size")
    return size if isinstance(size, int) else 0


def _download_one(session: ApiSession, root: Path, aoi_id: str, item: dict, feature: dict) -> dict:
    """Download one file and return its manifest entry. Raises AuthError only."""
    try:
        content_type = safesight_client.download_file_to(
            session, item["id"], cache.file_path(root, aoi_id, item["id"])
        )
    except AuthError:
        raise
    except PermissionDenied as exc:
        return cache.make_entry(item, "denied", reason=str(exc), feature=feature)
    except (SafeSightError, OSError) as exc:
        return cache.make_entry(item, "failed", reason=str(exc) or exc.__class__.__name__,
                                feature=feature)  # fmt: skip
    entry_item = {**item, "mime_type": item.get("mime_type") or content_type}
    return cache.make_entry(entry_item, "downloaded", feature=feature)


def sync_area(
    session: ApiSession,
    aoi_id: str,
    cache_root: Path,
    max_bytes: Optional[int] = None,
) -> dict:
    """Sync one AOI. Per-file problems are recorded, not raised. Returns a count summary."""
    aoi_id = cache.valid_id(aoi_id)
    area_feature = safesight_client.get_area_feature(session, aoi_id)  # NotFound if absent
    area_geometry = area_feature.get("geometry")
    area = {
        "name": (area_feature.get("properties") or {}).get("name"),
        "geometry": area_geometry,
    }

    manifest = cache.new_manifest(aoi_id, area)
    previous = cache.load_manifest(cache_root, aoi_id)
    summary = {"total": 0, "downloaded": 0, "skipped": 0, "denied": 0, "failed": 0, "bytes": 0}
    total_bytes = 0
    limit_hit = False

    try:
        for item in safesight_client.iter_area_files(session, area_geometry):
            summary["total"] += 1
            try:
                cache.valid_id(item["id"])
            except InvalidIdError:
                summary["failed"] += 1
                continue
            feature = geometry.file_feature(item)

            if not item.get("can_download", True):
                entry = cache.make_entry(item, "denied", reason=NO_DOWNLOAD_REASON, feature=feature)
            elif cache.is_downloaded(cache_root, previous, aoi_id, item):
                entry = {**previous["files"][cache.valid_id(item["id"])], "feature": feature}
                summary["skipped"] += 1
                total_bytes += _size(item)
            elif limit_hit or (max_bytes is not None and total_bytes + _size(item) > max_bytes):
                limit_hit = True
                entry = cache.make_entry(item, "failed", reason=SIZE_LIMIT_REASON, feature=feature)
            else:
                entry = _download_one(session, cache_root, aoi_id, item, feature)
                if entry["status"] == "downloaded":
                    summary["downloaded"] += 1
                    total_bytes += _size(item)

            if entry["status"] == "denied":
                summary["denied"] += 1
            if entry["status"] == "failed":
                summary["failed"] += 1
            cache.set_entry(manifest, entry)
    finally:
        # Saved even when AuthError aborts the run, so completed downloads are not lost.
        manifest["synced_at"] = cache.now()
        cache.save_manifest(cache_root, aoi_id, manifest)

    summary["bytes"] = total_bytes
    return summary

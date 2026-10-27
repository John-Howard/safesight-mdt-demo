"""Per-AOI on-disk cache: <root>/<aoi_id>/manifest.json and <root>/<aoi_id>/files/<file_id>."""

import json
import tempfile
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

STATUSES = ("downloaded", "denied", "failed")


class InvalidIdError(ValueError):
    """An AOI or file id that is not a UUID; never allowed to become part of a path."""


def valid_id(value: Any) -> str:
    """Return the canonical lowercase UUID string, or raise InvalidIdError."""
    if not isinstance(value, str):
        raise InvalidIdError("id must be a string")
    try:
        return str(uuid.UUID(value))
    except ValueError as exc:
        raise InvalidIdError("id is not a UUID") from exc


def user_root(cache_dir: Path, user_id: Any) -> Path:
    """Per-SafeSight-user cache root. Every cache, sync and route call uses this as `root`."""
    return cache_dir / valid_id(user_id)


def aoi_dir(root: Path, aoi_id: Any) -> Path:
    return root / valid_id(aoi_id)


def file_path(root: Path, aoi_id: Any, file_id: Any) -> Path:
    return aoi_dir(root, aoi_id) / "files" / valid_id(file_id)


def now() -> str:
    return datetime.now(UTC).isoformat()


def new_manifest(aoi_id: str, area: Optional[dict]) -> dict:
    return {"aoi_id": valid_id(aoi_id), "area": area, "files": {}}


def make_entry(
    item: dict, status: str, reason: Optional[str] = None, feature: Optional[dict] = None
) -> dict:
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    return {
        "id": item.get("id"),
        "original_filename": item.get("original_filename"),
        "mime_type": item.get("mime_type"),
        "file_size": item.get("file_size"),
        "status": status,
        "reason": reason,
        "feature": feature,
        "synced_at": now(),
    }


def set_entry(manifest: dict, entry: dict) -> None:
    manifest["files"][valid_id(entry["id"])] = entry


def load_manifest(root: Path, aoi_id: Any) -> Optional[dict]:
    path = aoi_dir(root, aoi_id) / "manifest.json"
    try:
        manifest = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
        return None
    return manifest


def save_manifest(root: Path, aoi_id: Any, manifest: dict) -> None:
    """Write atomically: temp file in the same directory, then rename over the target."""
    directory = aoi_dir(root, aoi_id)
    directory.mkdir(parents=True, exist_ok=True)
    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", dir=directory, prefix=".manifest-", suffix=".tmp", delete=False
        ) as tmp:
            tmp_path = Path(tmp.name)
            json.dump(manifest, tmp, indent=2)
        tmp_path.replace(directory / "manifest.json")
    finally:
        if tmp_path is not None:
            with suppress(FileNotFoundError):
                tmp_path.unlink()


def is_downloaded(root: Path, manifest: Optional[dict], aoi_id: str, item: dict) -> bool:
    """True when the file is already cached, on disk, with the size SafeSight reports."""
    if manifest is None:
        return False
    entry = manifest["files"].get(valid_id(item["id"]))
    if not entry or entry.get("status") != "downloaded":
        return False
    if entry.get("file_size") != item.get("file_size"):
        return False
    return file_path(root, aoi_id, item["id"]).is_file()


def cached_areas_geojson(root: Path) -> dict:
    """FeatureCollection of every cached area, for the offline AOI list."""
    features = []
    if root.is_dir():
        for child in sorted(root.iterdir()):
            try:
                valid_id(child.name)
            except InvalidIdError:
                continue
            manifest = load_manifest(root, child.name)
            if manifest is None:
                continue
            area = manifest.get("area") or {}
            features.append(
                {
                    "type": "Feature",
                    "id": child.name,
                    "geometry": area.get("geometry"),
                    "properties": {"id": child.name, "name": area.get("name") or child.name},
                }
            )
    return {"type": "FeatureCollection", "features": features}

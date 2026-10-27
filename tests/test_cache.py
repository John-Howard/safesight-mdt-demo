from pathlib import Path

import pytest

from mdt import cache
from mdt.cache import InvalidIdError
from tests.conftest import AOI, FILE_A, USER_A


@pytest.mark.parametrize(
    "bad",
    ["../etc", "", "x", "..", "a/b", f"{AOI}/../x", 123, None, f"{AOI}\x00", "../" + AOI],
)
def test_rejects_bad_ids(tmp_path, bad):
    with pytest.raises(InvalidIdError):
        cache.file_path(tmp_path, AOI, bad)
    with pytest.raises(InvalidIdError):
        cache.file_path(tmp_path, bad, FILE_A)
    with pytest.raises(InvalidIdError):
        cache.load_manifest(tmp_path, bad)


def test_file_path_is_inside_root(tmp_path):
    p = cache.file_path(tmp_path, AOI, FILE_A.upper())
    assert p == tmp_path / AOI / "files" / FILE_A
    assert tmp_path in p.parents


def test_load_missing_manifest_is_none(tmp_path):
    assert cache.load_manifest(tmp_path, AOI) is None


def test_round_trip_and_no_temp_leftovers(tmp_path):
    manifest = cache.new_manifest(AOI, {"name": "Zone", "geometry": {"type": "Point"}})
    entry = cache.make_entry(
        {"id": FILE_A, "original_filename": "a.png", "mime_type": "image/png", "file_size": 3},
        status="downloaded",
        feature={"type": "Feature"},
    )
    cache.set_entry(manifest, entry)
    cache.save_manifest(tmp_path, AOI, manifest)
    loaded = cache.load_manifest(tmp_path, AOI)
    assert loaded["area"] == {"name": "Zone", "geometry": {"type": "Point"}}
    got = loaded["files"][FILE_A]
    assert set(got) == {
        "id",
        "original_filename",
        "mime_type",
        "file_size",
        "status",
        "reason",
        "feature",
        "synced_at",
    }
    assert got["status"] == "downloaded"
    assert got["synced_at"]
    assert sorted(p.name for p in (tmp_path / AOI).iterdir()) == ["manifest.json"]


def test_make_entry_rejects_unknown_status():
    with pytest.raises(ValueError):
        cache.make_entry({"id": FILE_A}, status="weird")


def test_manifest_write_is_atomic(tmp_path, monkeypatch):
    manifest = cache.new_manifest(AOI, None)
    cache.save_manifest(tmp_path, AOI, manifest)
    before = (tmp_path / AOI / "manifest.json").read_text()

    manifest["files"]["x"] = {"id": "x"}

    def boom(self, target):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "replace", boom)
    with pytest.raises(OSError):
        cache.save_manifest(tmp_path, AOI, manifest)
    assert (tmp_path / AOI / "manifest.json").read_text() == before
    assert [p.name for p in (tmp_path / AOI).iterdir()] == ["manifest.json"]


def test_cached_areas_geojson(tmp_path):
    cache.save_manifest(tmp_path, AOI, cache.new_manifest(AOI, {"name": "Z", "geometry": None}))
    (tmp_path / "not-a-uuid").mkdir()
    (tmp_path / "stray.txt").write_text("x")
    fc = cache.cached_areas_geojson(tmp_path)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    assert fc["features"][0]["properties"]["id"] == AOI
    assert fc["features"][0]["properties"]["name"] == "Z"


def test_corrupt_manifest_treated_as_missing(tmp_path):
    (tmp_path / AOI).mkdir()
    (tmp_path / AOI / "manifest.json").write_text("{not json")
    assert cache.load_manifest(tmp_path, AOI) is None


def test_user_root_namespaces_and_validates(tmp_path):
    assert cache.user_root(tmp_path, USER_A.upper()) == tmp_path / USER_A
    for bad in ["../x", "", None, "a/b"]:
        with pytest.raises(InvalidIdError):
            cache.user_root(tmp_path, bad)

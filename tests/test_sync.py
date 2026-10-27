import pytest
import requests
import responses

from mdt import cache, safesight_client, sync
from mdt.safesight_client import ApiSession, AuthError, NotFound, Tokens
from tests.conftest import (
    AOI,
    AREAS_URL,
    BASE,
    COVERAGE,
    FILE_A,
    FILE_B,
    FILE_C,
    file_item,
    load_fixture,
    mock_area,
    mock_listing,
)


def _download(fid, body=b"12345", **kw):
    responses.get(f"{BASE}/api/v1/files/{fid}/download/", body=body, content_type="image/png", **kw)


def _download_calls():
    return [c for c in responses.calls if c.request.url.endswith("/download/")]


def _run(api_session, root, **kw):
    return sync.sync_area(api_session, AOI, root, **kw)


@responses.activate
def test_downloads_everything_and_stores_area(api_session, tmp_path):
    mock_area(name="Z")
    mock_listing(file_item(FILE_A), file_item(FILE_B, point=None, coverage=COVERAGE))
    _download(FILE_A)
    _download(FILE_B)
    summary = _run(api_session, tmp_path)
    assert summary["downloaded"] == 2
    assert summary["total"] == 2
    assert summary["denied"] == summary["failed"] == summary["skipped"] == 0
    assert cache.file_path(tmp_path, AOI, FILE_A).read_bytes() == b"12345"
    manifest = cache.load_manifest(tmp_path, AOI)
    assert manifest["area"]["name"] == "Z"
    assert manifest["area"]["geometry"]["type"] == "MultiPolygon"
    assert manifest["files"][FILE_A]["status"] == "downloaded"
    assert manifest["files"][FILE_A]["feature"]["geometry"]["type"] == "Point"
    assert manifest["files"][FILE_B]["feature"]["geometry"]["type"] == "Polygon"


@responses.activate
def test_unknown_area_raises_not_found(api_session, tmp_path):
    responses.get(AREAS_URL, json=load_fixture("areas_geojson.json"))
    with pytest.raises(NotFound):
        _run(api_session, tmp_path)


@responses.activate
def test_can_download_false_is_denied_without_requesting(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A, can_download=False), file_item(FILE_B))
    _download(FILE_B)
    summary = _run(api_session, tmp_path)
    assert (summary["denied"], summary["downloaded"]) == (1, 1)
    assert [FILE_A in c.request.url for c in _download_calls()] == [False]
    entry = cache.load_manifest(tmp_path, AOI)["files"][FILE_A]
    assert entry["status"] == "denied"
    assert entry["reason"]


@responses.activate
def test_403_is_denied_and_run_continues(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A), file_item(FILE_B))
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", status=403, json={"error": "viewer"})
    _download(FILE_B)
    summary = _run(api_session, tmp_path)
    assert (summary["denied"], summary["downloaded"]) == (1, 1)
    manifest = cache.load_manifest(tmp_path, AOI)
    assert manifest["files"][FILE_A]["status"] == "denied"
    assert "viewer" in manifest["files"][FILE_A]["reason"]
    assert manifest["files"][FILE_B]["status"] == "downloaded"


@responses.activate
def test_other_failures_recorded_and_run_continues(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A), file_item(FILE_B), file_item(FILE_C))
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", status=500)
    responses.get(f"{BASE}/api/v1/files/{FILE_B}/download/", body=requests.ConnectionError("x"))
    _download(FILE_C)
    summary = _run(api_session, tmp_path)
    assert (summary["failed"], summary["downloaded"]) == (2, 1)
    manifest = cache.load_manifest(tmp_path, AOI)
    assert manifest["files"][FILE_A]["status"] == "failed"
    assert manifest["files"][FILE_A]["reason"]


@responses.activate
def test_skips_identical_size_but_redownloads_changed(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A, size=5), file_item(FILE_B, size=5))
    _download(FILE_A)
    _download(FILE_B)
    _run(api_session, tmp_path)

    responses.reset()
    mock_area()
    mock_listing(file_item(FILE_A, size=5), file_item(FILE_B, size=7))
    _download(FILE_B, body=b"1234567")
    summary = _run(api_session, tmp_path)
    assert (summary["skipped"], summary["downloaded"]) == (1, 1)
    assert cache.file_path(tmp_path, AOI, FILE_B).read_bytes() == b"1234567"
    assert len(_download_calls()) == 1


@responses.activate
def test_skip_requires_file_on_disk(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A))
    _download(FILE_A)
    _run(api_session, tmp_path)
    cache.file_path(tmp_path, AOI, FILE_A).unlink()
    assert _run(api_session, tmp_path)["downloaded"] == 1


@responses.activate
def test_size_limit_stops_new_downloads(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A, size=60), file_item(FILE_B, size=60), file_item(FILE_C, size=10))
    _download(FILE_A, body=b"x" * 60)
    summary = _run(api_session, tmp_path, max_bytes=100)
    assert (summary["downloaded"], summary["failed"]) == (1, 2)
    manifest = cache.load_manifest(tmp_path, AOI)
    assert manifest["files"][FILE_B]["reason"] == "sync size limit"
    assert manifest["files"][FILE_C]["status"] == "failed"
    assert manifest["files"][FILE_C]["reason"] == "sync size limit"
    assert len(_download_calls()) == 1


@responses.activate
def test_existing_files_count_toward_size_limit(api_session, tmp_path):
    mock_area()
    mock_listing(file_item(FILE_A, size=60))
    _download(FILE_A, body=b"x" * 60)
    _run(api_session, tmp_path)
    responses.reset()
    mock_area()
    mock_listing(file_item(FILE_A, size=60), file_item(FILE_B, size=60))
    summary = _run(api_session, tmp_path, max_bytes=100)
    assert (summary["skipped"], summary["failed"]) == (1, 1)


@responses.activate
def test_auth_error_propagates_but_progress_is_saved(tmp_path):
    session = ApiSession(base_url=BASE, tokens=Tokens("a", "r"))
    mock_area()
    mock_listing(file_item(FILE_A), file_item(FILE_B))
    _download(FILE_A)
    responses.get(f"{BASE}/api/v1/files/{FILE_B}/download/", status=401)
    responses.post(f"{BASE}/api/token/refresh/", status=401)
    with pytest.raises(AuthError):
        sync.sync_area(session, AOI, tmp_path)
    assert cache.load_manifest(tmp_path, AOI)["files"][FILE_A]["status"] == "downloaded"


@responses.activate
def test_hostile_file_id_is_failed_not_written(api_session, tmp_path, monkeypatch):
    mock_area()

    def fake_iter(session, aoi_id, aoi_geometry):
        yield {
            "id": "../../evil",
            "original_filename": "x",
            "mime_type": "text/plain",
            "file_size": 1,
            "organization_name": None,
            "group_name": None,
            "uploaded_at": None,
            "can_download": True,
            "geometry": None,
        }

    monkeypatch.setattr(safesight_client, "iter_area_files", fake_iter)
    summary = _run(api_session, tmp_path)
    assert summary["failed"] == 1
    assert list(tmp_path.rglob("evil")) == []
    assert _download_calls() == []

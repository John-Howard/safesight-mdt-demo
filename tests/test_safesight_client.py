import json
import re

import pytest
import requests
import responses

from mdt import safesight_client as client
from mdt.safesight_client import (
    ApiSession,
    AuthError,
    NotFound,
    PermissionDenied,
    RateLimited,
    ServerUnavailable,
    Tokens,
)
from tests import conftest
from tests.conftest import AOI, AREAS_URL, BASE, FILE_A, FILE_B, USER_A, load_fixture, make_jwt


@responses.activate
def test_obtain_tokens():
    responses.post(f"{BASE}/api/token/", json={"access": "A", "refresh": "R"})
    tokens = client.obtain_tokens(BASE, "bob", "pw")
    assert tokens == Tokens("A", "R")
    assert json.loads(responses.calls[0].request.body) == {"username": "bob", "password": "pw"}


@responses.activate
def test_obtain_tokens_bad_credentials():
    responses.post(f"{BASE}/api/token/", json={"detail": "No active account"}, status=401)
    with pytest.raises(AuthError):
        client.obtain_tokens(BASE, "bob", "bad")


@responses.activate
def test_obtain_tokens_unreachable():
    responses.post(f"{BASE}/api/token/", body=requests.ConnectionError("down"))
    with pytest.raises(ServerUnavailable):
        client.obtain_tokens(BASE, "bob", "pw")


@responses.activate
def test_bearer_header_sent(api_session):
    responses.get(f"{BASE}/api/v1/areas-of-interest/geojson/", json={"type": "FeatureCollection"})
    assert client.get_areas_geojson(api_session)["type"] == "FeatureCollection"
    assert responses.calls[0].request.headers["Authorization"] == "Bearer acc0"


@responses.activate
def test_401_refreshes_once_stores_both_tokens_and_retries(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=401)
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", json={"id": FILE_A})
    responses.post(f"{BASE}/api/token/refresh/", json={"access": "acc1", "refresh": "ref1"})

    assert client.get_file_detail(api_session, FILE_A) == {"id": FILE_A}

    assert api_session.tokens == Tokens("acc1", "ref1")
    refresh_calls = [c for c in responses.calls if c.request.url.endswith("/token/refresh/")]
    assert len(refresh_calls) == 1
    assert json.loads(refresh_calls[0].request.body) == {"refresh": "ref0"}
    assert responses.calls[-1].request.headers["Authorization"] == "Bearer acc1"


@responses.activate
def test_refresh_failure_raises_auth_error(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=401)
    responses.post(f"{BASE}/api/token/refresh/", status=401, json={"detail": "blacklisted"})
    with pytest.raises(AuthError):
        client.get_file_detail(api_session, FILE_A)


@responses.activate
def test_second_401_after_refresh_is_auth_error_without_second_refresh(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=401)
    responses.post(f"{BASE}/api/token/refresh/", json={"access": "acc1", "refresh": "ref1"})
    with pytest.raises(AuthError):
        client.get_file_detail(api_session, FILE_A)
    refreshes = [c for c in responses.calls if c.request.url.endswith("/token/refresh/")]
    assert len(refreshes) == 1


@responses.activate
def test_403_maps_to_permission_denied_with_server_text(api_session):
    responses.get(
        f"{BASE}/api/v1/files/{FILE_A}/download/",
        status=403,
        json={"error": "Viewers cannot download files"},
    )
    with pytest.raises(PermissionDenied, match="Viewers cannot download"):
        client._request(api_session, "GET", f"/api/v1/files/{FILE_A}/download/")


@responses.activate
def test_403_detail_text(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=403, json={"detail": "Nope"})
    with pytest.raises(PermissionDenied, match="Nope"):
        client.get_file_detail(api_session, FILE_A)


@pytest.mark.parametrize(
    ("status", "exc"),
    [(404, NotFound), (429, RateLimited), (500, ServerUnavailable), (503, ServerUnavailable)],
)
@responses.activate
def test_status_mapping(api_session, status, exc):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=status)
    with pytest.raises(exc):
        client.get_file_detail(api_session, FILE_A)


@responses.activate
def test_connection_error_maps_to_server_unavailable(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", body=requests.ConnectionError("x"))
    with pytest.raises(ServerUnavailable):
        client.get_file_detail(api_session, FILE_A)


@responses.activate
def test_timeout_maps_to_server_unavailable(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", body=requests.Timeout("slow"))
    with pytest.raises(ServerUnavailable):
        client.get_file_detail(api_session, FILE_A)


def _mock_fixture_listing():
    responses.get(conftest.aoi_files_url(), status=500)
    responses.get(f"{BASE}/api/v1/files/", json=load_fixture("files_list.json"))
    responses.get(f"{BASE}/api/v1/files/geojson/", json=load_fixture("files_geojson.json"))
    detail = load_fixture("file_detail_coverage_only.json")
    responses.get(f"{BASE}/api/v1/files/{detail['id']}/", json=detail)


def _aoi_geometry():
    return load_fixture("areas_geojson.json")["features"][0]["geometry"]


@responses.activate
def test_iter_area_files_real_fixtures_six_in_one_out(api_session):
    _mock_fixture_listing()
    got = list(client.iter_area_files(api_session, AOI, _aoi_geometry()))
    names = sorted(f["original_filename"] for f in got)
    assert len(got) == 6
    assert names == sorted(
        [
            "carfax-scene-photo.png",
            "station-incident-report.pdf",
            "hydrant-notes.txt",
            "hydrant-layout.svg",
            "ambulance-staging-point.png",
            "river-flood-extent.txt",
        ]
    )
    assert "headington-outside-area.txt" not in names


@responses.activate
def test_iter_area_files_item_shape_and_coverage_fallback(api_session):
    _mock_fixture_listing()
    by_name = {
        f["original_filename"]: f for f in client.iter_area_files(api_session, AOI, _aoi_geometry())
    }
    for item in by_name.values():
        assert set(item) == {
            "id",
            "original_filename",
            "mime_type",
            "file_size",
            "organization_name",
            "group_name",
            "uploaded_at",
            "can_download",
            "geometry",
        }
    point = by_name["ambulance-staging-point.png"]
    assert point["geometry"]["type"] == "Point"
    assert point["can_download"] is True
    assert point["file_size"] == 2771
    coverage = by_name["river-flood-extent.txt"]
    assert coverage["geometry"]["type"] == "Polygon"
    assert coverage["can_download"] is True  # default when geojson has no flag


@responses.activate
def test_detail_fetched_only_for_files_without_a_point(api_session):
    _mock_fixture_listing()
    list(client.iter_area_files(api_session, AOI, _aoi_geometry()))
    pattern = re.compile(r"/api/v1/files/[0-9a-f-]{36}/$")
    detail_calls = [c for c in responses.calls if pattern.search(c.request.url)]
    assert len(detail_calls) == 1
    assert "83ff6d17-79d0-46ad-9c5b-167fd6a88ace" in detail_calls[0].request.url


@responses.activate
def test_iter_area_files_requests_are_safe(api_session):
    _mock_fixture_listing()
    list(client.iter_area_files(api_session, AOI, _aoi_geometry()))
    for call in responses.calls:
        url = call.request.url
        assert "format" not in url
        assert "spatial_search" not in url
    first = responses.calls[1].request.url  # calls[0] is the 500 AOI probe
    assert "is_published=true" in first
    assert "page_size=200" in first


@responses.activate
def test_can_download_false_is_carried_through(api_session):
    conftest.mock_listing(conftest.file_item(FILE_A, can_download=False))
    (item,) = client.iter_area_files(api_session, AOI, conftest.AREA_GEOMETRY)
    assert item["can_download"] is False


@responses.activate
def test_coverage_less_file_without_point_is_dropped(api_session):
    conftest.mock_listing(
        conftest.file_item(FILE_A, point=None, coverage=None),
        conftest.file_item(FILE_B, point=None, coverage=conftest.COVERAGE),
    )
    ids = [f["id"] for f in client.iter_area_files(api_session, AOI, conftest.AREA_GEOMETRY)]
    assert ids == [FILE_B]


@responses.activate
def test_both_walks_follow_next_links(api_session):
    responses.get(conftest.aoi_files_url(), status=500)
    base_list = f"{BASE}/api/v1/files/"
    base_geo = f"{BASE}/api/v1/files/geojson/"

    def row(fid):
        return {"id": fid, "original_filename": fid, "mime_type": "text/plain", "file_size": 1,
                "organization_name": "O", "group_name": None, "uploaded_at": "t",
                "has_location": True}  # fmt: skip

    def feat(fid):
        geometry = {"type": "Point", "coordinates": [-1.25, 51.75]}
        props = {"id": fid, "can_download": True}
        return {"type": "Feature", "id": fid, "geometry": geometry, "properties": props}

    def fc(*f):
        return {"type": "FeatureCollection", "features": list(f)}

    responses.get(
        base_list, json={"next": f"{base_list}?page=2&page_size=200", "results": [row("1")]}
    )
    responses.get(f"{base_list}?page=2&page_size=200", json={"next": None, "results": [row("2")]})
    responses.get(
        base_geo, json={"next": f"{base_geo}?page=2&page_size=200", "results": fc(feat("1"))}
    )
    responses.get(f"{base_geo}?page=2&page_size=200", json={"next": None, "results": fc(feat("2"))})
    got = [f["id"] for f in client.iter_area_files(api_session, AOI, conftest.AREA_GEOMETRY)]
    assert got == ["1", "2"]


@responses.activate
def test_next_link_on_foreign_host_is_never_requested(api_session):
    responses.get(conftest.aoi_files_url(), status=500)
    responses.get(
        f"{BASE}/api/v1/files/",
        json={"next": "http://evil.test/steal/?page=2", "results": []},
    )
    responses.get(f"{BASE}/steal/?page=2", json={"next": None, "results": []})
    responses.get(f"{BASE}/api/v1/files/geojson/", json={"next": None, "results": {"features": []}})
    list(client.iter_area_files(api_session, AOI, conftest.AREA_GEOMETRY))
    assert all(c.request.url.startswith(BASE) for c in responses.calls)


@responses.activate
def test_get_area_feature_found_and_missing(api_session):
    responses.get(AREAS_URL, json=load_fixture("areas_geojson.json"))
    feat = client.get_area_feature(api_session, "f7374155-7d73-4c47-995e-ae427a2b4262")
    assert feat["properties"]["name"] == "Oxford city centre"
    with pytest.raises(NotFound):
        client.get_area_feature(api_session, AOI)


@responses.activate
def test_download_streams_to_dest_and_returns_content_type(api_session, tmp_path):
    responses.get(
        f"{BASE}/api/v1/files/{FILE_A}/download/",
        body=b"PNGDATA",
        content_type="image/png; charset=binary",
    )
    dest = tmp_path / "files" / FILE_A
    ctype = client.download_file_to(api_session, FILE_A, dest)
    assert ctype == "image/png"
    assert dest.read_bytes() == b"PNGDATA"
    assert [p.name for p in dest.parent.iterdir()] == [FILE_A]


@responses.activate
def test_download_failure_leaves_no_file(api_session, tmp_path):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", status=403, json={"error": "no"})
    dest = tmp_path / "files" / FILE_A
    with pytest.raises(PermissionDenied):
        client.download_file_to(api_session, FILE_A, dest)
    assert not dest.exists()
    assert list(dest.parent.iterdir()) == []


@responses.activate
def test_download_refreshes_on_401(api_session, tmp_path):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", status=401)
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", body=b"ok", content_type="text/plain")
    responses.post(f"{BASE}/api/token/refresh/", json={"access": "n", "refresh": "m"})
    assert client.download_file_to(api_session, FILE_A, tmp_path / "d" / "x") == "text/plain"
    assert api_session.tokens == Tokens("n", "m")


def test_api_session_defaults():
    s = ApiSession(base_url=BASE, tokens=Tokens("a", "r"))
    assert s.verify is True
    assert s.timeout > 0


def test_user_id_from_access_token():
    assert client.user_id_from_access_token(make_jwt(USER_A.upper())) == USER_A


@pytest.mark.parametrize(
    "token", [make_jwt(None), make_jwt("nope"), make_jwt(123), "garbage", "a.!!!.c", "a..c", ""]
)
def test_user_id_from_access_token_rejects_bad_tokens(token):
    with pytest.raises(client.InvalidTokenError):
        client.user_id_from_access_token(token)

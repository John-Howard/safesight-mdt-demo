"""iter_area_files prefers SafeSight's AOI files endpoint and falls back to the scan."""

import pytest
import requests
import responses

from mdt import safesight_client as client
from mdt.safesight_client import AuthError, PermissionDenied, RateLimited, ServerUnavailable
from tests import conftest
from tests.conftest import AOI, AREA_GEOMETRY, BASE, COVERAGE, FILE_A, FILE_B, FILE_C, aoi_files_url

ENDPOINT = aoi_files_url()
POINT_WKT = "SRID=4326;POINT(-1.25 51.75)"
COVERAGE_WKT = (
    "SRID=4326;POLYGON((-1.26 51.74, -1.25 51.74, -1.25 51.75, -1.26 51.75, -1.26 51.74))"
)
ITEM_KEYS = {
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


def result(fid, *, location=None, coverage=None, can_download=...):
    row = {
        "id": fid,
        "original_filename": f"{fid[:4]}.png",
        "description": "",
        "file_size": 5,
        "mime_type": "image/png",
        "location": location,
        "location_status": "ok",
        "coverage_area": coverage,
        "organization": "99999999-9999-4999-8999-999999999999",
        "organization_name": "Org",
        "group": None,
        "group_name": None,
        "uploaded_by": "u",
        "uploaded_by_username": "bob",
        "uploaded_at": "2026-01-01T00:00:00Z",
        "is_published": True,
        "distance": None,
    }
    if can_download is not ...:
        row["can_download"] = can_download
    return row


def page(*rows, next_url=None):
    return {"count": len(rows), "next": next_url, "previous": None, "results": list(rows)}


def point(lon=-1.25, lat=51.75):
    return {"type": "Point", "coordinates": [lon, lat]}


def run(api_session):
    return list(client.iter_area_files(api_session, AOI, AREA_GEOMETRY))


def urls():
    return [c.request.url for c in responses.calls]


@responses.activate
def test_supported_server_uses_one_request_and_no_detail_or_geojson(api_session):
    responses.get(ENDPOINT, json=page(result(FILE_A, location=point(), can_download=True)))
    (item,) = run(api_session)
    assert set(item) == ITEM_KEYS
    assert item["id"] == FILE_A
    assert item["can_download"] is True
    assert item["geometry"] == point()
    assert len(responses.calls) == 1
    assert "page_size=200" in urls()[0]
    assert "/api/v1/files/" not in urls()[0]


@responses.activate
def test_can_download_false_carried_through(api_session):
    responses.get(ENDPOINT, json=page(result(FILE_A, location=point(), can_download=False)))
    (item,) = run(api_session)
    assert item["can_download"] is False


@responses.activate
def test_two_pages_one_request_each(api_session):
    second = f"{ENDPOINT}?page=2&page_size=200"
    responses.get(
        ENDPOINT,
        json=page(result(FILE_A, location=point(), can_download=True), next_url=second),
    )
    responses.get(second, json=page(result(FILE_B, location=point(), can_download=True)))
    assert [f["id"] for f in run(api_session)] == [FILE_A, FILE_B]
    assert len(responses.calls) == 2


@responses.activate
def test_next_link_on_foreign_host_is_not_followed(api_session):
    responses.get(
        ENDPOINT,
        json=page(
            result(FILE_A, location=point(), can_download=True),
            next_url="http://evil.test/steal/?page=2",
        ),
    )
    responses.get(f"{BASE}/steal/?page=2", json=page())
    run(api_session)
    assert all(u.startswith(BASE) for u in urls())


@responses.activate
def test_never_sends_format_param(api_session):
    responses.get(ENDPOINT, json=page(result(FILE_A, location=point(), can_download=True)))
    run(api_session)
    assert all("format" not in u for u in urls())


@responses.activate
def test_ewkt_and_geojson_geometry_both_normalised(api_session):
    responses.get(
        ENDPOINT,
        json=page(
            result(FILE_A, location=POINT_WKT, can_download=True),
            result(FILE_B, location=point(), can_download=True),
        ),
    )
    by_id = {f["id"]: f for f in run(api_session)}
    assert by_id[FILE_A]["geometry"]["type"] == "Point"
    assert by_id[FILE_A]["geometry"]["coordinates"] == [-1.25, 51.75]
    assert by_id[FILE_B]["geometry"] == point()


@pytest.mark.parametrize("coverage", [COVERAGE, COVERAGE_WKT])
@responses.activate
def test_coverage_only_result_yields_its_polygon(api_session, coverage):
    responses.get(ENDPOINT, json=page(result(FILE_A, coverage=coverage, can_download=True)))
    (item,) = run(api_session)
    assert item["geometry"]["type"] == "Polygon"
    assert item["geometry"]["coordinates"][0][0] == [-1.26, 51.74]


@responses.activate
def test_point_wins_over_coverage(api_session):
    responses.get(
        ENDPOINT,
        json=page(result(FILE_A, location=POINT_WKT, coverage=COVERAGE, can_download=True)),
    )
    (item,) = run(api_session)
    assert item["geometry"]["type"] == "Point"


@responses.activate
def test_result_with_no_geometry_is_yielded_with_null_geometry(api_session):
    responses.get(ENDPOINT, json=page(result(FILE_A, can_download=True)))
    (item,) = run(api_session)
    assert item["geometry"] is None


def mock_scan_of_two_files():
    conftest.mock_listing(
        conftest.file_item(FILE_A, can_download=False),
        conftest.file_item(FILE_B, point=None, coverage=COVERAGE),
    )


@responses.activate
def test_results_without_can_download_fall_back_to_scan(api_session):
    mock_scan_of_two_files()
    responses.replace(
        responses.GET,
        ENDPOINT,
        json=page(result(FILE_A, location=point()), result(FILE_B, coverage=COVERAGE)),
    )
    got = {f["id"]: f for f in run(api_session)}
    assert set(got) == {FILE_A, FILE_B}
    assert got[FILE_A]["can_download"] is False  # only the scan knows this
    assert any("/api/v1/files/geojson/" in u for u in urls())


@responses.activate
def test_one_result_missing_can_download_is_enough_to_fall_back(api_session):
    mock_scan_of_two_files()
    responses.replace(
        responses.GET,
        ENDPOINT,
        json=page(
            result(FILE_A, location=point(), can_download=True),
            result(FILE_B, coverage=COVERAGE),
        ),
    )
    got = {f["id"]: f for f in run(api_session)}
    assert got[FILE_A]["can_download"] is False


@responses.activate
def test_fallback_set_matches_scan_set(api_session):
    mock_scan_of_two_files()
    scan_ids = {f["id"] for f in run(api_session)}  # endpoint answers 500 here
    client.reset_aoi_files_cache()
    responses.replace(responses.GET, ENDPOINT, json=page(result(FILE_A, location=point())))
    assert {f["id"] for f in run(api_session)} == scan_ids


@pytest.mark.parametrize("status", [500, 502, 404])
@responses.activate
def test_old_server_falls_back_and_second_call_does_not_reprobe(api_session, status):
    conftest.mock_listing(conftest.file_item(FILE_A))
    responses.replace(responses.GET, ENDPOINT, status=status)
    assert [f["id"] for f in run(api_session)] == [FILE_A]
    assert [f["id"] for f in run(api_session)] == [FILE_A]
    assert urls().count(f"{ENDPOINT}?page_size=200") == 1


@responses.activate
def test_unsupported_verdict_is_cached_per_base_url(api_session):
    conftest.mock_listing(conftest.file_item(FILE_A))
    run(api_session)
    other = client.ApiSession(base_url="http://other.test", tokens=api_session.tokens)
    responses.get(f"http://other.test/api/v1/areas-of-interest/{AOI}/files/", status=500)
    responses.get("http://other.test/api/v1/files/", json=page())
    responses.get("http://other.test/api/v1/files/geojson/", json=page())
    list(client.iter_area_files(other, AOI, AREA_GEOMETRY))
    assert any(u.startswith("http://other.test/api/v1/areas-of-interest/") for u in urls())


@responses.activate
def test_connection_error_propagates_without_scan_or_cache(api_session):
    responses.get(ENDPOINT, body=requests.ConnectionError("down"))
    with pytest.raises(ServerUnavailable):
        run(api_session)
    assert urls() == [f"{ENDPOINT}?page_size=200"]

    responses.replace(responses.GET, ENDPOINT, body=requests.Timeout("slow"))
    with pytest.raises(ServerUnavailable):
        run(api_session)

    # nothing was cached: once the server answers, the endpoint is tried again
    responses.replace(
        responses.GET, ENDPOINT, json=page(result(FILE_A, location=point(), can_download=True))
    )
    assert [f["id"] for f in run(api_session)] == [FILE_A]


@pytest.mark.parametrize(
    ("status", "exc"), [(401, AuthError), (403, PermissionDenied), (429, RateLimited)]
)
@responses.activate
def test_auth_permission_and_rate_limit_propagate_without_scan(api_session, status, exc):
    responses.get(ENDPOINT, status=status)
    if status == 401:
        responses.post(f"{BASE}/api/token/refresh/", status=401)
    with pytest.raises(exc):
        run(api_session)
    assert all("/api/v1/files/" not in u for u in urls())


@responses.activate
def test_error_on_second_page_falls_back_before_yielding_anything(api_session):
    conftest.mock_listing(conftest.file_item(FILE_C))
    second = f"{ENDPOINT}?page=2&page_size=200"
    responses.replace(
        responses.GET,
        ENDPOINT,
        json=page(result(FILE_A, location=point(), can_download=True), next_url=second),
    )
    responses.get(second, status=500)
    assert [f["id"] for f in run(api_session)] == [FILE_C]


@responses.activate
def test_empty_results_yield_nothing_and_are_not_cached(api_session):
    responses.get(ENDPOINT, json=page())
    assert run(api_session) == []
    assert len(responses.calls) == 1  # treated as supported: no scan

    responses.replace(
        responses.GET, ENDPOINT, json=page(result(FILE_A, location=point(), can_download=True))
    )
    assert [f["id"] for f in run(api_session)] == [FILE_A]
    assert len(responses.calls) == 2  # the empty verdict did not stick


@responses.activate
def test_empty_results_do_not_clear_a_cached_unsupported_verdict(api_session):
    conftest.mock_listing(conftest.file_item(FILE_A))
    run(api_session)
    responses.replace(responses.GET, ENDPOINT, json=page())
    run(api_session)
    assert urls().count(f"{ENDPOINT}?page_size=200") == 1


@responses.activate
def test_server_unavailable_carries_status_only_for_http_errors(api_session):
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/", status=503)
    with pytest.raises(ServerUnavailable) as http_err:
        client.get_file_detail(api_session, FILE_A)
    assert http_err.value.status == 503

    responses.replace(responses.GET, f"{BASE}/api/v1/files/{FILE_A}/", body=requests.Timeout("x"))
    with pytest.raises(ServerUnavailable) as net_err:
        client.get_file_detail(api_session, FILE_A)
    assert net_err.value.status is None


@responses.activate
def test_unsupported_verdict_expires_and_a_fixed_server_is_used(api_session, monkeypatch):
    conftest.mock_listing(conftest.file_item(FILE_A))
    run(api_session)  # old server: marked unsupported
    monkeypatch.setattr(client, "AOI_FILES_RETRY_SECONDS", 0)
    responses.replace(
        responses.GET, ENDPOINT, json=page(result(FILE_B, location=point(), can_download=True))
    )
    assert [f["id"] for f in run(api_session)] == [FILE_B]
    assert urls().count(f"{ENDPOINT}?page_size=200") == 2  # re-probed

    # the entry was cleared, so with a long TTL again the endpoint is still used
    monkeypatch.setattr(client, "AOI_FILES_RETRY_SECONDS", 900)
    assert [f["id"] for f in run(api_session)] == [FILE_B]
    assert urls().count(f"{ENDPOINT}?page_size=200") == 3


@responses.activate
def test_expired_verdict_with_server_still_old_falls_back_and_remarks(api_session, monkeypatch):
    conftest.mock_listing(conftest.file_item(FILE_A))
    run(api_session)
    monkeypatch.setattr(client, "AOI_FILES_RETRY_SECONDS", 0)
    assert [f["id"] for f in run(api_session)] == [FILE_A]
    assert urls().count(f"{ENDPOINT}?page_size=200") == 2  # re-probed, fell back

    monkeypatch.setattr(client, "AOI_FILES_RETRY_SECONDS", 900)
    assert [f["id"] for f in run(api_session)] == [FILE_A]
    assert urls().count(f"{ENDPOINT}?page_size=200") == 2  # re-marked: no third probe


def test_expired_entry_is_dropped_on_read(monkeypatch):
    client._mark_unsupported(BASE)
    monkeypatch.setattr(client, "AOI_FILES_RETRY_SECONDS", 0)
    assert client._is_unsupported(BASE) is False
    assert client._unsupported_servers == {}

import re

import pytest
import requests
import responses

from mdt import cache, token_store
from mdt.app import create_app
from tests.conftest import (
    AOI,
    AREAS_URL,
    BASE,
    COVERAGE,
    FILE_A,
    FILE_B,
    USER_A,
    USER_B,
    file_item,
    make_jwt,
    mock_area,
    mock_listing,
)

ACCESS_A = make_jwt(USER_A)


@pytest.fixture
def app(config):
    return create_app(config)


@pytest.fixture
def client(app):
    return app.test_client()


def csrf(client):
    with client.session_transaction() as s:
        return s["csrf_token"]


def login_as(client, user_id=USER_A, access=None):
    client.get("/login")
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        rsps.post(
            f"{BASE}/api/token/",
            json={"access": access or make_jwt(user_id), "refresh": "REFRESH-JWT"},
        )
        resp = client.post(
            "/login", data={"username": "u", "password": "p", "csrf_token": csrf(client)}
        )
    assert resp.status_code == 302
    return client


@pytest.fixture
def logged_in(client):
    """A client signed in as USER_A through the real login route."""
    return login_as(client, USER_A)


@pytest.fixture
def client_b(app):
    return login_as(app.test_client(), USER_B)


def _seed_cache(config, entries, user_id=USER_A):
    root = cache.user_root(config.cache_dir, user_id)
    manifest = cache.new_manifest(AOI, {"name": "Zone", "geometry": {"type": "Point"}})
    for fid, mime, name, status, body in entries:
        entry = cache.make_entry(
            {
                "id": fid,
                "original_filename": name,
                "mime_type": mime,
                "file_size": len(body or b""),
            },
            status=status,
            feature={"type": "Feature", "id": fid, "properties": {}, "geometry": None},
        )
        cache.set_entry(manifest, entry)
        if body is not None:
            path = cache.file_path(root, AOI, fid)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
    cache.save_manifest(root, AOI, manifest)


# ---- login / session / csrf ------------------------------------------------


def test_index_redirects_to_login_when_anonymous(client):
    resp = client.get("/")
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_login_page_renders_with_csrf_field(client):
    resp = client.get("/login")
    assert resp.status_code == 200
    assert b'name="csrf_token"' in resp.data


def test_login_head_does_not_attempt_signin(client):
    assert client.head("/login").status_code == 200


@responses.activate
def test_login_stores_tokens_server_side_only(client):
    client.get("/login")
    responses.post(f"{BASE}/api/token/", json={"access": ACCESS_A, "refresh": "REFRESH-JWT"})
    resp = client.post(
        "/login", data={"username": "u", "password": "p", "csrf_token": csrf(client)}
    )
    assert resp.status_code == 302
    with client.session_transaction() as s:
        flat = repr(dict(s))
        assert ACCESS_A not in flat and "REFRESH-JWT" not in flat
        tokens = token_store.get(s["token_id"])
        assert s["user_id"] == USER_A
    assert tokens.access == ACCESS_A
    assert tokens.refresh == "REFRESH-JWT"


@responses.activate
def test_login_failure_shows_message_and_stores_nothing(client):
    client.get("/login")
    responses.post(f"{BASE}/api/token/", status=401, json={"detail": "bad"})
    resp = client.post(
        "/login", data={"username": "u", "password": "x", "csrf_token": csrf(client)}
    )
    assert resp.status_code == 401
    assert b"Sign-in failed" in resp.data
    with client.session_transaction() as s:
        assert "token_id" not in s


@responses.activate
def test_login_when_safesight_down(client):
    client.get("/login")
    responses.post(f"{BASE}/api/token/", body=requests.ConnectionError("x"))
    resp = client.post(
        "/login", data={"username": "u", "password": "x", "csrf_token": csrf(client)}
    )
    assert resp.status_code == 503


def test_post_without_csrf_rejected(client):
    client.get("/login")
    resp = client.post("/login", data={"username": "u", "password": "p"})
    assert resp.status_code == 403


def test_post_with_wrong_csrf_rejected(client):
    client.get("/login")
    resp = client.post("/login", data={"username": "u", "password": "p", "csrf_token": "nope"})
    assert resp.status_code == 403


def test_post_with_no_session_rejected(client):
    assert client.post("/login", data={"csrf_token": "x"}).status_code == 403


def test_csrf_header_accepted(logged_in):
    with responses.RequestsMock(assert_all_requests_are_fired=False):
        resp = logged_in.post(f"/api/areas/{AOI}/sync", headers={"X-CSRF-Token": csrf(logged_in)})
    assert resp.status_code != 403


def test_json_post_without_csrf_rejected(logged_in):
    assert logged_in.post(f"/api/areas/{AOI}/sync").status_code == 403


def test_logout_drops_token_entry(logged_in):
    with logged_in.session_transaction() as s:
        tid = s["token_id"]
    assert token_store.get(tid) is not None
    resp = logged_in.post("/logout", data={"csrf_token": csrf(logged_in)})
    assert resp.status_code == 302
    assert token_store.get(tid) is None
    assert logged_in.get("/api/areas").status_code == 401


def test_logout_requires_csrf(logged_in):
    assert logged_in.post("/logout").status_code == 403
    assert logged_in.get("/logout").status_code == 405


@pytest.mark.parametrize(
    "path",
    ["/api/areas", f"/api/areas/{AOI}/files", f"/api/areas/{AOI}/cached", f"/files/{AOI}/{FILE_A}"],
)
def test_json_routes_require_login(client, path):
    resp = client.get(path)
    assert resp.status_code == 401
    if path.startswith("/api"):
        assert resp.is_json
        assert "error" in resp.get_json()


def test_stale_session_after_restart_is_unauthenticated(logged_in):
    token_store.clear()
    assert logged_in.get("/api/areas").status_code == 401


# ---- areas / files ---------------------------------------------------------


@responses.activate
def test_areas_proxy(logged_in):
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"id": AOI}}]}
    responses.get(AREAS_URL, json=fc)
    data = logged_in.get("/api/areas").get_json()
    assert data["features"] == fc["features"]
    assert data["offline"] is False
    assert responses.calls[0].request.headers["Authorization"] == f"Bearer {ACCESS_A}"


@responses.activate
def test_areas_offline_falls_back_to_cache(logged_in, config):
    _seed_cache(config, [])
    responses.get(AREAS_URL, body=requests.ConnectionError("x"))
    data = logged_in.get("/api/areas").get_json()
    assert data["offline"] is True
    assert data["features"][0]["properties"]["id"] == AOI


@responses.activate
def test_files_live_merged_with_cache_status(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"12345")])
    mock_area()
    mock_listing(
        file_item(FILE_A, size=5, name="a.png"),
        file_item(FILE_B, size=9, name="b.pdf", point=None, coverage=COVERAGE),
    )
    data = logged_in.get(f"/api/areas/{AOI}/files").get_json()
    assert data["offline"] is False
    assert data["area"]["name"] == "Zone"
    assert data["area"]["geometry"]["type"] == "MultiPolygon"
    by_id = {f["id"]: f for f in data["files"]}
    assert by_id[FILE_A]["status"] == "downloaded"
    assert by_id[FILE_A]["feature"]["geometry"]["type"] == "Point"
    assert by_id[FILE_B]["status"] == "not_synced"
    assert by_id[FILE_B]["feature"]["geometry"]["type"] == "Polygon"


@responses.activate
def test_files_can_download_false_reports_denied(logged_in):
    mock_area()
    mock_listing(file_item(FILE_A, can_download=False))
    data = logged_in.get(f"/api/areas/{AOI}/files").get_json()
    assert data["files"][0]["status"] == "denied"


@responses.activate
def test_changed_size_makes_cached_file_not_synced(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"12345")])
    mock_area()
    mock_listing(file_item(FILE_A, size=99, name="a.png"))
    data = logged_in.get(f"/api/areas/{AOI}/files").get_json()
    assert data["files"][0]["status"] == "not_synced"


@responses.activate
def test_files_falls_back_to_manifest_when_server_unreachable(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"12345")])
    responses.get(AREAS_URL, body=requests.ConnectionError("down"))
    resp = logged_in.get(f"/api/areas/{AOI}/files")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["offline"] is True
    assert data["files"][0]["id"] == FILE_A
    assert data["files"][0]["status"] == "downloaded"
    assert data["area"]["name"] == "Zone"


@responses.activate
def test_files_unreachable_and_no_cache_is_503(logged_in):
    responses.get(AREAS_URL, status=502)
    resp = logged_in.get(f"/api/areas/{AOI}/files")
    assert resp.status_code == 503
    assert resp.get_json()["offline"] is True


@responses.activate
def test_unknown_area_is_404(logged_in):
    responses.get(AREAS_URL, json={"type": "FeatureCollection", "features": []})
    assert logged_in.get(f"/api/areas/{AOI}/files").status_code == 404


def test_bad_aoi_id_rejected(logged_in):
    assert logged_in.get("/api/areas/not-a-uuid/files").status_code == 404
    assert logged_in.get("/api/areas/not-a-uuid/cached").status_code == 404


def test_cached_view(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"1")])
    data = logged_in.get(f"/api/areas/{AOI}/cached").get_json()
    assert data["offline"] is True
    assert data["files"][0]["original_filename"] == "a.png"


def test_cached_view_missing_is_404(logged_in):
    assert logged_in.get(f"/api/areas/{AOI}/cached").status_code == 404


@responses.activate
def test_sync_route_returns_summary(logged_in, config):
    mock_area()
    mock_listing(file_item(FILE_A, size=3))
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", body=b"abc", content_type="image/png")
    resp = logged_in.post(f"/api/areas/{AOI}/sync", headers={"X-CSRF-Token": csrf(logged_in)})
    assert resp.status_code == 200
    summary = resp.get_json()
    assert summary["downloaded"] == 1
    assert (
        cache.load_manifest(cache.user_root(config.cache_dir, USER_A), AOI)["area"]["name"]
        == "Zone"
    )


@responses.activate
def test_sync_unreachable_is_503(logged_in):
    responses.get(AREAS_URL, body=requests.ConnectionError("x"))
    resp = logged_in.post(f"/api/areas/{AOI}/sync", headers={"X-CSRF-Token": csrf(logged_in)})
    assert resp.status_code == 503


@responses.activate
def test_expired_refresh_returns_401_json(logged_in):
    responses.get(AREAS_URL, status=401)
    responses.post(f"{BASE}/api/token/refresh/", status=401)
    resp = logged_in.get(f"/api/areas/{AOI}/files")
    assert resp.status_code == 401
    assert resp.is_json


# ---- serving cached files --------------------------------------------------

SAFE = [
    ("image/png", "image/png"),
    ("image/jpeg", "image/jpeg"),
    ("image/gif", "image/gif"),
    ("image/webp", "image/webp"),
    ("application/pdf", "application/pdf"),
    ("text/plain", "text/plain"),
]


@pytest.mark.parametrize(("mime", "expected"), SAFE)
def test_safe_types_inline(logged_in, config, mime, expected):
    _seed_cache(config, [(FILE_A, mime, "f.bin", "downloaded", b"data")])
    resp = logged_in.get(f"/files/{AOI}/{FILE_A}")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"].startswith(expected)
    assert resp.headers["Content-Disposition"].startswith("inline")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.data == b"data"


@pytest.mark.parametrize(
    "mime",
    ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/zip", ""],
)
def test_unsafe_types_forced_to_download(logged_in, config, mime):
    _seed_cache(config, [(FILE_A, mime, "evil.svg", "downloaded", b"<svg onload=alert(1)>")])
    resp = logged_in.get(f"/files/{AOI}/{FILE_A}")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "application/octet-stream"
    assert resp.headers["Content-Disposition"].startswith("attachment")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


def test_mime_params_and_case_are_normalised(logged_in, config):
    _seed_cache(config, [(FILE_A, "IMAGE/PNG; charset=x", "a.png", "downloaded", b"d")])
    resp = logged_in.get(f"/files/{AOI}/{FILE_A}")
    assert resp.headers["Content-Disposition"].startswith("inline")


def test_non_downloaded_entries_are_404(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "denied", None)])
    assert logged_in.get(f"/files/{AOI}/{FILE_A}").status_code == 404


def test_missing_bytes_are_404(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"x")])
    cache.file_path(cache.user_root(config.cache_dir, USER_A), AOI, FILE_A).unlink()
    assert logged_in.get(f"/files/{AOI}/{FILE_A}").status_code == 404


@pytest.mark.parametrize(
    "path", ["/files/not-a-uuid/x", f"/files/{AOI}/..%2f..%2fetc", "/files/../x/y"]
)
def test_hostile_ids_are_404(logged_in, path):
    assert logged_in.get(path).status_code == 404


# ---- headers and templates -------------------------------------------------


def test_csp_header(client):
    csp = client.get("/login").headers["Content-Security-Policy"]
    for part in [
        "default-src 'self'",
        "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]:
        assert part in csp


def test_csp_on_json_and_files(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"1")])
    assert (
        "default-src 'self'"
        in logged_in.get(f"/files/{AOI}/{FILE_A}").headers["Content-Security-Policy"]
    )


def test_no_inline_script_or_style(logged_in, client):
    pages = [client.get("/login").get_data(as_text=True)]
    pages.append(logged_in.get("/").get_data(as_text=True))
    for html in pages:
        assert re.search(r"<script(?![^>]*\ssrc=)", html) is None
        assert re.search(r"\sstyle\s*=", html) is None
        assert re.search(r"\son[a-z]+\s*=", html) is None
        assert "<style" not in html


def test_map_page_has_csrf_meta_and_attribution_assets(logged_in):
    html = logged_in.get("/").get_data(as_text=True)
    assert 'name="csrf-token"' in html
    assert "vendor/leaflet.js" in html
    assert "vendor/bulma.min.css" in html
    assert "app.js" in html


def test_vendor_assets_served(client):
    assert client.get("/static/vendor/leaflet.js").status_code == 200
    assert client.get("/static/vendor/images/layers.png").status_code == 200


def test_create_app_reads_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SAFESIGHT_BASE_URL", "http://env.test")
    monkeypatch.setenv("MDT_CACHE_DIR", str(tmp_path))
    app = create_app()
    assert app.config["MDT"].safesight_base_url == "http://env.test"


# ---- per-user cache isolation ---------------------------------------------


def test_cache_is_namespaced_per_user_on_disk(logged_in, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"x")])
    assert (config.cache_dir / USER_A / AOI / "manifest.json").is_file()
    assert not (config.cache_dir / AOI).exists()


def test_other_user_cannot_read_cached_file(logged_in, client_b, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"secret")])
    assert logged_in.get(f"/files/{AOI}/{FILE_A}").data == b"secret"
    assert client_b.get(f"/files/{AOI}/{FILE_A}").status_code == 404


def test_other_user_cannot_see_cached_manifest(logged_in, client_b, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"secret")])
    assert logged_in.get(f"/api/areas/{AOI}/cached").status_code == 200
    assert client_b.get(f"/api/areas/{AOI}/cached").status_code == 404


@responses.activate
def test_offline_area_list_only_shows_own_areas(logged_in, client_b, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"x")])
    responses.get(AREAS_URL, body=requests.ConnectionError("x"))
    mine = logged_in.get("/api/areas").get_json()
    theirs = client_b.get("/api/areas").get_json()
    assert [f["properties"]["id"] for f in mine["features"]] == [AOI]
    assert theirs["offline"] is True
    assert theirs["features"] == []


@responses.activate
def test_offline_files_fallback_is_per_user(logged_in, client_b, config):
    _seed_cache(config, [(FILE_A, "image/png", "a.png", "downloaded", b"x")])
    responses.get(AREAS_URL, body=requests.ConnectionError("x"))
    assert logged_in.get(f"/api/areas/{AOI}/files").status_code == 200
    assert client_b.get(f"/api/areas/{AOI}/files").status_code == 503


@responses.activate
def test_sync_writes_into_the_users_own_namespace(client_b, config):
    mock_area()
    mock_listing(file_item(FILE_A, size=3))
    responses.get(f"{BASE}/api/v1/files/{FILE_A}/download/", body=b"abc", content_type="image/png")
    resp = client_b.post(f"/api/areas/{AOI}/sync", headers={"X-CSRF-Token": csrf(client_b)})
    assert resp.status_code == 200
    assert (config.cache_dir / USER_B / AOI / "manifest.json").is_file()
    assert not (config.cache_dir / USER_A).exists()
    assert client_b.get(f"/files/{AOI}/{FILE_A}").data == b"abc"


@pytest.mark.parametrize(
    "access",
    [make_jwt(None), make_jwt("not-a-uuid"), make_jwt("../../etc"), "garbage", "a.b.c", "a..c"],
)
def test_login_rejected_without_valid_user_id(client, access):
    client.get("/login")
    with responses.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        rsps.post(f"{BASE}/api/token/", json={"access": access, "refresh": "r"})
        resp = client.post(
            "/login", data={"username": "u", "password": "p", "csrf_token": csrf(client)}
        )
    assert resp.status_code == 502
    assert b"user" in resp.data.lower()
    with client.session_transaction() as s:
        assert "token_id" not in s
        assert "user_id" not in s
    assert token_store.get(None) is None
    assert client.get("/api/areas").status_code == 401

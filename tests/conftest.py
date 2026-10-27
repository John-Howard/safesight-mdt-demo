import base64
import json
from pathlib import Path
from typing import Optional

import pytest
import responses

from mdt import safesight_client, token_store
from mdt.config import Config
from mdt.safesight_client import ApiSession, Tokens

BASE = "http://safesight.test"
AOI = "11111111-1111-4111-8111-111111111111"
FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
FILE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
USER_A = "aaaa0000-0000-4000-8000-00000000000a"
USER_B = "bbbb0000-0000-4000-8000-00000000000b"


def make_jwt(user_id: Optional[str] = USER_A, **claims) -> str:
    """Unsigned JWT-shaped token; the MDT only reads the payload."""

    def b64(obj) -> str:
        raw = json.dumps(obj).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    payload = dict(claims)
    if user_id is not None:
        payload["user_id"] = user_id
    return f"{b64({'alg': 'none'})}.{b64(payload)}.sig"


@pytest.fixture(autouse=True)
def _clean_token_store():
    token_store.clear()
    yield
    token_store.clear()


@pytest.fixture(autouse=True)
def _clean_aoi_files_cache():
    safesight_client.reset_aoi_files_cache()
    yield
    safesight_client.reset_aoi_files_cache()


@pytest.fixture
def api_session():
    return ApiSession(base_url=BASE, tokens=Tokens(access="acc0", refresh="ref0"))


@pytest.fixture
def config(tmp_path):
    return Config(
        safesight_base_url=BASE,
        cache_dir=tmp_path / "cache",
        secret_key="test-secret",
        verify_tls=True,
        timeout=5.0,
        max_sync_bytes=1_000_000,
    )


FIXTURES = Path(__file__).parent / "fixtures"
AREAS_URL = f"{BASE}/api/v1/areas-of-interest/geojson/"
# MultiPolygon covering roughly (-1.3 51.7) to (-1.2 51.8)
AREA_GEOMETRY = {
    "type": "MultiPolygon",
    "coordinates": [[[[-1.3, 51.7], [-1.2, 51.7], [-1.2, 51.8], [-1.3, 51.8], [-1.3, 51.7]]]],
}
COVERAGE = {
    "type": "Polygon",
    "coordinates": [
        [[-1.26, 51.74], [-1.25, 51.74], [-1.25, 51.75], [-1.26, 51.75], [-1.26, 51.74]]
    ],
}


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def file_item(
    fid: str,
    size: int = 5,
    name: Optional[str] = None,
    mime: str = "image/png",
    point: Optional[tuple] = (-1.25, 51.75),
    coverage: Optional[dict] = None,
    can_download: bool = True,
) -> dict:
    return {
        "id": fid,
        "original_filename": name or f"{fid[:4]}.png",
        "mime_type": mime,
        "file_size": size,
        "point": point,
        "coverage": coverage,
        "can_download": can_download,
    }


def mock_area(aoi_id: str = AOI, name: str = "Zone") -> None:
    feature = {
        "type": "Feature",
        "id": aoi_id,
        "geometry": AREA_GEOMETRY,
        "properties": {"id": aoi_id, "name": name},
    }
    responses.get(AREAS_URL, json={"type": "FeatureCollection", "features": [feature]})


def aoi_files_url(aoi_id: str = AOI) -> str:
    return f"{BASE}/api/v1/areas-of-interest/{aoi_id}/files/"


def mock_listing(*items: dict) -> None:
    """Register the SafeSight listing endpoints for the given file_item dicts.

    The AOI files endpoint answers 500, like a server without the fix, so the
    client falls back to the scan these mocks describe.
    """
    responses.get(aoi_files_url(), status=500)
    results, features = [], []
    for it in items:
        results.append(
            {
                "id": it["id"],
                "original_filename": it["original_filename"],
                "mime_type": it["mime_type"],
                "file_size": it["file_size"],
                "organization_name": "Org",
                "group_name": None,
                "uploaded_at": "2026-01-01T00:00:00Z",
                "has_location": it["point"] is not None,
            }
        )
        if it["point"] is not None:
            features.append(
                {
                    "type": "Feature",
                    "id": it["id"],
                    "geometry": {"type": "Point", "coordinates": list(it["point"])},
                    "properties": {"id": it["id"], "can_download": it["can_download"]},
                }
            )
            continue
        dual = {"epsg_4326": it["coverage"]} if it["coverage"] else None
        responses.get(f"{BASE}/api/v1/files/{it['id']}/", json={"coverage_area_dual_crs": dual})
    responses.get(
        f"{BASE}/api/v1/files/geojson/",
        json={
            "count": len(features),
            "next": None,
            "results": {"type": "FeatureCollection", "features": features},
        },
    )
    responses.get(
        f"{BASE}/api/v1/files/", json={"count": len(results), "next": None, "results": results}
    )

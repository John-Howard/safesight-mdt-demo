"""Read-only SafeSight REST client. Functions take an ApiSession; errors are SafeSightError."""

import base64
import binascii
import contextlib
import json
import tempfile
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

import requests

from mdt import geometry

CHUNK = 64 * 1024
PAGE_SIZE = 200


class SafeSightError(Exception):
    """Base class for every error raised by this client."""


class AuthError(SafeSightError):
    pass


class PermissionDenied(SafeSightError):
    pass


class NotFound(SafeSightError):
    pass


class RateLimited(SafeSightError):
    pass


class ServerUnavailable(SafeSightError):
    """SafeSight is down or unreachable.

    `status` is the HTTP status for a 5xx response, and None for a network failure
    (connection refused, timeout, bad JSON), so callers can tell the two apart.
    """

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


class InvalidTokenError(SafeSightError):
    """SafeSight issued an access token we cannot identify a user from."""


@dataclass
class Tokens:
    access: str
    refresh: str


@dataclass
class ApiSession:
    base_url: str
    tokens: Tokens
    verify: bool = True
    timeout: float = 30.0


def _message(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    if isinstance(body, dict):
        for key in ("error", "detail"):
            if body.get(key):
                return str(body[key])
    return f"HTTP {response.status_code}"


def _raise_for_status(response: requests.Response) -> None:
    status = response.status_code
    if status < 400:
        return
    message = _message(response)
    if status == 401:
        raise AuthError(message)
    if status == 403:
        raise PermissionDenied(message)
    if status == 404:
        raise NotFound(message)
    if status == 429:
        raise RateLimited(message)
    if status >= 500:
        raise ServerUnavailable(message, status=status)
    raise SafeSightError(message)


def _send(
    method: str,
    url: str,
    *,
    verify: bool,
    timeout: float,
    headers: Optional[dict] = None,
    **kwargs: Any,
) -> requests.Response:
    try:
        return requests.request(
            method, url, headers=headers, verify=verify, timeout=timeout, **kwargs
        )
    except requests.RequestException as exc:
        raise ServerUnavailable(f"SafeSight unreachable: {exc.__class__.__name__}") from exc


def _post_tokens(
    url: str, payload: dict, verify: bool, timeout: float, auth_message: str
) -> Tokens:
    response = _send("POST", url, verify=verify, timeout=timeout, json=payload)
    if response.status_code in (400, 401):
        raise AuthError(auth_message)
    _raise_for_status(response)
    try:
        body = response.json()
        return Tokens(access=body["access"], refresh=body["refresh"])
    except (ValueError, KeyError, TypeError) as exc:
        raise SafeSightError("Unexpected token response from SafeSight") from exc


def user_id_from_access_token(access: str) -> str:
    """Read the `user_id` claim (a UUID) from the JWT payload.

    The signature is deliberately not verified: the token was just received from
    SafeSight over our own connection, and the value only keys the local cache.
    """
    parts = access.split(".") if isinstance(access, str) else []
    if len(parts) != 3:
        raise InvalidTokenError("SafeSight returned an access token with no readable user id")
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        claim = payload["user_id"]
        if not isinstance(claim, str):
            raise TypeError("user_id is not a string")
        return str(uuid.UUID(claim))
    except (ValueError, KeyError, TypeError, binascii.Error) as exc:
        raise InvalidTokenError("SafeSight access token has no valid user id") from exc


def obtain_tokens(
    base_url: str, username: str, password: str, verify: bool = True, timeout: float = 30.0
) -> Tokens:
    return _post_tokens(
        f"{base_url}/api/token/",
        {"username": username, "password": password},
        verify,
        timeout,
        "Invalid username or password",
    )


def refresh_tokens(session: ApiSession) -> Tokens:
    """Swap the refresh token for new ones. SafeSight rotates, so both are stored."""
    new = _post_tokens(
        f"{session.base_url}/api/token/refresh/",
        {"refresh": session.tokens.refresh},
        session.verify,
        session.timeout,
        "Session expired; sign in again",
    )
    session.tokens.access = new.access
    session.tokens.refresh = new.refresh
    return session.tokens


def _request(
    session: ApiSession,
    method: str,
    path: str,
    *,
    params: Optional[dict] = None,
    stream: bool = False,
) -> requests.Response:
    """Authenticated request. One refresh and retry on 401, then map errors."""
    url = path if path.startswith("http") else f"{session.base_url}{path}"
    refreshed = False
    while True:
        response = _send(
            method,
            url,
            verify=session.verify,
            timeout=session.timeout,
            headers={"Authorization": f"Bearer {session.tokens.access}"},
            params=params,
            stream=stream,
        )
        if response.status_code != 401 or refreshed:
            break
        response.close()
        refresh_tokens(session)
        refreshed = True
    try:
        _raise_for_status(response)
    except SafeSightError:
        response.close()
        raise
    return response


def _json(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        raise ServerUnavailable("SafeSight returned invalid JSON") from exc


def get_areas_geojson(session: ApiSession) -> dict:
    return _json(_request(session, "GET", "/api/v1/areas-of-interest/geojson/"))


def get_area_feature(session: ApiSession, aoi_id: str) -> dict:
    for feature in get_areas_geojson(session).get("features", []):
        props = feature.get("properties") or {}
        if str(props.get("id", feature.get("id"))) == str(aoi_id):
            return feature
    raise NotFound("Area of interest not found")


def get_file_detail(session: ApiSession, file_id: str) -> dict:
    return _json(_request(session, "GET", f"/api/v1/files/{file_id}/"))


def _local_path(next_url: str) -> str:
    """Follow `next` links only on our own base URL, so the bearer token cannot leak."""
    parts = urlsplit(next_url)
    return f"{parts.path}?{parts.query}" if parts.query else parts.path


def _walk(session: ApiSession, path: str, params: dict) -> Iterator[Any]:
    """Yield each page's `results` value, following `next`."""
    next_path: Optional[str] = path
    next_params: Optional[dict] = params
    while next_path:
        body = _json(_request(session, "GET", next_path, params=next_params))
        yield body.get("results")
        next_url = body.get("next")
        next_path = _local_path(next_url) if next_url else None
        next_params = None


def _coverage_polygon(session: ApiSession, file_id: str) -> Optional[dict]:
    detail = get_file_detail(session, file_id)
    dual = detail.get("coverage_area_dual_crs") or {}
    return dual.get("epsg_4326")


# How long a server stays marked as needing the scan before the endpoint is tried again.
AOI_FILES_RETRY_SECONDS = 900

# base_url -> time.monotonic() when we learned the AOI files endpoint cannot be used (an
# old server, or one that does not report can_download). Only that verdict is stored, so
# a server that needs the scan is not probed, and does not log a 500, on every request.
# The entry expires after AOI_FILES_RETRY_SECONDS and is dropped on read, so one transient
# 5xx does not pin a server to the scan, and an upgraded SafeSight is noticed without a
# restart of the MDT.
_unsupported_lock = threading.Lock()
_unsupported_servers: dict[str, float] = {}


def reset_aoi_files_cache() -> None:
    """Forget what we learned about each server's AOI files endpoint (for tests)."""
    with _unsupported_lock:
        _unsupported_servers.clear()


def _mark_unsupported(base_url: str) -> None:
    with _unsupported_lock:
        _unsupported_servers[base_url] = time.monotonic()


def _is_unsupported(base_url: str) -> bool:
    with _unsupported_lock:
        marked = _unsupported_servers.get(base_url)
        if marked is None:
            return False
        if time.monotonic() - marked >= AOI_FILES_RETRY_SECONDS:
            del _unsupported_servers[base_url]
            return False
        return True


def _fetch_aoi_files(session: ApiSession, aoi_id: str) -> Optional[list[dict]]:
    """Every result of the AOI files endpoint, or None when this server can't be used.

    None means the endpoint failed with a 5xx or 404 (SafeSight before #396), or its
    results lack `can_download`. Network failures, auth, permission and rate-limit
    errors propagate. All pages are read before anything is returned, so a failure
    on a later page falls back before a partial list has been yielded.
    """
    path = f"/api/v1/areas-of-interest/{aoi_id}/files/"
    results: list[dict] = []
    try:
        for page in _walk(session, path, {"page_size": PAGE_SIZE}):
            results.extend(page or [])
    except NotFound:
        return None
    except ServerUnavailable as exc:
        if exc.status is None:
            raise  # network failure: the scan would fail too, and the routes go offline
        return None
    if results and not all("can_download" in row for row in results):
        # SafeSight with #396 but without can_download. Using these results would
        # make a viewer's sync try one doomed download per file, each one a denied
        # row in SafeSight's FileAccessLog. The scan's can_download pre-check avoids
        # that, so keep scanning until the server reports the flag.
        return None
    return results


def _area_file_item(row: dict) -> dict:
    file_geometry = geometry.to_geojson(row.get("location")) or geometry.to_geojson(
        row.get("coverage_area")
    )
    return {
        "id": str(row["id"]),
        "original_filename": row.get("original_filename"),
        "mime_type": row.get("mime_type"),
        "file_size": row.get("file_size"),
        "organization_name": row.get("organization_name"),
        "group_name": row.get("group_name"),
        "uploaded_at": row.get("uploaded_at"),
        "can_download": bool(row["can_download"]),
        "geometry": file_geometry,
    }


def iter_area_files(session: ApiSession, aoi_id: str, aoi_geometry: dict) -> Iterator[dict]:
    """Yield the files whose point or coverage polygon intersects the AOI.

    Uses SafeSight's AOI files endpoint when it works and reports `can_download`,
    and otherwise computes membership client-side (see docs/architecture.md).
    Never sends a `format` query parameter.
    """
    if not _is_unsupported(session.base_url):
        results = _fetch_aoi_files(session, aoi_id)
        if results is None:
            _mark_unsupported(session.base_url)
        else:
            # An empty list cannot tell a server with can_download from one without,
            # so it counts as supported for this call only and nothing is remembered.
            yield from (_area_file_item(row) for row in results)
            return
    yield from _scan_area_files(session, aoi_geometry)


def _scan_area_files(session: ApiSession, aoi_geometry: dict) -> Iterator[dict]:
    """Client-side AOI membership: list the files, then intersect each with the AOI."""
    query = {"is_published": "true", "page_size": PAGE_SIZE}
    rows: list[dict] = []
    for page in _walk(session, "/api/v1/files/", query):
        rows.extend(page or [])

    points: dict[str, dict] = {}
    for page in _walk(session, "/api/v1/files/geojson/", query):
        for feature in (page or {}).get("features", []):
            props = feature.get("properties") or {}
            file_id = str(props.get("id") or feature.get("id"))
            points[file_id] = {
                "geometry": feature.get("geometry"),
                "can_download": props.get("can_download", True),
            }

    for row in rows:
        file_id = str(row["id"])
        point = points.get(file_id)
        if point is not None:
            file_geometry, can_download = point["geometry"], point["can_download"]
        elif row.get("has_location"):
            continue  # located, but SafeSight gave us no geometry for it
        else:
            file_geometry, can_download = _coverage_polygon(session, file_id), True
        if not geometry.intersects(file_geometry, aoi_geometry):
            continue
        yield {
            "id": file_id,
            "original_filename": row.get("original_filename"),
            "mime_type": row.get("mime_type"),
            "file_size": row.get("file_size"),
            "organization_name": row.get("organization_name"),
            "group_name": row.get("group_name"),
            "uploaded_at": row.get("uploaded_at"),
            "can_download": bool(can_download),
            "geometry": file_geometry,
        }


def download_file_to(session: ApiSession, file_id: str, dest: Path) -> str:
    """Stream a file to `dest` via a temp file in the same directory. Returns its media type."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    response = _request(session, "GET", f"/api/v1/files/{file_id}/download/", stream=True)
    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(dir=dest.parent, prefix=".part-", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            for chunk in response.iter_content(CHUNK):
                tmp.write(chunk)
        tmp_path.replace(dest)
    except requests.RequestException as exc:
        raise ServerUnavailable(f"Download interrupted: {exc.__class__.__name__}") from exc
    finally:
        response.close()
        if tmp_path is not None:
            with contextlib.suppress(FileNotFoundError):
                tmp_path.unlink()
    content_type = response.headers.get("Content-Type", "")
    return content_type.split(";")[0].strip().lower()

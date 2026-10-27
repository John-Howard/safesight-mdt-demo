"""Flask blueprint: pages, JSON API for the map UI, and cached file serving."""

import hmac
import secrets
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import (
    Blueprint,
    Response,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)

from mdt import cache, geometry, safesight_client, sync, token_store
from mdt.cache import InvalidIdError
from mdt.config import Config
from mdt.safesight_client import (
    ApiSession,
    AuthError,
    InvalidTokenError,
    NotFound,
    PermissionDenied,
    RateLimited,
    SafeSightError,
    ServerUnavailable,
)

bp = Blueprint("mdt", __name__)

INLINE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
    }
)
CSP = "; ".join(
    [
        "default-src 'self'",
        "img-src 'self' data: blob: https://tile.openstreetmap.org "
        "https://*.tile.openstreetmap.org",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]
)
STATUS_HTTP = {
    AuthError: 401,
    PermissionDenied: 403,
    NotFound: 404,
    RateLimited: 429,
    ServerUnavailable: 503,
}


def _config() -> Config:
    return current_app.config["MDT"]


def _csrf_token() -> str:
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


def _json_error(message: str, status: int, **extra) -> Response:
    response = jsonify({"error": message, **extra})
    response.status_code = status
    return response


def _cache_root() -> Path:
    """This user's private cache directory; users never share cached files."""
    return cache.user_root(_config().cache_dir, session.get("user_id"))


def _api_session() -> Optional[ApiSession]:
    tokens = token_store.get(session.get("token_id"))
    if tokens is None or not session.get("user_id"):
        return None
    cfg = _config()
    return ApiSession(
        base_url=cfg.safesight_base_url, tokens=tokens, verify=cfg.verify_tls, timeout=cfg.timeout
    )


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        api = _api_session()
        if api is None:
            if request.path.startswith(("/api/", "/files/")):
                return _json_error("Not signed in", 401)
            return redirect(url_for("mdt.login"))
        return view(api, *args, **kwargs)

    return wrapper


@bp.app_context_processor
def _inject() -> dict:
    return {"csrf_token": _csrf_token}


@bp.before_request
def _check_csrf() -> Optional[Response]:
    if request.method != "POST":
        return None
    sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf_token", "")
    if expected and hmac.compare_digest(sent, expected):
        return None
    return _json_error("CSRF token missing or invalid", 403)


@bp.after_app_request
def _security_headers(response: Response) -> Response:
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@bp.errorhandler(SafeSightError)
def _safesight_error(exc: SafeSightError) -> Response:
    status = next((code for cls, code in STATUS_HTTP.items() if isinstance(exc, cls)), 502)
    if isinstance(exc, AuthError):
        token_store.drop(session.pop("token_id", None))
    return _json_error(str(exc) or exc.__class__.__name__, status, offline=status == 503)


def _valid_aoi(aoi_id: str) -> str:
    try:
        return cache.valid_id(aoi_id)
    except InvalidIdError:
        raise NotFound("Not found") from None


# ---- pages ------------------------------------------------------------------


@bp.get("/")
@login_required
def index(api: ApiSession):
    return render_template("map.html", username=session.get("username", ""))


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method != "POST":
        return render_template("login.html", error=None)
    cfg = _config()
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    try:
        tokens = safesight_client.obtain_tokens(
            cfg.safesight_base_url, username, password, cfg.verify_tls, cfg.timeout
        )
    except AuthError:
        return render_template("login.html", error="Sign-in failed: check your credentials."), 401
    except ServerUnavailable:
        return render_template("login.html", error="SafeSight is unreachable."), 503
    except SafeSightError as exc:
        return render_template("login.html", error=f"Sign-in failed: {exc}"), 403
    try:
        user_id = safesight_client.user_id_from_access_token(tokens.access)
    except InvalidTokenError as exc:
        return render_template("login.html", error=f"Sign-in failed: {exc}"), 502
    token_store.drop(session.get("token_id"))
    csrf = secrets.token_urlsafe(32)
    session.clear()  # fresh session on privilege change
    session["csrf_token"] = csrf
    session["token_id"] = token_store.put(tokens)
    session["user_id"] = user_id
    session["username"] = username
    return redirect(url_for("mdt.index"))


@bp.post("/logout")
def logout():
    token_store.drop(session.get("token_id"))
    session.clear()
    return redirect(url_for("mdt.login"))


# ---- JSON API ---------------------------------------------------------------


def _file_view(entry: dict) -> dict:
    return {
        "id": entry["id"],
        "original_filename": entry.get("original_filename"),
        "mime_type": entry.get("mime_type"),
        "file_size": entry.get("file_size"),
        "status": entry["status"],
        "reason": entry.get("reason"),
        "feature": entry.get("feature"),
    }


def _cached_files(manifest: dict) -> list[dict]:
    return [_file_view(e) for e in manifest["files"].values()]


@bp.get("/api/areas")
@login_required
def areas(api: ApiSession):
    try:
        data = safesight_client.get_areas_geojson(api)
    except ServerUnavailable:
        data = cache.cached_areas_geojson(_cache_root())
        return jsonify({**data, "offline": True})
    return jsonify({**data, "offline": False})


@bp.get("/api/areas/<aoi_id>/files")
@login_required
def area_files(api: ApiSession, aoi_id: str):
    aoi_id = _valid_aoi(aoi_id)
    root = _cache_root()
    manifest = cache.load_manifest(root, aoi_id)
    try:
        area_feature = safesight_client.get_area_feature(api, aoi_id)
        items = list(safesight_client.iter_area_files(api, aoi_id, area_feature.get("geometry")))
    except ServerUnavailable:
        if manifest is None:
            raise
        return jsonify(_offline_payload(manifest))

    files = [_live_view(item, manifest, root, aoi_id) for item in items]
    area = {
        "name": (area_feature.get("properties") or {}).get("name"),
        "geometry": area_feature.get("geometry"),
    }
    return jsonify({"offline": False, "area": area, "files": files})


def _live_view(item: dict, manifest: Optional[dict], root: Path, aoi_id: str) -> dict:
    status, reason = "not_synced", None
    if cache.is_downloaded(root, manifest, aoi_id, item):
        status = "downloaded"
    elif not item.get("can_download", True):
        status, reason = "denied", "Your role cannot download this file"
    elif manifest is not None:
        previous = manifest["files"].get(item["id"])
        if previous and previous.get("status") in ("denied", "failed"):
            status, reason = previous["status"], previous.get("reason")
    return {
        "id": item["id"],
        "original_filename": item.get("original_filename"),
        "mime_type": item.get("mime_type"),
        "file_size": item.get("file_size"),
        "status": status,
        "reason": reason,
        "feature": geometry.file_feature(item),
    }


def _offline_payload(manifest: dict) -> dict:
    return {"offline": True, "area": manifest.get("area"), "files": _cached_files(manifest)}


@bp.get("/api/areas/<aoi_id>/cached")
@login_required
def area_cached(api: ApiSession, aoi_id: str):
    manifest = cache.load_manifest(_cache_root(), _valid_aoi(aoi_id))
    if manifest is None:
        raise NotFound("Area has not been synced")
    return jsonify(_offline_payload(manifest))


@bp.post("/api/areas/<aoi_id>/sync")
@login_required
def area_sync(api: ApiSession, aoi_id: str):
    cfg = _config()
    summary = sync.sync_area(api, _valid_aoi(aoi_id), _cache_root(), cfg.max_sync_bytes)
    return jsonify(summary)


# ---- cached file bytes ------------------------------------------------------


@bp.get("/files/<aoi_id>/<file_id>")
@login_required
def cached_file(api: ApiSession, aoi_id: str, file_id: str):
    try:
        root = _cache_root()
        manifest = cache.load_manifest(root, aoi_id)
        path = cache.file_path(root, aoi_id, file_id)
        file_id = cache.valid_id(file_id)
    except InvalidIdError:
        return _json_error("Not found", 404)
    entry = (manifest or {"files": {}})["files"].get(file_id)
    if not entry or entry.get("status") != "downloaded" or not path.is_file():
        return _json_error("Not found", 404)

    mime = (entry.get("mime_type") or "").split(";")[0].strip().lower()
    name = entry.get("original_filename") or file_id
    if mime in INLINE_TYPES:
        response = send_file(path, mimetype=mime, as_attachment=False, download_name=name)
    else:
        response = send_file(
            path, mimetype="application/octet-stream", as_attachment=True, download_name=name
        )
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response

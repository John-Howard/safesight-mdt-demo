import os
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


class ConfigError(Exception):
    """Raised when the environment does not describe a usable configuration."""


@dataclass(frozen=True)
class Config:
    safesight_base_url: str
    cache_dir: Path
    secret_key: str
    verify_tls: bool
    timeout: float
    max_sync_bytes: int


_FALSE = {"0", "false", "no", "off"}


def _number(env: Mapping[str, str], name: str, default: str, cast):
    raw = env.get(name, default)
    try:
        return cast(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


def from_env(env: Optional[Mapping[str, str]] = None) -> Config:
    if env is None:
        env = os.environ
    base_url = env.get("SAFESIGHT_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        raise ConfigError("SAFESIGHT_BASE_URL is required (e.g. http://localhost:10000)")
    return Config(
        safesight_base_url=base_url,
        cache_dir=Path(env.get("MDT_CACHE_DIR", "./mdt-cache")),
        secret_key=env.get("MDT_SECRET_KEY") or secrets.token_urlsafe(32),
        verify_tls=env.get("SAFESIGHT_VERIFY_TLS", "true").strip().lower() not in _FALSE,
        timeout=_number(env, "SAFESIGHT_TIMEOUT", "30", float),
        max_sync_bytes=_number(env, "MDT_MAX_SYNC_BYTES", str(500 * 1024 * 1024), int),
    )

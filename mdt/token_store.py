"""Thread-safe in-memory map of opaque session id to SafeSight tokens.

Tokens are never persisted, so a restart signs every user out.
"""

import secrets
import threading
from typing import Optional

from mdt.safesight_client import Tokens

_lock = threading.Lock()
_store: dict[str, Tokens] = {}


def put(tokens: Tokens) -> str:
    token_id = secrets.token_urlsafe(32)
    with _lock:
        _store[token_id] = tokens
    return token_id


def get(token_id: Optional[str]) -> Optional[Tokens]:
    if not token_id:
        return None
    with _lock:
        return _store.get(token_id)


def drop(token_id: Optional[str]) -> None:
    if not token_id:
        return
    with _lock:
        _store.pop(token_id, None)


def clear() -> None:
    with _lock:
        _store.clear()

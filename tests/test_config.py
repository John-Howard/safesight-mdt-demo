from pathlib import Path

import pytest

from mdt import config as config_mod
from mdt.config import ConfigError


def test_requires_base_url():
    with pytest.raises(ConfigError):
        config_mod.from_env({})


def test_defaults():
    cfg = config_mod.from_env({"SAFESIGHT_BASE_URL": "http://x.test/"})
    assert cfg.safesight_base_url == "http://x.test"
    assert cfg.cache_dir == Path("./mdt-cache")
    assert cfg.verify_tls is True
    assert cfg.timeout == 30.0
    assert cfg.max_sync_bytes == 500 * 1024 * 1024
    assert cfg.secret_key  # generated when absent


def test_overrides():
    cfg = config_mod.from_env(
        {
            "SAFESIGHT_BASE_URL": "https://s.test",
            "MDT_CACHE_DIR": "/tmp/c",
            "MDT_SECRET_KEY": "k",
            "SAFESIGHT_VERIFY_TLS": "false",
            "SAFESIGHT_TIMEOUT": "5",
            "MDT_MAX_SYNC_BYTES": "1000",
        }
    )
    assert cfg.cache_dir == Path("/tmp/c")
    assert cfg.secret_key == "k"
    assert cfg.verify_tls is False
    assert cfg.timeout == 5.0
    assert cfg.max_sync_bytes == 1000


def test_bad_number_raises():
    with pytest.raises(ConfigError):
        config_mod.from_env({"SAFESIGHT_BASE_URL": "http://x", "SAFESIGHT_TIMEOUT": "soon"})

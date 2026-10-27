from typing import Optional

from flask import Flask

from mdt import config as config_mod
from mdt.config import Config
from mdt.routes import bp


def create_app(config: Optional[Config] = None) -> Flask:
    """App factory. With no argument, configuration is read from environment variables."""
    if config is None:
        config = config_mod.from_env()
    app = Flask(__name__)
    app.config["MDT"] = config
    app.config["SECRET_KEY"] = config.secret_key
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.register_blueprint(bp)
    return app

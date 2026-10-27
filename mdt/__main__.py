import os

from mdt.app import create_app


def main() -> None:
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", "10100")))


if __name__ == "__main__":
    main()

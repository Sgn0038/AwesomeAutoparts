"""SQLite connection helpers for the Awesome Autoparts API."""

import hashlib
import os
import sqlite3
from pathlib import Path

from flask import g

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = Path(
    os.environ.get("AUTOPARTS_DB", PROJECT_ROOT / "AWESOME_AUTOPARTS.db")
)


def get_db() -> sqlite3.Connection:
    """Return one connection per request, stored on Flask's `g` object."""
    if "db" not in g:
        if not DATABASE_PATH.exists():
            raise FileNotFoundError(f"Database not found at {DATABASE_PATH}")
        g.db = sqlite3.connect(DATABASE_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exception=None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def query_all(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in get_db().execute(sql, params).fetchall()]


def query_one(sql: str, params: tuple = ()) -> dict | None:
    row = get_db().execute(sql, params).fetchone()
    return dict(row) if row else None


def hash_password(password: str) -> str:
    """Match the 64-char hex SHA-256 format already stored in the sample data."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()

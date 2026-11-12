"""Google OAuth credentials for ClientScope (the client's own Google account, Drive file scope).

Where the token comes from, in order:
  1. GOOGLE_TOKEN_FILE, or the default .secrets/token.json next to this file, if that file exists (local runs).
  2. GOOGLE_TOKEN_JSON: the same token JSON pasted into an environment variable (hosted runs, e.g. Render).
The token JSON holds the refresh token plus client_id and client_secret, so google-auth refreshes it on its own.
Nothing here prints or logs any part of the token.
"""
import json, os
from pathlib import Path

from google.oauth2.credentials import Credentials

ROOT = Path(__file__).resolve().parent
SCOPES = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets"]


def token_file() -> Path:
    return Path(os.environ.get("GOOGLE_TOKEN_FILE") or ROOT / ".secrets" / "token.json")


def load_credentials() -> Credentials:
    f = token_file()
    if f.is_file():
        return Credentials.from_authorized_user_file(str(f))
    raw = os.environ.get("GOOGLE_TOKEN_JSON", "").strip()
    if raw:
        return Credentials.from_authorized_user_info(json.loads(raw))
    raise RuntimeError("No Google token: set GOOGLE_TOKEN_JSON or create .secrets/token.json (see auth_start.py)")


def secret_values() -> list[str]:
    """Secret strings from GOOGLE_TOKEN_JSON, so log redaction can hide them. Never returned to a client."""
    try:
        d = json.loads(os.environ.get("GOOGLE_TOKEN_JSON", "") or "{}")
    except ValueError:
        return []
    return [str(d[k]) for k in ("refresh_token", "client_secret", "token") if d.get(k) and len(str(d[k])) >= 16]

#!/usr/bin/env bash
# Run the ClientScope dashboard locally. Keys come from the environment only:
#   CCD_CLIENT_PRIVATE_KEY, CCD_SPONSOR_PRIVATE_KEY (and .secrets/token.json for Google).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CCD_CLIENT_PRIVATE_KEY:?set CCD_CLIENT_PRIVATE_KEY}" "${CCD_SPONSOR_PRIVATE_KEY:?set CCD_SPONSOR_PRIVATE_KEY}"
(cd dashboard/web && npm install --silent && npx vite build)
exec .venv/bin/uvicorn dashboard.api.app:app --host 127.0.0.1 --port "${PORT:-8000}"

#!/usr/bin/env bash

# Start ArrowMatch on a server without creating a project-local virtualenv.

set -Eeuo pipefail

BASE_DIR="/home/workouts/match/www"
APP_DIR="$BASE_DIR/backend"
REQ_FILE="$APP_DIR/requirements.txt"

PYTHON_BIN="${PYTHON_BIN:-python3}"
HOST="${IP:-0.0.0.0}"
PORT="${PORT:-8000}"
WORKERS="${WORKERS:-2}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "Backend directory not found: $APP_DIR" >&2
  exit 1
fi

if [[ ! -f "$REQ_FILE" ]]; then
  echo "Requirements file not found: $REQ_FILE" >&2
  exit 1
fi

echo "Installing ArrowMatch dependencies for the current user..."
"$PYTHON_BIN" -m pip install --user --no-cache-dir -r "$REQ_FILE"

cd "$APP_DIR"

echo "ArrowMatch server starting on $HOST:$PORT..."
exec "$PYTHON_BIN" -m uvicorn main:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers "$WORKERS" \
  --no-access-log

#!/usr/bin/env bash
# start.sh — Start the ArrowMatch backend server
# Run from the project root: ./start.sh
# Or from backend/: ../start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

cd "$BACKEND_DIR"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
  echo "Creating virtual environment…"
  python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install/upgrade dependencies
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo ""
echo "  ArrowMatch server starting…"
echo "  UI:       http://localhost:8000/"
echo "  API docs: http://localhost:8000/docs"
echo ""

uvicorn main:app --host 0.0.0.0 --port 8000 --reload

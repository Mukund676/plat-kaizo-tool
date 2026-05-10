#!/usr/bin/env bash
# Run and verify script for macOS / Linux and Git Bash on Windows.
# Usage: `scripts/run-dev.sh` from anywhere; it resolves the repo root automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "Repository root: $REPO_ROOT"

command -v python >/dev/null 2>&1 || { echo "python not found. Install Python 3.11+." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found. Install Node.js (with npm)." >&2; exit 1; }
command -v dotnet >/dev/null 2>&1 || echo "Warning: dotnet not found. Install .NET runtime if pythonnet needs it."

PY_VERSION="$(python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
case "$PY_VERSION" in
  3.11|3.12) ;;
  *)
    echo "Unsupported Python version: $PY_VERSION. Use Python 3.11 or 3.12; Python 3.13+ is not supported by this backend's pythonnet dependency." >&2
    exit 1
    ;;
esac

if [ ! -f backend/requirements.txt ]; then
  echo "Missing backend/requirements.txt" >&2
  exit 1
fi

if [ ! -f frontend/package.json ]; then
  echo "Missing frontend/package.json" >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "Creating virtualenv .venv..."
  python -m venv .venv
fi

activate_venv() {
  if [ -f .venv/bin/activate ]; then
    # Native Unix-style venv layout.
    source .venv/bin/activate
    return 0
  fi

  if [ -f .venv/Scripts/activate ]; then
    # Windows Git Bash / MSYS layout.
    source .venv/Scripts/activate
    return 0
  fi

  echo "Could not find a virtualenv activation script under .venv/bin or .venv/Scripts." >&2
  exit 1
}

echo "Activating venv and installing backend dependencies..."
activate_venv
python -m pip install --upgrade pip
pip install -r backend/requirements.txt

if [ ! -f data/kaizo_data.json ] || [ ! -f data/trainer_db.json ]; then
  echo "Generating data files..."
  python backend/build_database.py
else
  echo "Data files present."
fi

echo "Starting backend (logs -> backend.log)"
python backend/app.py > backend.log 2>&1 &
echo $! > .backend.pid

echo "Starting frontend (logs -> frontend.log)"
cd frontend
npm install
npm run dev > ../frontend.log 2>&1 &
echo $! > ../.frontend.pid

echo ""
echo "================================"
echo "  Setup complete!"
echo "================================"
echo ""
echo "Frontend:  http://localhost:5173"
echo "Backend:   http://localhost:5000/api/health"
echo ""
echo "Logs:"
echo "  Backend: tail -f backend.log"
echo "  Frontend: tail -f frontend/dev.log"
echo ""
echo "To stop:"
echo "  kill \$(cat .backend.pid .frontend.pid)"
echo ""

wait

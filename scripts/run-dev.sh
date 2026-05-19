#!/usr/bin/env bash
# Run and verify script for macOS / Linux and Git Bash on Windows.
# Usage: `scripts/run-dev.sh` from anywhere; it resolves the repo root automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "Repository root: $REPO_ROOT"

cleanup_on_error() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    if [ -f .backend.pid ]; then
      local backend_pid
      backend_pid="$(cat .backend.pid 2>/dev/null || true)"
      if [ -n "${backend_pid:-}" ] && kill -0 "$backend_pid" 2>/dev/null; then
        kill "$backend_pid" 2>/dev/null || true
      fi
    fi
    if [ -f .frontend.pid ]; then
      local frontend_pid
      frontend_pid="$(cat .frontend.pid 2>/dev/null || true)"
      if [ -n "${frontend_pid:-}" ] && kill -0 "$frontend_pid" 2>/dev/null; then
        kill "$frontend_pid" 2>/dev/null || true
      fi
    fi
  fi
}

trap cleanup_on_error EXIT INT TERM

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

if [ ! -f backend/app.py ]; then
  echo "Missing backend/app.py" >&2
  exit 1
fi

if [ ! -f frontend/package.json ]; then
  echo "Missing frontend/package.json" >&2
  exit 1
fi

# Remove stale pid files from prior runs.
for pidfile in .backend.pid .frontend.pid; do
  if [ -f "$pidfile" ]; then
    old_pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -z "${old_pid:-}" ] || ! kill -0 "$old_pid" 2>/dev/null; then
      rm -f "$pidfile"
    else
      echo "A process from a previous run appears active (PID $old_pid from $pidfile)." >&2
      echo "Stop it first or remove $pidfile if stale." >&2
      exit 1
    fi
  fi
done

find_venv_python() {
  if [ -x .venv/bin/python ]; then
    echo .venv/bin/python
    return 0
  fi

  if [ -x .venv/Scripts/python.exe ]; then
    echo .venv/Scripts/python.exe
    return 0
  fi

  return 1
}

ensure_venv_python() {
  local venv_python

  if venv_python="$(find_venv_python)"; then
    echo "$venv_python"
    return 0
  fi

  echo "Rebuilding virtualenv .venv..."
  rm -rf .venv
  python -m venv .venv

  if venv_python="$(find_venv_python)"; then
    echo "$venv_python"
    return 0
  fi

  echo "Could not locate a usable Python executable inside .venv after recreating it." >&2
  exit 1
}

VENV_PYTHON="$(ensure_venv_python)"

echo "Using virtualenv Python: $VENV_PYTHON"
echo "Installing backend dependencies..."
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r backend/requirements.txt

if [ ! -f data/kaizo_data.json ] || [ ! -f data/trainer_db.json ]; then
  echo "Generating data files..."
  "$VENV_PYTHON" backend/build_database.py
else
  echo "Data files present."
fi

echo "Starting backend (logs -> backend.log)"
"$VENV_PYTHON" backend/app.py > backend.log 2>&1 &
echo $! > .backend.pid

echo "Installing frontend dependencies..."
cd frontend
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "Starting frontend (logs -> frontend.log)"
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
echo "  Frontend: tail -f frontend.log"
echo ""
echo "To stop:"
echo "  kill \$(cat .backend.pid .frontend.pid)"
echo ""

wait

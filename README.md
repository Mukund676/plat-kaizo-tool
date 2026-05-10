# plat-kaizo-tool

Platinum Kaizo team parser + battle helper app.

- **Backend**: Flask API that parses Gen 4 `.sav` files and returns party/box data
- **Frontend**: React + Vite UI that uploads saves and renders calculator/router views

## Requirements

- Python 3.11 or 3.12
- Node.js 20+ and npm
- .NET runtime (required by `pythonnet` to load `backend/PKHeX.Core.dll`)

Python 3.13+ is not supported here because `pythonnet` does not build cleanly in this project setup.

This README shows commands you can run from the repository root. Replace `python` with the full path to your Python executable if needed.

**Quickstart — Windows (PowerShell)**

1. Open PowerShell in the repository root (where this README is).

2. Create and activate a virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r backend/requirements.txt
```

3. Generate required data files (run once after cloning or when spreadsheet data changes):

```powershell
python backend\build_database.py
```

This produces/updates `data/kaizo_data.json` and `data/trainer_db.json`.

4. Run the backend API:

```powershell
python backend\app.py
```

By default the backend listens at `http://localhost:5000`.

Health check (PowerShell):

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

Expected JSON: `{"status":"ok"}`

5. Start the frontend (in a separate terminal):

```powershell
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`).

6. End-to-end usage

- Keep backend running at `http://localhost:5000` and frontend running via Vite.
- In the UI, upload a Gen 4 `.sav` file and confirm parsed `party`/`boxes` data appear.

You can also POST a save directly to the API (PowerShell/curl):

```powershell
curl -X POST -F "save=@C:\absolute\path\to\your\savefile.sav" http://localhost:5000/api/upload-save
```

The response should include `party` and `boxes` arrays.

**Quickstart — macOS / Linux / Git Bash (bash)**

On Windows, open Git Bash and run the Bash launcher from the repository root.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r backend/requirements.txt
python backend/build_database.py
python backend/app.py
```

If you use the helper script, run `scripts/run-dev.sh`; it now auto-detects the venv activation script for both Unix and Windows Git Bash layouts.

Frontend (bash):

```bash
cd frontend
npm install
npm run dev
```

## Troubleshooting

- Module import errors: re-activate the venv and reinstall `backend/requirements.txt`.
- `pythonnet` / .NET errors: install or repair the host .NET runtime and restart the backend.
- Frontend cannot reach backend: ensure backend is running on port `5000` and no firewall blocks the port.
- Upload fails with “No file provided”: ensure the multipart form key is named `save` when using curl or clients.

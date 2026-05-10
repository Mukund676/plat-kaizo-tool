<#
Run and verify script for Windows (PowerShell).

Usage: run from repository root or run this script directly.
It will:
- verify `python`, `node`, and `dotnet` are available
- create and activate a `.venv` if missing
- install backend requirements
- generate data files if missing
- launch backend and frontend in new PowerShell windows
#>

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

Write-Host "Repository root: $RepoRoot"

function Check-Command($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    return $true
}

if (-not (Check-Command python)) {
    Write-Error "python not found in PATH. Install Python 3.11+ and ensure 'python' is on PATH."
    exit 1
}

if (-not (Check-Command npm)) {
    Write-Error "npm not found in PATH. Install Node.js (with npm) and ensure 'npm' is on PATH."
    exit 1
}

if (-not (Check-Command dotnet)) {
    Write-Warning "dotnet not found. If you see pythonnet / .NET errors when running the backend, install the .NET runtime."
}

$pythonVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($pythonVersion -notin @('3.11', '3.12')) {
    Write-Error "Unsupported Python version: $pythonVersion. Use Python 3.11 or 3.12; Python 3.13+ is not supported by this backend's pythonnet dependency."
    exit 1
}

$backendReq = Join-Path $RepoRoot 'backend\requirements.txt'
if (-not (Test-Path $backendReq)) {
    Write-Error "Missing backend requirements file: $backendReq"
    exit 1
}

$frontendPkg = Join-Path $RepoRoot 'frontend\package.json'
if (-not (Test-Path $frontendPkg)) {
    Write-Error "Missing frontend package.json: $frontendPkg"
    exit 1
}

if (-not (Test-Path (Join-Path $RepoRoot '.venv'))) {
    Write-Host "Creating virtual environment .venv..."
    python -m venv .venv
}

Write-Host "Activating virtual environment and installing backend dependencies..."
. (Join-Path $RepoRoot '.venv\Scripts\Activate.ps1')
python -m pip install --upgrade pip
pip install -r $backendReq

$data1 = Join-Path $RepoRoot 'data\kaizo_data.json'
$data2 = Join-Path $RepoRoot 'data\trainer_db.json'
if (-not (Test-Path $data1) -or -not (Test-Path $data2)) {
    Write-Host "Data files missing; generating with backend/build_database.py..."
    python backend\build_database.py
} else {
    Write-Host "Data files present."
}

Write-Host "Starting backend in a new PowerShell window..."
$backendCmd = "cd '$RepoRoot'; . '$RepoRoot\\.venv\\Scripts\\Activate.ps1'; python backend\\app.py"
Start-Process -FilePath powershell -ArgumentList "-NoExit","-Command",$backendCmd

Write-Host "Starting frontend in a new PowerShell window (will run npm install then dev server)..."
$frontendCmd = "cd '$RepoRoot\\frontend'; npm install; npm run dev"
Start-Process -FilePath powershell -ArgumentList "-NoExit","-Command",$frontendCmd

Write-Host ""
Write-Host "================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""
Write-Host "Frontend:  http://localhost:5173"
Write-Host "Backend:   http://localhost:5000/api/health"
Write-Host ""
Write-Host "Check the new PowerShell windows for backend and frontend logs."
Write-Host ""
Write-Host "To check health status (PowerShell):"
Write-Host "  Invoke-RestMethod http://localhost:5000/api/health"
Write-Host "" 

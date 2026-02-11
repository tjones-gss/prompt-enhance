# setup.ps1 -- One-command setup for Prompt Enhancer (Windows PowerShell)
# Usage: .\setup.ps1

$ErrorActionPreference = "Stop"

# Always run from the project root (wherever the script lives)
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Prompt Enhancer - Team Setup (Windows) " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -------------------------------------------------------------------------
# 1. Check Node.js >= 18
# -------------------------------------------------------------------------
Write-Host "[1/6] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = (node --version 2>$null)
    if (-not $nodeVersion) { throw "not found" }
    $major = [int]($nodeVersion -replace '^v','').Split('.')[0]
    if ($major -lt 18) {
        Write-Host "  ERROR: Node.js >= 18 required (found $nodeVersion)." -ForegroundColor Red
        Write-Host "  Install from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# -------------------------------------------------------------------------
# 2. Install Cursor CLI (agent) if not present
# -------------------------------------------------------------------------
Write-Host "[2/6] Checking Cursor CLI (agent)..." -ForegroundColor Yellow
$agentInstalled = $false
try {
    $agentVer = & "$env:LOCALAPPDATA\cursor-agent\agent.cmd" --version 2>$null
    if ($agentVer) { $agentInstalled = $true }
} catch {}
if (-not $agentInstalled) {
    try {
        $agentVer = (agent --version 2>$null)
        if ($agentVer) { $agentInstalled = $true }
    } catch {}
}

if ($agentInstalled) {
    Write-Host "  OK: agent $agentVer" -ForegroundColor Green
} else {
    Write-Host "  Cursor CLI not found. Installing..." -ForegroundColor Yellow
    try {
        Invoke-RestMethod 'https://cursor.com/install?win32=true' | Invoke-Expression
        Write-Host "  Installed successfully." -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: Could not auto-install. Install manually:" -ForegroundColor Red
        Write-Host "    irm 'https://cursor.com/install?win32=true' | iex" -ForegroundColor Red
        Write-Host "  Continuing without CLI (template fallback will be used)..." -ForegroundColor Yellow
    }
}

# -------------------------------------------------------------------------
# 3. Check Cursor CLI authentication
# -------------------------------------------------------------------------
Write-Host "[3/6] Checking Cursor CLI authentication..." -ForegroundColor Yellow
$agentCmd = $null
if (Test-Path "$env:LOCALAPPDATA\cursor-agent\agent.cmd") {
    $agentCmd = "$env:LOCALAPPDATA\cursor-agent\agent.cmd"
} else {
    try { $agentCmd = (Get-Command agent -ErrorAction SilentlyContinue).Source } catch {}
}

if ($agentCmd) {
    $status = & $agentCmd status 2>&1 | Out-String
    if ($status -match "Not logged in") {
        Write-Host "  Cursor CLI is not logged in." -ForegroundColor Yellow
        Write-Host "  Running 'agent login' -- a browser window will open." -ForegroundColor Yellow
        Write-Host ""
        & $agentCmd login
        Write-Host ""
        # Verify after login
        $status2 = & $agentCmd status 2>&1 | Out-String
        if ($status2 -match "Not logged in") {
            Write-Host "  WARNING: Still not logged in. You can run 'agent login' later." -ForegroundColor Red
        } else {
            Write-Host "  Authenticated successfully." -ForegroundColor Green
        }
    } else {
        Write-Host "  OK: Already authenticated." -ForegroundColor Green
    }
} else {
    Write-Host "  SKIP: Cursor CLI not available." -ForegroundColor Yellow
}

# -------------------------------------------------------------------------
# 4. Install npm dependencies
# -------------------------------------------------------------------------
Write-Host "[4/6] Installing npm dependencies..." -ForegroundColor Yellow
npm run setup
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm run setup failed." -ForegroundColor Red
    exit 1
}
Write-Host "  OK: Dependencies installed." -ForegroundColor Green

# -------------------------------------------------------------------------
# 5. Build the VSIX package
# -------------------------------------------------------------------------
Write-Host "[5/6] Building VSIX package..." -ForegroundColor Yellow
npm run package
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm run package failed." -ForegroundColor Red
    exit 1
}
Write-Host "  OK: VSIX built." -ForegroundColor Green

# -------------------------------------------------------------------------
# 6. Install the extension into Cursor
# -------------------------------------------------------------------------
Write-Host "[6/6] Installing extension into Cursor..." -ForegroundColor Yellow
$vsix = Get-ChildItem -Path "build\*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    Write-Host "  ERROR: No .vsix file found in build/." -ForegroundColor Red
    exit 1
}

$installed = $false
# Try 'cursor' CLI first
try {
    cursor --install-extension $vsix.FullName --force 2>$null
    if ($LASTEXITCODE -eq 0) { $installed = $true }
} catch {}

# Fallback to 'code' CLI
if (-not $installed) {
    try {
        code --install-extension $vsix.FullName --force 2>$null
        if ($LASTEXITCODE -eq 0) { $installed = $true }
    } catch {}
}

if ($installed) {
    Write-Host "  OK: Extension installed ($($vsix.Name))." -ForegroundColor Green
} else {
    Write-Host "  Could not auto-install. Install manually:" -ForegroundColor Yellow
    Write-Host "    1. Open Cursor/VS Code" -ForegroundColor Yellow
    Write-Host "    2. Ctrl+Shift+P > 'Extensions: Install from VSIX...'" -ForegroundColor Yellow
    Write-Host "    3. Select: $($vsix.FullName)" -ForegroundColor Yellow
}

# -------------------------------------------------------------------------
# Done
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart Cursor if it's running" -ForegroundColor White
Write-Host "  2. Open a project and try:" -ForegroundColor White
Write-Host "     - Ctrl+Shift+P > 'Prompt Enhancer: Open Panel'" -ForegroundColor White
Write-Host "     - Type '@enhance fix the login bug' in Chat" -ForegroundColor White
Write-Host "  3. (Optional) Set up the MCP server -- see README.md" -ForegroundColor White
Write-Host ""

<#
.SYNOPSIS
    Hosts the dnb-cruises Express server locally.
.DESCRIPTION
    This script sets up environment variables, ensures dependencies are installed,
    checks for port conflicts, starts the Node.js Express server, and opens the
    web application in the default browser.
.PARAMETER Port
    The port number on which to run the Express server. Defaults to 3000.
.PARAMETER Install
    Force runs 'npm install' before starting the service.
.PARAMETER LaunchBrowser
    If switch is present, opens the browser automatically once the server is online. Defaults to true.
.EXAMPLE
    .\host-service.ps1
.EXAMPLE
    .\host-service.ps1 -Port 8080 -LaunchBrowser:$false
#>

[CmdletBinding()]
param (
    [int]$Port = 3000,
    [switch]$Install,
    [bool]$LaunchBrowser = $true
)

$Host.UI.RawUI.WindowTitle = "dnb-cruises Service Host"

function Write-Header {
    Write-Host ""
    Write-Host " 🚢  dnb-cruises - Service Host " -BackgroundColor DarkBlue -ForegroundColor White
    Write-Host " =======================================" -ForegroundColor Cyan
}

function Write-Info ([string]$msg) {
    Write-Host " [INFO] $msg" -ForegroundColor Cyan
}

function Write-Success ([string]$msg) {
    Write-Host " [SUCCESS] $msg" -ForegroundColor Green
}

function Write-WarningMsg ([string]$msg) {
    Write-Host " [WARNING] $msg" -ForegroundColor Yellow
}

function Write-ErrorMsg ([string]$msg) {
    Write-Host " [ERROR] $msg" -ForegroundColor Red
}

Clear-Host
Write-Header

# 1. Check if Node.js is installed
Write-Info "Checking for Node.js installation..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-ErrorMsg "Node.js is not installed or not in your PATH. Please install Node.js (version >= 18) and try again."
    Exit 1
}
$nodeVersion = & node -v
Write-Success "Found Node.js version: $nodeVersion"

# Navigate to the script's directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($scriptDir) {
    Set-Location $scriptDir
}
Write-Info "Working directory: $pwd"

# 2. Check and install dependencies
$nodeModulesPath = Join-Path $pwd "node_modules"
if ($Install -or -not (Test-Path $nodeModulesPath)) {
    Write-Info "Installing dependencies (npm install)... This may take a moment."
    try {
        & npm.cmd install
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Dependencies installed successfully."
        } else {
            Write-ErrorMsg "Failed to install dependencies (npm install returned code $LASTEXITCODE)."
            Exit 1
        }
    } catch {
        Write-ErrorMsg "An error occurred while running 'npm install': $_"
        Exit 1
    }
} else {
    Write-Info "Dependencies checked (node_modules exists)."
}

# 3. Check if the Port is already in use
Write-Info "Checking port $Port availability..."
$portUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if ($portUse) {
    $conflictingPid = $portUse[0].OwningProcess
    $processName = (Get-Process -Id $conflictingPid -ErrorAction SilentlyContinue).ProcessName
    Write-WarningMsg "Port $Port is already in use by process: $processName (PID: $conflictingPid)."
    
    $choice = Read-Host "Would you like to terminate this process? (Y/N) or enter a different Port number"
    if ($choice -match '^[yY]') {
        Write-Info "Terminating process $conflictingPid..."
        Stop-Process -Id $conflictingPid -Force
        Start-Sleep -Seconds 1
        Write-Success "Process terminated."
    } elseif ($choice -match '^\d+$') {
        $Port = [int]$choice
        Write-Info "Switching to port $Port."
    } else {
        Write-WarningMsg "Continuing anyway. The server start may fail if port is not freed."
    }
} else {
    Write-Success "Port $Port is available."
}

# Set Port Environment Variable
$env:PORT = $Port

# 4. Start the Service
Write-Info "Starting service on http://localhost:$Port..."
Write-Host " Press [Ctrl + C] to stop the service." -ForegroundColor Magenta
Write-Host " ---------------------------------------" -ForegroundColor Gray

if ($LaunchBrowser) {
    # Launch browser after a short delay to let the server start
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 2
        Start-Process "http://localhost:$using:Port"
    } | Out-Null
}

# Run the server
node server.js

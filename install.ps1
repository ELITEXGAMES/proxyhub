# 🚀 Antigravity Proxy Windows Turnkey Installer
# Usage:
#   irm https://raw.githubusercontent.com/ELITEXGAMES/proxyhub/main/install.ps1 | iex
# or:
#   powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "  🚀 Antigravity Proxy CLI Installer (Windows)" -ForegroundColor Cyan
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js
Write-Host "🔍 Checking Node.js installation..." -ForegroundColor Yellow
try {
    $nodeVer = (node -v).Trim()
    Write-Host "   ✅ Node.js detected: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "   Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# 2. Check Git
Write-Host "🔍 Checking Git installation..." -ForegroundColor Yellow
try {
    $gitVer = (git --version).Trim()
    Write-Host "   ✅ Git detected: $gitVer" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️ Git not found in PATH. Make sure Git is installed." -ForegroundColor Yellow
}

# 3. Target Install Directory
$installDir = "$HOME\.antigravity-proxy-app"
if (Test-Path "$PSScriptRoot\package.json") {
    $installDir = $PSScriptRoot
    Write-Host "📦 Installing from local directory: $installDir" -ForegroundColor Cyan
} else {
    Write-Host "📥 Cloning latest repository to $installDir..." -ForegroundColor Cyan
    if (Test-Path $installDir) {
        Remove-Item -Recurse -Force $installDir
    }
    # Default repo URL (can be customized or passed as parameter)
    $repoUrl = if ($args[0]) { $args[0] } else { "https://github.com/ELITEXGAMES/proxyhub.git" }
    try {
        git clone --depth 1 $repoUrl $installDir
    } catch {
        Write-Host "   Downloading latest release directly from GitHub..." -ForegroundColor Cyan
        $zipPath = "$env:TEMP\proxyhub.zip"
        $extractPath = "$env:TEMP\proxyhub-extract"
        Invoke-WebRequest -Uri "https://github.com/ELITEXGAMES/proxyhub/archive/refs/heads/main.zip" -OutFile $zipPath
        Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
        Move-Item -Path "$extractPath\proxyhub-main" -Destination $installDir -Force
        Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $extractPath -ErrorAction SilentlyContinue
    }
}

Set-Location $installDir

# 4. Install dependencies & register CLI globally
Write-Host "📦 Installing dependencies (npm install)..." -ForegroundColor Yellow
npm install --omit=dev

Write-Host "🔗 Linking CLI globally (npm link)..." -ForegroundColor Yellow
npm link

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host "  🎉 Installation Complete!" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "You can now run any of the following commands from ANY terminal:" -ForegroundColor White
Write-Host ""
Write-Host "  anti gravity proxy start -d -o   # Start daemon & open dashboard" -ForegroundColor Cyan
Write-Host "  anti gravity proxy status        # Check status & connected accounts" -ForegroundColor Cyan
Write-Host "  anti gravity proxy update        # Pull latest git updates anytime" -ForegroundColor Cyan
Write-Host "  anti gravity proxy stop          # Stop proxy" -ForegroundColor Cyan
Write-Host ""


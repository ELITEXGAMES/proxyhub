#!/usr/bin/env bash
# 🚀 Antigravity Proxy Linux/macOS Turnkey Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ELITEXGAMES/proxyhub/main/install.sh | bash

set -e

echo ""
echo "============================================================="
echo "  🚀 Antigravity Proxy CLI Installer (macOS/Linux)"
echo "============================================================="
echo ""

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first (https://nodejs.org)."
    exit 1
fi
echo "✅ Node.js detected: $(node -v)"

# 2. Check Git
if ! command -v git >/dev/null 2>&1; then
    echo "❌ Git is not installed. Please install Git first."
    exit 1
fi
echo "✅ Git detected: $(git --version)"

# 3. Target Install Directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ]; then
    INSTALL_DIR="$SCRIPT_DIR"
    echo "📦 Installing from local directory: $INSTALL_DIR"
else
    INSTALL_DIR="$HOME/.antigravity-proxy-app"
    REPO_URL="${1:-https://github.com/ELITEXGAMES/proxyhub.git}"
    echo "📥 Downloading latest release to $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    if command -v git >/dev/null 2>&1; then
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    else
        echo "📥 Downloading ZIP from GitHub..."
        curl -fsSL https://github.com/ELITEXGAMES/proxyhub/archive/refs/heads/main.zip -o /tmp/proxyhub.zip
        unzip -q /tmp/proxyhub.zip -d /tmp/proxyhub-extract
        mv /tmp/proxyhub-extract/proxyhub-main "$INSTALL_DIR"
        rm -rf /tmp/proxyhub.zip /tmp/proxyhub-extract
    fi
fi

cd "$INSTALL_DIR"

# 4. Install dependencies & link globally
echo "📦 Installing dependencies (npm install)..."
npm install --omit=dev

echo "🔗 Linking CLI globally (npm link)..."
npm link

echo ""
echo "============================================================="
echo "  🎉 Installation Complete!"
echo "============================================================="
echo ""
echo "You can now run any of the following commands from ANY terminal:"
echo ""
echo "  anti gravity proxy start -d -o   # Start daemon & open dashboard"
echo "  anti gravity proxy status        # Check status & connected accounts"
echo "  anti gravity proxy update        # Pull latest git updates anytime"
echo "  anti gravity proxy stop          # Stop proxy"
echo ""


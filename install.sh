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
if [ -n "$SCRIPT_DIR" ] && [ "$SCRIPT_DIR" != "$HOME" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/bin/cli.js" ] && [ -f "$SCRIPT_DIR/bin/anti.js" ]; then
    INSTALL_DIR="$SCRIPT_DIR"
    echo "📦 Installing from local source repository: $INSTALL_DIR"
else
    INSTALL_DIR="$HOME/.antigravity-proxy-app"
    REPO_URL="${1:-https://github.com/ELITEXGAMES/proxyhub.git}"
    echo "📥 Downloading latest Antigravity Proxy release to $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    if command -v git >/dev/null 2>&1; then
        git clone "$REPO_URL" "$INSTALL_DIR"
    else
        echo "📥 Downloading tarball from GitHub..."
        mkdir -p "$INSTALL_DIR"
        curl -fsSL https://github.com/ELITEXGAMES/proxyhub/archive/refs/heads/main.tar.gz -o /tmp/proxyhub.tar.gz
        tar -xzf /tmp/proxyhub.tar.gz -C /tmp
        cp -rf /tmp/proxyhub-main/* "$INSTALL_DIR"/
        rm -rf /tmp/proxyhub.tar.gz /tmp/proxyhub-main
    fi
fi

cd "$INSTALL_DIR"

# 4. Install dependencies & link globally
echo "📦 Installing dependencies (npm install)..."
npm install --omit=dev

chmod +x bin/anti.js bin/cli.js

echo "🔗 Linking CLI globally..."
if npm link 2>/dev/null; then
    echo "✅ Linked via npm link"
else
    echo "⚠️  npm link required elevated permissions. Trying with sudo..."
    sudo npm link 2>/dev/null || true
fi

# Ensure symlinks exist in /usr/local/bin and ~/.local/bin pointing to updated installation
echo "🔗 Ensuring global symlinks point to $INSTALL_DIR..."
if [ -w /usr/local/bin ]; then
    ln -sf "$INSTALL_DIR/bin/anti.js" /usr/local/bin/anti
    ln -sf "$INSTALL_DIR/bin/cli.js" /usr/local/bin/antigravity-proxy
    ln -sf "$INSTALL_DIR/bin/cli.js" /usr/local/bin/ag-proxy
elif command -v sudo >/dev/null 2>&1; then
    sudo ln -sf "$INSTALL_DIR/bin/anti.js" /usr/local/bin/anti 2>/dev/null || true
    sudo ln -sf "$INSTALL_DIR/bin/cli.js" /usr/local/bin/antigravity-proxy 2>/dev/null || true
    sudo ln -sf "$INSTALL_DIR/bin/cli.js" /usr/local/bin/ag-proxy 2>/dev/null || true
fi

mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/bin/anti.js" "$HOME/.local/bin/anti"
ln -sf "$INSTALL_DIR/bin/cli.js" "$HOME/.local/bin/antigravity-proxy"
ln -sf "$INSTALL_DIR/bin/cli.js" "$HOME/.local/bin/ag-proxy"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

# Kill any stale proxy process on port 4000 to prevent old memory cache
if command -v fuser >/dev/null 2>&1; then
    fuser -k 4000/tcp 2>/dev/null || true
fi

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


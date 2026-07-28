#!/usr/bin/env bash
# Registers this package globally via `npm link`, so its `bin` command
# (unofficial-vwo-mcp-server) resolves on PATH exactly as if it had been
# `npm install -g`'d from the registry — without publishing anywhere.
#
# Useful for MCP host configs: once linked, "command": "unofficial-vwo-mcp-server"
# works in place of "command": "node", "args": ["/absolute/path/dist/index.js"].
#
# Usage: ./scripts/install_package_locally.sh
# Undo:  npm unlink -g unofficial-vwo-mcp-server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

PACKAGE_NAME="$(node -p "require('./package.json').name")"
BIN_NAME="$(node -p "Object.keys(require('./package.json').bin)[0]")"

echo "==> Installing dependencies"
npm install

echo "==> Building"
npm run build

echo "==> Linking $PACKAGE_NAME globally"
npm link

if command -v "$BIN_NAME" >/dev/null 2>&1; then
    echo
    echo "Linked. '$BIN_NAME' resolves to: $(command -v "$BIN_NAME")"
    echo "Use it in an MCP config as: \"command\": \"$BIN_NAME\""
else
    echo
    echo "npm link succeeded, but '$BIN_NAME' isn't on PATH yet."
    echo "Check that npm's global bin directory is on PATH: npm config get prefix"
fi

echo "To undo: npm unlink -g $PACKAGE_NAME"

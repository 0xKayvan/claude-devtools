#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="dev.nouri.tools.claude-devtools.sdPlugin"
PLUGIN_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Claude Devtools StreamDeck Plugin Installer ==="
echo ""

# Check StreamDeck is installed
if [ ! -d "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins" ]; then
  echo "ERROR: StreamDeck software not found."
  echo "Install it from https://www.elgato.com/downloads"
  exit 1
fi

# Build the plugin
echo "[1/4] Building plugin..."
cd "$SCRIPT_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
npx tsc
echo "      Built successfully."

# Stop StreamDeck if running (it locks plugin files)
if pgrep -q "Stream Deck"; then
  echo "[2/4] Stopping StreamDeck..."
  osascript -e 'quit app "Elgato Stream Deck"' 2>/dev/null || true
  sleep 2
else
  echo "[2/4] StreamDeck not running, skipping stop."
fi

# Install plugin
echo "[3/4] Installing plugin to StreamDeck..."
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"

# Copy built JS files
cp -r "$SCRIPT_DIR/dist/" "$PLUGIN_DIR/"

# Copy manifest and property inspector
cp "$SCRIPT_DIR/manifest.json" "$PLUGIN_DIR/"
cp -r "$SCRIPT_DIR/property-inspector" "$PLUGIN_DIR/"

# Copy node_modules (plugin needs runtime deps)
cp -r "$SCRIPT_DIR/node_modules" "$PLUGIN_DIR/"

# Create assets directory with placeholder icons
mkdir -p "$PLUGIN_DIR/assets/icons"
# Generate simple SVG icons converted to PNG via canvas would be ideal,
# but for now create minimal placeholder files
echo '{"placeholder": true}' > "$PLUGIN_DIR/assets/icons/plugin-icon.json"
echo '{"placeholder": true}' > "$PLUGIN_DIR/assets/icons/action-icon.json"
echo '{"placeholder": true}' > "$PLUGIN_DIR/assets/icons/state-default.json"

echo "      Installed to: $PLUGIN_DIR"

# Restart StreamDeck
echo "[4/4] Starting StreamDeck..."
open -a "Elgato Stream Deck" 2>/dev/null || echo "      Could not start StreamDeck. Please start it manually."

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Start claude-devtools:  cd $(dirname "$SCRIPT_DIR") && pnpm dev"
echo "  2. In StreamDeck app, find 'Claude Devtools' > 'Session Monitor'"
echo "  3. Drag it onto a key"
echo "  4. Configure the project in the key's settings panel"

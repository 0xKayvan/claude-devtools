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
echo "[1/5] Building plugin..."
cd "$SCRIPT_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
npx tsc
echo "      Built successfully."

# Generate icon PNGs using the canvas lib we already have
echo "[2/5] Generating icons..."
node -e "
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const dir = path.join('$SCRIPT_DIR', 'assets', 'icons');
fs.mkdirSync(dir, { recursive: true });

function makeIcon(size, bg, text, filename) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  // Background
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.15);
  ctx.fill();
  // Text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold ' + Math.floor(size * 0.35) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  fs.writeFileSync(path.join(dir, filename), c.toBuffer('image/png'));
}

// Plugin icon (shown in StreamDeck store/list) — needs @2x variant
makeIcon(288, '#3b82f6', 'CD', 'plugin-icon.png');
makeIcon(288, '#3b82f6', 'CD', 'plugin-icon@2x.png');

// Action icon (shown in action list)
makeIcon(40, '#3b82f6', 'C', 'action-icon.png');
makeIcon(80, '#3b82f6', 'C', 'action-icon@2x.png');

// Default state image (shown on key before configuration)
makeIcon(144, '#71717a', 'CD', 'state-default.png');

console.log('      Icons generated.');
"

# Stop StreamDeck if running (it locks plugin files)
if pgrep -q "Stream Deck"; then
  echo "[3/5] Stopping StreamDeck..."
  osascript -e 'quit app "Elgato Stream Deck"' 2>/dev/null || true
  sleep 2
else
  echo "[3/5] StreamDeck not running, skipping stop."
fi

# Install plugin
echo "[4/5] Installing plugin to StreamDeck..."
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"

# Copy built JS files to plugin root (CodePath is "plugin.js", not "dist/plugin.js")
cp -r "$SCRIPT_DIR/dist/"* "$PLUGIN_DIR/"

# Copy manifest and property inspector
cp "$SCRIPT_DIR/manifest.json" "$PLUGIN_DIR/"
cp -r "$SCRIPT_DIR/property-inspector" "$PLUGIN_DIR/"

# Copy assets (icons)
cp -r "$SCRIPT_DIR/assets" "$PLUGIN_DIR/"

# Copy node_modules (plugin needs runtime deps — StreamDeck runs the plugin with its bundled Node)
cp -r "$SCRIPT_DIR/node_modules" "$PLUGIN_DIR/"

echo "      Installed to: $PLUGIN_DIR"

# Restart StreamDeck
echo "[5/5] Starting StreamDeck..."
open -a "Elgato Stream Deck" 2>/dev/null || echo "      Could not start StreamDeck. Please start it manually."

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Start claude-devtools:  cd $(dirname "$SCRIPT_DIR") && pnpm dev"
echo "  2. In StreamDeck app, find 'Developer Tools' > 'Session Monitor'"
echo "  3. Drag it onto a key"
echo "  4. Configure the project in the key's settings panel"

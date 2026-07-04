#!/usr/bin/env bash

# Pi context-mode Installer/Updater (BOOTSTRAP VERSION)
# This script installs/updates context-mode as an MCP server AND a Pi Extension bootstrap.

set -e

echo "🔍 Checking prerequisites..."

# 2. Install/Update context-mode globally via npm
echo "📦 Installing/Updating context-mode globally..."
npm install -g context-mode@latest

# 3. Locate the installed package
CM_PACKAGE_PATH="$(npm root -g)/context-mode"

if [ ! -d "$CM_PACKAGE_PATH" ]; then
    echo "❌ Error: Could not find context-mode at $CM_PACKAGE_PATH"
    exit 1
fi

# 4. Setup the Pi Extension Bootstrap
PI_EXT_DIR="$HOME/.pi/agent/extensions/context-mode"
echo "🔧 Setting up Pi Extension Bootstrap in $PI_EXT_DIR..."

mkdir -p "$PI_EXT_DIR"

# Write the bootstrap loader
cat <<EOF > "$PI_EXT_DIR/index.ts"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * context-mode bootstrap extension for Pi.
 */
export default async function(pi: ExtensionAPI) {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const packagePath = join(globalRoot, "context-mode");
    const extensionPath = join(packagePath, "build/adapters/pi/extension.js");
    const { default: extension } = await import(extensionPath);
    return extension(pi);
  } catch (error) {
    console.error("Failed to bootstrap context-mode extension:", error);
  }
}
EOF

# 5. Configure MCP Server
MCP_CONFIG="$HOME/.pi/agent/mcp.json"

if [ ! -f "$MCP_CONFIG" ]; then
    echo '{"mcpServers": {}}' > "$MCP_CONFIG"
fi

node <<EOF
const fs = require('fs');
const path = '$MCP_CONFIG';
let config = { mcpServers: {} };
try {
    config = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {}

config.mcpServers = config.mcpServers || {};
config.mcpServers['memory_context'] = {
    command: 'npx',
    args: ['-y', 'context-mode'],
    directTools: true
};

fs.writeFileSync(path, JSON.stringify(config, null, 2));
EOF

echo "✅ MCP Server 'memory_context' configured."
echo "✨ Installation complete! Run '/reload' in Pi."

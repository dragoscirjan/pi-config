#!/usr/bin/env bash
#
# Pi Environment Setup Script
# Follows Google Shell Style Guide.
#
# Modules are executed based on their default state.
#   -module-name will skip a mandatory module.
#   +module-name will enable an optional module.

set -euo pipefail

# --- Global Constants ---
readonly PI_EXT_DIR="${HOME}/.pi/agent/extensions/context-mode"
readonly MCP_CONFIG="${HOME}/.pi/agent/mcp.json"

# Save arguments for module parsing
declare -a ARGS
ARGS=("$@")

# --- Utility Functions ---

# Logs an informational message.
log_info() {
  echo "[INFO] $*"
}

# Logs an error message.
log_err() {
  echo "[ERROR] $*" >&2
}

# Executes a module based on its default state and user arguments.
# Arguments:
#   $1: Module name (e.g., 'context-mode')
#   $2: Default state ('true' for mandatory, 'false' for optional)
#   $3: Function to execute for the module
execute_module() {
  local module_name="${1}"
  local default_state="${2}"
  local module_function="${3}"
  
  local skip_flag="-${module_name}"
  local enable_flag="+${module_name}"
  local enabled="${default_state}"
  
  # Check ARGS for overrides
  for arg in "${ARGS[@]:-}"; do
    if [[ "${arg}" == "${skip_flag}" ]]; then
      enabled="false"
    elif [[ "${arg}" == "${enable_flag}" ]]; then
      enabled="true"
    fi
  done
  
  if [[ "${enabled}" == "true" ]]; then
    log_info "Running module: ${module_name}..."
    if ! "${module_function}"; then
      log_err "Module ${module_name} failed."
      return 1
    fi
  else
    log_info "Skipping module: ${module_name}."
  fi
}

# --- Modules ---

# Module: context-mode
# Installs context-mode globally and sets up Pi bootstrap.
module_context_mode() {
  log_info "Installing context-mode globally via npm..."
  npm install -g context-mode@latest

  local cm_package_path
  cm_package_path="$(npm root -g)/context-mode"

  if [[ ! -d "${cm_package_path}" ]]; then
    log_err "Could not find context-mode at ${cm_package_path}"
    return 1
  fi

  log_info "Setting up Pi Extension Bootstrap in ${PI_EXT_DIR}..."
  mkdir -p "${PI_EXT_DIR}"

  cat << 'EOF' > "${PI_EXT_DIR}/index.ts"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { execSync } from "node:child_process";

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

  log_info "Configuring MCP Server in ${MCP_CONFIG}..."
  if [[ ! -d "$(dirname "${MCP_CONFIG}")" ]]; then
    mkdir -p "$(dirname "${MCP_CONFIG}")"
  fi
  if [[ ! -f "${MCP_CONFIG}" ]]; then
    echo '{"mcpServers": {}}' > "${MCP_CONFIG}"
  fi

  node <<EOF
const fs = require('fs');
const path = '${MCP_CONFIG}';
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

  log_info "context-mode installation complete."
}

# Module: pi-subagents
# Installs pi-subagents and patches namespace imports.
module_pi_subagents() {
  log_info "Installing pi-subagents..."
  pi install npm:pi-subagents

  log_info "Patching pi-subagents imports for compatibility..."
  local npm_root
  npm_root="$(npm root -g)"
  
  if [[ -d "${npm_root}/pi-subagents" ]]; then
    find "${npm_root}/pi-subagents" -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" \) \
      -exec sed -i 's/@earendil-works\/pi-coding-agent/@mariozechner\/pi-coding-agent/g' {} +
    log_info "pi-subagents patched in ${npm_root}/pi-subagents."
  elif [[ -d "${HOME}/.nvm" ]]; then
    log_info "pi-subagents not found in ${npm_root}. Trying NVM fallback..."
    find "${HOME}/.nvm" -path "*/lib/node_modules/pi-subagents" -type d \
      -exec bash -c 'find "$0" -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" \) \
      -exec sed -i "s/@earendil-works\/pi-coding-agent/@mariozechner\/pi-coding-agent/g" {} +' {} \;
    log_info "pi-subagents patched via NVM fallback."
  else
    log_err "Could not find pi-subagents to patch. You may encounter import errors."
    return 1
  fi
}

# Module: pi-mcp-adapter
# Installs the external MCP adapter from nicobailon.
module_pi_mcp_adapter() {
  log_info "Installing pi-mcp-adapter..."
  pi install git:github.com/nicobailon/pi-mcp-adapter
  log_info "pi-mcp-adapter installation complete."
}

# --- Main ---

main() {
  # Handle basic help
  if [[ " ${ARGS[*]:-} " =~ " -h " ]] || [[ " ${ARGS[*]:-} " =~ " --help " ]]; then
    cat << EOF
Usage: $0 [OPTIONS]

Options to skip mandatory modules:
  -context-mode     Skip installing context-mode
  -pi-subagents     Skip installing pi-subagents
  -pi-mcp-adapter   Skip installing pi-mcp-adapter

Example:
  $0 -context-mode -pi-mcp-adapter

EOF
    exit 0
  fi

  log_info "🚀 Starting Pi environment setup..."

  # Mandatory modules (default: true)
  execute_module "context-mode" "true" "module_context_mode"
  execute_module "pi-subagents" "true" "module_pi_subagents"

  
  execute_module "pi-mcp-adapter" "true" "module_pi_mcp_adapter"

  log_info "🎉 Setup complete! You can now launch Pi."
}

main

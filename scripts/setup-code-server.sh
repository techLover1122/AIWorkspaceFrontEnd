#!/usr/bin/env bash
set -euo pipefail

HOST_ADDRESS="${CODE_SERVER_HOST:-0.0.0.0}"
PORT="${CODE_SERVER_PORT:-5522}"
PASSWORD_VALUE="${CODE_SERVER_PASSWORD:-change-me}"

echo "[setup] Installing code-server using official installer..."
curl -fsSL https://code-server.dev/install.sh | sh

CONFIG_DIR="${HOME}/.config/code-server"
CONFIG_PATH="${CONFIG_DIR}/config.yaml"
REPO_USER_SETTINGS_DIR="$(pwd)/config/code-server/user-data/User"
REPO_USER_SETTINGS_PATH="${REPO_USER_SETTINGS_DIR}/settings.json"
mkdir -p "${CONFIG_DIR}"

cat > "${CONFIG_PATH}" <<EOF
bind-addr: ${HOST_ADDRESS}:${PORT}
auth: password
password: ${PASSWORD_VALUE}
cert: false
EOF

mkdir -p "${REPO_USER_SETTINGS_DIR}"

if [ ! -f "${REPO_USER_SETTINGS_PATH}" ]; then
cat > "${REPO_USER_SETTINGS_PATH}" <<EOF
{
  "workbench.statusBar.visible": false,
  "window.commandCenter": false,
  "zenMode.restore": false,
  "zenMode.fullScreen": false,
  "zenMode.centerLayout": false,
  "zenMode.hideTabs": true,
  "zenMode.hideStatusBar": true,
  "zenMode.hideActivityBar": false,
  "workbench.editor.centeredLayoutAutoResize": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none"
}
EOF
fi

mkdir -p workspaces/project-1 workspaces/project-2

echo "[setup] Done."
echo "[setup] Config file: ${CONFIG_PATH}"
echo "[setup] Bundled VS Code settings: ${REPO_USER_SETTINGS_PATH}"
echo "[setup] Start command: code-server --bind-addr ${HOST_ADDRESS}:${PORT} ./workspaces/project-1"

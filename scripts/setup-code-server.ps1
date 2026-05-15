param(
  [string]$HostAddress = "0.0.0.0",
  [int]$Port = 5522,
  [string]$Password = "change-me"
)

$ErrorActionPreference = "Stop"

Write-Host "[setup] Installing code-server globally via npm..."
npm install -g code-server

$configDir = Join-Path $env:APPDATA "code-server"
$configPath = Join-Path $configDir "config.yaml"
$repoUserSettingsDir = Join-Path (Resolve-Path ".").Path "config\code-server\user-data\User"
$repoUserSettingsPath = Join-Path $repoUserSettingsDir "settings.json"

if (!(Test-Path $configDir)) {
  New-Item -ItemType Directory -Path $configDir | Out-Null
}

$yaml = @"
bind-addr: $HostAddress`:$Port
auth: password
password: $Password
cert: false
"@

Set-Content -Path $configPath -Value $yaml -Encoding UTF8

if (!(Test-Path $repoUserSettingsDir)) {
  New-Item -ItemType Directory -Force -Path $repoUserSettingsDir | Out-Null
}

if (!(Test-Path $repoUserSettingsPath)) {
  @"
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
"@ | Set-Content -Path $repoUserSettingsPath -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path "workspaces/project-1" | Out-Null
New-Item -ItemType Directory -Force -Path "workspaces/project-2" | Out-Null

Write-Host "[setup] Done."
Write-Host "[setup] Config file: $configPath"
Write-Host "[setup] Bundled VS Code settings: $repoUserSettingsPath"
Write-Host "[setup] Start command: code-server --bind-addr $HostAddress`:$Port ./workspaces/project-1"

# code-server Installation and Setup

Official sources:
- https://github.com/coder/code-server
- https://coder.com/docs/code-server/install

## 1) Install code-server

### Linux/macOS (official installer)
```bash
curl -fsSL https://code-server.dev/install.sh | sh
```

### Alternative (npm global)
```bash
npm install -g code-server
```

### Windows (PowerShell)
```powershell
npm install -g code-server
```

Repo helper scripts:
- Windows: `scripts/setup-code-server.ps1`
- Linux/macOS: `scripts/setup-code-server.sh`

## 2) Workspace Structure

This repo uses:
```text
workspaces/
  project-1/
  project-2/
```

`project-1` is the default startup workspace.

## 3) Runtime Configuration (Port 5522)

Command:
```bash
code-server --bind-addr 0.0.0.0:5522 ./workspaces/project-1
```

## 4) Environment Variables

Use `.env.code-server.example` as reference:
```env
CODE_SERVER_PORT=5522
CODE_SERVER_HOST=0.0.0.0
CODE_SERVER_WORKSPACE=./workspaces/project-1
CODE_SERVER_AUTH=password
CODE_SERVER_PASSWORD=change-me
```

## 5) Startup Scripts

From this repo:
```bash
npm run code-server
```

This runs:
- `scripts/start-code-server.js`

The startup script also mounts repo-local VS Code user settings from:
- `config/code-server/user-data/User/settings.json`

Bundled defaults include:
- Zen Mode restore enabled
- status bar hidden
- activity bar hidden
- command center hidden

Health check:
```bash
npm run code-server:verify
```

## 6) Password Auth Config

For Linux/macOS:
- `~/.config/code-server/config.yaml`

For Windows:
- `%APPDATA%\code-server\config.yaml`

Example:
```yaml
bind-addr: 0.0.0.0:5522
auth: password
password: change-me
cert: false
```

Repo template:
- `config/code-server/config.yaml.example`

Bundled VS Code settings:
- `config/code-server/user-data/User/settings.json`

## 7) Verify Installation

1. Start service:
```bash
npm run code-server
```

2. Open:
- http://localhost:5522

Expected:
- Real browser VS Code (code-server login/editor).

## 8) Iframe Readiness

Iframe target:
```html
<iframe src="http://localhost:5522"></iframe>
```

Checklist:
- `code-server` is listening on `0.0.0.0:5522`
- reverse proxy forwards WebSocket upgrade headers
- same-origin policy is handled by deployment topology

## 9) Production Reverse Proxy (nginx)

Example route: `/ide` -> `code-server:5522`

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name your-domain.com;

  location /ide/ {
    proxy_pass http://127.0.0.1:5522/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
  }
}
```

## Troubleshooting

- `code-server: command not found`
  - Reinstall globally: `npm install -g code-server`
  - Restart terminal and verify PATH.

- Port already in use (`5522`)
  - Free the port or set `CODE_SERVER_PORT` to another port.

- Cannot access from other machines
  - Confirm bind addr is `0.0.0.0`.
  - Check firewall rules for selected port.

- Iframe not connecting / blank
  - Verify reverse proxy WebSocket headers.
  - Verify URL is reachable directly in browser first.

- Authentication issues
  - Check `config.yaml` password/auth values.
  - Restart code-server after config changes.

# AI IDE — Frontend

Next.js 15 frontend for the AI IDE platform.

## Stack

- **Framework**: Next.js 15 (App Router)
- **UI**: React 19
- **Markdown**: `react-markdown` + `remark-gfm`
- **Backend URL**: `http://localhost:8090` (default, set via `NEXT_PUBLIC_BACKEND_URL`)

## Setup

```bash
npm install
```

Create a `.env` file (optional):

```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8090
```

## Development

Start the backend first, then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production

```bash
npm run build
npm start
```

## Authentication

The app supports two auth methods:

- **API Key** — paste a `sk-ant-...` key directly
- **Claude.ai Subscription** — OAuth flow (VS Code-style: copy the URL, open in browser, paste the authorization code back)

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│    ██╗   ██╗██╗██╗  ██╗██╗   ██╗███╗   ██╗     ██╗ █████╗  │
│    ██║   ██║██║██║ ██╔╝██║   ██║████╗  ██║     ██║██╔══██╗ │
│    ██║   ██║██║█████╔╝ ██║   ██║██╔██╗ ██║     ██║███████║ │
│    ╚██╗ ██╔╝██║██╔═██╗ ██║   ██║██║╚██╗██║██   ██║██╔══██║ │
│     ╚████╔╝ ██║██║  ██╗╚██████╔╝██║ ╚████║╚█████╔╝██║  ██║ │
│      ╚═══╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚════╝ ╚═╝  ╚═╝ │
│                        ███╗   ███╗ ██████╗██████╗          │
│                        ████╗ ████║██╔════╝██╔══██╗         │
│                        ██╔████╔██║██║     ██████╔╝         │
│                        ██║╚██╔╝██║██║     ██╔═══╝          │
│                        ██║ ╚═╝ ██║╚██████╗██║              │
│                        ╚═╝     ╚═╝ ╚═════╝╚═╝              │
│                                                            │
│    > MCP server for Vikunja task management                │
│    > Connect your AI assistant to your tasks               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

[![Build](https://github.com/0xK3vin/vikunja-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xK3vin/vikunja-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@0xk3vin/vikunja-mcp.svg)](https://www.npmjs.com/package/@0xk3vin/vikunja-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

---

## > ABOUT

Connect your AI assistant to [Vikunja](https://vikunja.io), the open-source task manager. This [MCP](https://modelcontextprotocol.io) server runs as a remote HTTP service and lets you manage projects, tasks, kanban boards, and more — just by asking.

```
WHY VIKUNJA-MCP?
────────────────────────────────────────────────────────────
  [+] Self-hosted friendly    Your data stays on your server
  [+] Remote HTTP transport   Deploy once, connect from anywhere
  [+] Full coverage           32 tools across all Vikunja APIs
  [+] Reliable                Retry logic with exponential backoff
  [+] Production ready        85 tests, 90%+ code coverage
  [+] Secure                  Two-layer auth, per-request tokens
────────────────────────────────────────────────────────────
```

---

## > HOW IT WORKS

The server exposes a single endpoint at `/sse` using the [Streamable HTTP MCP transport](https://modelcontextprotocol.io/docs/concepts/transports).

Every request requires two headers:

| Header | Purpose |
|--------|---------|
| `Authorization: Bearer <VIKUNJA_MCP_TOKEN>` | Gates access to the MCP server itself |
| `X-Vikunja-Token: <vikunja-api-token>` | Per-request Vikunja API token forwarded upstream |

This means a single server instance can serve multiple users, each passing their own Vikunja token at call time.

---

## > DEPLOYMENT

### Docker Compose (recommended)

```bash
# 1. Clone the repo
git clone https://github.com/0xK3vin/vikunja-mcp.git
cd vikunja-mcp

# 2. Create your .env file
cp .env.example .env
# edit .env — set VIKUNJA_URL and VIKUNJA_MCP_TOKEN

# 3. Start
docker compose up -d
```

The server will be available at `http://localhost:3000/sse`.

### Docker (manual)

```bash
docker build -t vikunja-mcp .
docker run -d \
  --name vikunja-mcp \
  -p 3000:3000 \
  -e VIKUNJA_URL=https://your-vikunja-instance.com \
  -e VIKUNJA_MCP_TOKEN=your_mcp_secret \
  vikunja-mcp
```

---

## > CONFIGURATION

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VIKUNJA_URL` | yes | — | Base URL of your Vikunja instance |
| `VIKUNJA_MCP_TOKEN` | yes | — | Shared secret for MCP server access |
| `PORT` | no | `3000` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP bind address |

**Getting a Vikunja API token:**
1. Log into your Vikunja instance
2. Go to **Settings** → **API Tokens**
3. Create a new token and copy it — pass it per-request via `X-Vikunja-Token`

**Generating a strong MCP token:**
```bash
openssl rand -hex 32
```

---

## > CLIENT CONFIGURATION

### nanobot

```json
{
  "mcpServers": {
    "vikunja": {
      "url": "http://vikunja-mcp.lan:3000/sse",
      "headers": {
        "Authorization": "Bearer ${VIKUNJA_MCP_TOKEN}",
        "X-Vikunja-Token": "${VIKUNJA_API_TOKEN}"
      },
      "toolTimeout": 60
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "vikunja": {
      "url": "http://localhost:3000/sse",
      "headers": {
        "Authorization": "Bearer your_mcp_token",
        "X-Vikunja-Token": "your_vikunja_api_token"
      }
    }
  }
}
```

---

## > FEATURES

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  [■] PROJECTS      Create, update, delete, archive      │
│  [■] TASKS         Full CRUD + filtering & sorting      │
│  [■] KANBAN        Buckets, move tasks, WIP limits      │
│  [■] LABELS        Create, attach, remove from tasks    │
│  [■] COMMENTS      Add and list task comments           │
│  [■] ASSIGNEES     Manage who's working on what         │
│  [■] RELATIONS     Subtasks, blocking, dependencies     │
│  [■] VIEWS         List, kanban, table, gantt           │
│  [■] TEAMS         List teams and members               │
│  [■] USERS         Search by name, username, email      │
│  [■] NOTIFICATIONS List user notifications              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## > HEALTH CHECK

The server exposes an unauthenticated health endpoint:

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

---

## > DEVELOPMENT

```bash
git clone https://github.com/0xK3vin/vikunja-mcp.git
cd vikunja-mcp
npm install
npm run build
npm test
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Lint code |
| `npm run typecheck` | Type-check without emitting |
| `npm run inspect` | Debug with MCP Inspector |

---

## > DOCS

Full API reference: **[docs/API.md](docs/API.md)**

---

## > CONTRIBUTING

Contributions welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** for guidelines.

---

## > LICENSE

MIT - see [LICENSE](LICENSE)

---

```
╔════════════════════════════════════════════════════════════╗
║  Made by 0xK3vin                                           ║
║  github.com/0xK3vin/vikunja-mcp                            ║
╚════════════════════════════════════════════════════════════╝
```

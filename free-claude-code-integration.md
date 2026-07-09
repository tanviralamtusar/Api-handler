# free-claude-code integration

This project bundles [free-claude-code](https://github.com/Alishahryar1/free-claude-code) (FCC),
a Python/FastAPI proxy that gives Claude Code CLI, Codex, their VS Code extensions, and chat bots
access to 24 provider backends. Rather than rewriting it in Node, this Node/Express API **runs FCC
as a sibling process and proxies to it**, so you get all of FCC's features immediately.

```
client (Claude Code, Codex, curl)
        |
        v
Node/Express  :3001   ---- /fcc/*  proxied to ---->  free-claude-code (Python)  :8082
   /api/*  (your own engines)                          /v1/messages, /v1/models,
                                                        /v1/responses, /admin, ...
```

## What was wired in

- `src/middleware/fccProxy.js` — reverse proxy (http-proxy-middleware), mounted in
  `src/app.js` **before** `express.json()` so streaming (SSE) request/response bodies pass
  through untouched. Everything under `/fcc` is forwarded to FCC with the prefix stripped.
- `ecosystem.config.js` — pm2 now runs **two** apps: `api-handler` (Node) and
  `free-claude-code` (`uv run fcc-server`).
- `package.json` scripts:
  - `npm run fcc:setup` — one-time: `uv sync` for the Python env.
  - `npm run fcc` — run just the FCC server.
  - `npm run dev:all` — run Node + FCC together (dev, via concurrently).
  - `npm run start:all` — run both under pm2 (production).
- `.env` — `FCC_TARGET_URL` (defaults to `http://127.0.0.1:8082`).

## Endpoints (through the Node app on :3001)

| Path                        | Forwards to FCC   | Purpose                                    |
|-----------------------------|-------------------|--------------------------------------------|
| `/fcc/v1/messages`          | `/v1/messages`    | Claude Code (Anthropic Messages API)       |
| `/fcc/v1/responses`         | `/v1/responses`   | Codex (OpenAI Responses API)               |
| `/fcc/v1/models`            | `/v1/models`      | native `/model` picker catalog             |
| `/fcc/admin`                | `/admin`          | Admin UI (loopback-only on the FCC side)   |
| `/fcc/health`               | `/health`         | health check                               |

> The Admin UI serves absolute asset paths, so for configuring providers it's simplest to open it
> **directly** at `http://127.0.0.1:8082/admin` while FCC is running.

## First-time setup

```bash
npm install            # Node deps (proxy, pm2, concurrently)
npm run fcc:setup      # uv sync — builds the Python venv for FCC (needs uv + Python 3.14)
```

## Run

```bash
npm run dev:all        # Node (:3001) + FCC (:8082) together
# or, production:
npm run start:all      # both under pm2
```

## Configure a provider

FCC ships with no API keys. Configure at least one provider (e.g. NVIDIA NIM, OpenRouter, Gemini)
via the Admin UI at `http://127.0.0.1:8082/admin`, or by editing `~/.fcc/.env`
(run `uv run fcc-init` inside `free-claude-code/` to scaffold it). Until then, FCC endpoints return
`{"detail":"Missing API key"}` — which is expected and confirms the proxy is reaching FCC.

## Point Claude Code at your proxy

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3001/fcc"
export ANTHROPIC_AUTH_TOKEN="<token if you set ANTHROPIC_AUTH_TOKEN in FCC, else anything>"
claude
```

## Deployment notes (Coolify / nixpacks)

The current `nixpacks.toml` installs Node deps only. To deploy **both** processes in one container
you also need, in the build image:

- `uv` on PATH (e.g. `curl -LsSf https://astral.sh/uv/install.sh | sh`),
- `uv sync` run inside `free-claude-code/` at build time (uv will fetch Python 3.14 per
  `.python-version`),
- the start command changed to `npm run start:all` (pm2 runs both).

These weren't applied automatically to avoid changing your existing single-process deploy without
testing the container. Ask if you want me to update `nixpacks.toml` for a two-process deploy.

## Note: nested git repo

`free-claude-code/` has its own `.git`. If you commit this project, git will treat it as an embedded
repo. Either add it as a proper submodule, or remove `free-claude-code/.git` to vendor it directly.

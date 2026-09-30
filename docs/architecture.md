# Architecture

HTTP/SSE service. Every product calls the same `/v1`. The product id is an opaque label. No product talks to LiteLLM.

```text
product
  Authorization: Bearer <api-key>
  X-Amazing-Product: <id the caller chooses>
        │
        ▼
API :3200  (host Compose publishes :13200)
  GET  /health
  GET  /v1/providers
  GET  /v1/providers/{family}/models
  POST /v1/context/preview
  POST /v1/runs          events, cancel
  POST /v1/sessions      turns, events, delete
        │
        ▼
dispatcher → queue (global and per product)
          → session registry (IDLE, BUSY, CLOSED)
          → isolated HOME
          → sessions/{id}/session.jsonl and runs/{id}/
        │
        ├── spawn: cursor, claude, codex, copilot, antigravity
        ├── external → LiteLLM :4000 on network amazing-llm
        └── fake (tests)
```

## Sessions

`POST /v1/sessions` keeps `home/` and the conversation log so a native CLI can resume.

`POST /v1/runs` without `sessionId` opens a one-turn ephemeral session and closes it when the run finishes.

On disk, under `AMAZING_CLI_DATA_ROOT`:

| Path | Kept when a persistent session closes |
|---|---|
| `sessions/{id}/meta.json` | yes |
| `sessions/{id}/session.jsonl` | yes |
| `sessions/{id}/home` | no |
| `runs/{id}/` | yes |

A persistent session idle longer than `AMAZING_CLI_SESSION_IDLE_TTL_SEC` is closed by the sweeper. That variable and `AMAZING_CLI_SESSION_SWEEP_SEC` have no default in code. Compose sets 3600 and 60.

## Providers

Manifests live in `providers/*.yaml`. An extra directory (`AMAZING_CLI_PROVIDERS_DIR`) loads after those files. A repeated `family` or an invalid file fails boot and names the path.

The workspace harness is read by the native CLI. amazing-cli does not write rules or skills.

## Networks

| Network | Who |
|---|---|
| `amazing` | this API only. Products call port 13200 and do not join it |
| `amazing-llm` | LiteLLM and Postgres only |

Errors are `{ "error": { "code", "message" } }`.

# amazing-cli

HTTP/SSE execution service for native coding CLIs (Cursor, Claude, Codex, Copilot, Antigravity) and an external LiteLLM harness. Any product calls the same `/v1`. The service does not know the caller's domain. Products never talk to LiteLLM.

License: **MIT** — [`LICENSE`](LICENSE). Docs: [`docs/README.md`](docs/README.md).

## Contract

OpenAPI 3.1 source of truth: [`openapi.yaml`](./openapi.yaml)

Auth (every `/v1/*` route): `Authorization: Bearer <AMAZING_CLI_API_KEY>` + `X-Amazing-Product: <id the caller chooses>`. `GET /health` has no auth.

## Run

Compose (this directory — LiteLLM + Postgres + CLI):

```bash
cp .env.example .env
docker compose up -d --build
```

| Service | Host port | Inside compose |
| ------- | --------- | -------------- |
| amazing-cli API | **13200** | `http://amazing-cli:3200` |
| LiteLLM API + Admin UI | **14000** | `http://litellm:4000` (only on `amazing-llm`) |

- Health (no auth): http://localhost:13200/health
- LiteLLM Admin UI: http://localhost:14000/ui

Products call the published port. They do not join this Compose. LiteLLM and Postgres (`litellm-db`) stay **only** on `amazing-llm`.

Local (no compose): set `AMAZING_CLI_API_KEY` and omit `LITELLM_BASE_URL` — `/health` then has no `litellm` key.

```bash
npm ci
npm test
npm run build
PORT=3200 AMAZING_CLI_API_KEY='local-dev-amazing-cli-key-0123456789' AMAZING_CLI_SESSION_IDLE_TTL_SEC=3600 AMAZING_CLI_SESSION_SWEEP_SEC=60 AMAZING_CLI_ENABLE_FAKE=true npm start
```

E2e in-process (no Docker, `family=fake`, including a session scenario): `npm run e2e:fake`

Real cursor resume (needs a running server and the cursor credential): `npm run e2e:cursor`

## Sessions

A session owns the isolated HOME and the conversation log, so a native CLI resumes between turns.

- `POST /v1/sessions` creates one (`home/` included); `POST /v1/sessions/{id}/turns` sends turns; `GET /v1/sessions/{id}/events` reads the conversation log; `DELETE /v1/sessions/{id}` cancels a live turn and closes it.
- `POST /v1/runs` without `sessionId` still works as before: it runs inside a one-turn **ephemeral** session that closes when the run finishes.
- On disk, under `AMAZING_CLI_DATA_ROOT`: `sessions/{id}/meta.json` (state), `sessions/{id}/session.jsonl` (conversation), `sessions/{id}/home` (the CLI's HOME — removed on close). `runs/{id}/` stays as it was.
- Retention: a persistent session idle longer than `AMAZING_CLI_SESSION_IDLE_TTL_SEC` is closed by the sweeper (see Environment). `home/` goes; `meta.json` and `session.jsonl` stay.

## Environment

| Variable | Default | Used by |
| -------- | ------- | ------- |
| `AMAZING_CLI_API_KEY` | required (one secret, ≥16 chars) | auth |
| `PORT` | `3200` | HTTP listen |
| `AMAZING_CLI_DATA_ROOT` | `/data/amazing-cli` | durable runs / isolated HOME |
| `AMAZING_CLI_WORKSPACES_ROOT` | unset | parent jail; each product id → `{root}/{product}` |
| `AMAZING_CLI_WORKSPACE_ROOTS` | empty (`<product>=/abs,…`) | optional per-product jail override |
| `AMAZING_CLI_MAX_CONCURRENT_RUNS` | `4` | global queue |
| `AMAZING_CLI_MAX_CONCURRENT_RUNS_PER_PRODUCT` | `2` | per-product queue |
| `AMAZING_CLI_DEFAULT_TIMEOUT_SEC` | `3600` | run timeout |
| `AMAZING_CLI_SESSION_IDLE_TTL_SEC` | **required** (compose: `3600`) | close a persistent session idle longer than this; `home/` removed, `meta.json` and `session.jsonl` kept. No default in code |
| `AMAZING_CLI_SESSION_SWEEP_SEC` | **required** (compose: `60`) | how often the session sweeper runs. No default in code |
| `AMAZING_CLI_ENABLE_FAKE` | unset (`true` enables) | test `family=fake` |
| `AMAZING_CLI_PROVIDERS_DIR` | unset | extra `*.yaml` manifests, loaded after the bundled `providers/`. A repeated `family` or an invalid file fails boot and names the path |
| `LITELLM_BASE_URL` | unset (compose: `http://litellm:4000`) | `/health.litellm` + external module. **Omit the key on `/health` when unset.** |
| `LITELLM_MASTER_KEY` | empty | `Authorization: Bearer` to LiteLLM |
| `AMAZING_CLI_CLAUDE_ALLOWED_TOOLS` | `Read,Edit,Write,Bash,Grep,Glob` | claude `--allowedTools` |
| `AMAZING_CLI_COPILOT_ALLOW_TOOLS` | `shell,write` | copilot `--allow-tool` |
| `AMAZING_CLI_ANTIGRAVITY_SKIP_PERMISSIONS` | on (`0`/`false` omits) | antigravity `--dangerously-skip-permissions` |
| `AMAZING_CLI_ANTIGRAVITY_PRINT_TIMEOUT` | `600` | antigravity `--print-timeout` |

Native CLI tokens (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GEMINI_API_KEY`) are **not** read from the amazing-cli process env for runs. Products store them and send `credential.secret` on `POST /v1/runs`. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` on the **LiteLLM** container are for external models only.

## How a product calls this service

The product does not join this Compose. It calls the published port:

`http://host.docker.internal:13200` from another container, or `http://localhost:13200` from the host.

Auth is the same for every caller: `Authorization: Bearer <AMAZING_CLI_API_KEY>` and `X-Amazing-Product: <id>`. The id is whatever the caller sends. Runs and sessions stay separated by that id. There is no second contract.

LiteLLM and Postgres stay on `amazing-llm`. Products must not join that network.

# Quick start

Requirements: Docker Compose v2, or Node.js ≥ 22 if you skip Compose.

## Compose

From this repository:

```bash
cp .env.example .env
docker compose up -d --build
```

| Service | URL |
|---|---|
| API | http://localhost:13200 |
| Health | http://localhost:13200/health |
| LiteLLM admin | http://localhost:14000/ui |

Products call http://localhost:13200. They do not join this Compose. LiteLLM and Postgres stay on `amazing-llm`.

`.env.example` has one secret, `AMAZING_CLI_API_KEY`. The caller sends that Bearer and its own `X-Amazing-Product`. The key is at least 16 characters. Do not commit `.env`.

## Without Compose

```bash
npm ci
npm test
npm run build
PORT=3200 AMAZING_CLI_API_KEY='local-dev-amazing-cli-key-0123456789' AMAZING_CLI_SESSION_IDLE_TTL_SEC=3600 AMAZING_CLI_SESSION_SWEEP_SEC=60 AMAZING_CLI_ENABLE_FAKE=true npm start
```

Health is on port 3200 in this mode, not 13200. Omit `LITELLM_BASE_URL` and `/health` has no `litellm` key.

In-process check, no Docker: `npm run e2e:fake`.

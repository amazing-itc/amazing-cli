# First run

Goal: prove the service is up and that the service key is accepted. No desktop install.

## 1. Start

Follow [quick-start.md](./quick-start.md). Compose publishes the API on port 13200.

## 2. Health needs no key

```bash
curl -s http://localhost:13200/health
```

`UP` means at least one provider is available. Otherwise the status is `DEGRADED`.

## 3. A product call

Every `/v1` route needs both headers. The Bearer is `AMAZING_CLI_API_KEY`. The product id is the caller's own label. `aw` below is only an example.

```bash
curl -s http://localhost:13200/v1/providers \
  -H 'Authorization: Bearer local-dev-amazing-cli-key-0123456789' \
  -H 'X-Amazing-Product: aw'
```

You should get one entry per family: `cursor`, `claude`, `codex`, `copilot`, `antigravity`, `external`, `fake`.

A wrong key or a missing product header is `401`.

## 4. What “running” means

A native family is only useful when that CLI exists in the image or on the host and the product sends `credential.secret` on the run. The amazing-cli process does not read `CURSOR_API_KEY` and the other native tokens from its own environment.

`family=fake` is for tests. Compose does not set `AMAZING_CLI_ENABLE_FAKE` unless you do.

Next calls are in [examples.md](./examples.md). The full schema is [openapi.yaml](../openapi.yaml).

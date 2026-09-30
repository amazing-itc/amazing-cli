# Roadmap

This repository does not keep a separate milestone list. The public surface is the OpenAPI file. What follows is the state of that surface, not a promise of dates.

## Now

- One `/v1` for every product, with bearer key and `X-Amazing-Product`.
- Runs, ephemeral sessions, and persistent sessions with an isolated HOME.
- Provider families: cursor, claude, codex, copilot, antigravity, external, fake.
- LiteLLM only from this service, on `amazing-llm`.
- Queue limits per process and per product.

## Next

- Keep `openapi.yaml` and the server in lockstep (`npm run lint` checks that).
- Keep the product id opaque. A new caller is a new `<id>:<key>` entry, not a change in this service.

## Later

Nothing else is committed in this repository. A new family or a new route starts as an issue and a change to `openapi.yaml`, not as a private endpoint.

Contribution: [CONTRIBUTING.md](../CONTRIBUTING.md).

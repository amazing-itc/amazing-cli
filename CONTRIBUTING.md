# Contributing

amazing-cli is MIT. See [LICENSE](LICENSE) and [docs/licenca.md](docs/licenca.md).

## Issues

Use the templates in `.github/ISSUE_TEMPLATE/`. Do not paste `.env`, product keys, or CLI tokens.

A contract change belongs in `openapi.yaml` and in the server together.

## Code

1. Fork and use a short branch.
2. `npm ci`
3. `npm test`
4. `npm run lint` (build, boundaries, OpenAPI)
5. `npm run e2e:fake` when the run or session path changed.
6. Do not commit `.env` or `workspaces/` data.

The core must not learn a caller's domain. Products stay outside `src/core`.

## Where to edit

| Change | Path |
|---|---|
| HTTP and SSE | `src/api` |
| Queue, sessions, HOME | `src/core` |
| A provider family | `src/modules` and `providers/*.yaml` |
| Product docs | `docs/` |

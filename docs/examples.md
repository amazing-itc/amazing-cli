# Examples

Replace the host port with `3200` if you started the process with `npm start` instead of Compose. The bearer below is the example key from `.env.example`.

## List providers

```bash
curl -s http://localhost:13200/v1/providers \
  -H 'Authorization: Bearer local-dev-amazing-cli-key-0123456789' \
  -H 'X-Amazing-Product: aw'
```

## List models for one family

```bash
curl -s http://localhost:13200/v1/providers/fake/models \
  -H 'Authorization: Bearer local-dev-amazing-cli-key-0123456789' \
  -H 'X-Amazing-Product: aw'
```

`external` lists the live LiteLLM catalog. A native family lists that CLI's catalog when the binary is installed.

## Fake end to end

No Docker, `family=fake`, including a session:

```bash
npm run e2e:fake
```

A real Cursor resume needs a running server and a Cursor credential sent on the run, not in the amazing-cli environment:

```bash
npm run e2e:cursor
```

## Session shape

Create with `POST /v1/sessions`, send work with `POST /v1/sessions/{id}/turns`, read `GET /v1/sessions/{id}/events`, close with `DELETE /v1/sessions/{id}`. Field names and schemas are in [openapi.yaml](../openapi.yaml). Do not invent a second contract in a client.

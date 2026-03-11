# AI Gateway

Single-node local-auth AI gateway for Codex OAuth.

## Features

- `POST /v1/chat/completions` with JSON or SSE streaming responses
- Static bearer-token auth
- Direct Codex backend calls through `https://chatgpt.com/backend-api/codex/responses`
- Internal run APIs for future agent workflows
- In-memory run registry, queueing, timeout, cancel support

## Configuration

- `PORT`: HTTP port, default `8787`
- `GATEWAY_AUTH_TOKEN`: required bearer token
- `CODEX_WORKSPACE_ROOT`: allowed workspace root, default current working directory
- `MAX_CONCURRENT_RUNS`: default `2`
- `REQUEST_TIMEOUT_MS`: default `120000`
- `ENABLE_AGENT_ENDPOINTS`: `true` to enable internal run APIs, default `false`
- `CODEX_AUTH_FILE`: path to Codex auth file, default `~/.codex/auth.json`
- `CODEX_ACCESS_TOKEN`: optional explicit access token override
- `CODEX_REFRESH_TOKEN`: optional explicit refresh token override
- `CODEX_ACCOUNT_ID`: optional explicit account id override
- `CODEX_BASE_URL`: default `https://chatgpt.com/backend-api`
- `CODEX_MODEL`: default `gpt-5-codex`

## Run

```bash
GATEWAY_AUTH_TOKEN=dev-token npm start
```

## Example

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"codex-default",
    "messages":[
      {"role":"system","content":"Be concise."},
      {"role":"user","content":"Say hello."}
    ]
  }'
```

### Test Case

Request body:

```json
{
  "model": "gpt-5.3-codex",
  "stream": false,
  "messages": [
    { "role": "system", "content": "Be professional." },
    { "role": "user", "content": "你好gpt你是什么模型？" }
  ]
}
```

`curl` example:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.3-codex",
    "stream":false,
    "messages":[
      {"role":"system","content":"Be professional."},
      {"role":"user","content":"你好gpt你是什么模型？"}
    ]
  }'
```

## Notes

- This reads your local Codex OAuth state from `~/.codex/auth.json` by default.
- Normal completions no longer shell out to `codex exec`, which reduces latency a lot for simple requests.
- v1 only supports text generation semantics on the OpenAI-compatible endpoint.

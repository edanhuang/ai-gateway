# AI Gateway Technical Architecture

## Overview

This project is a local-auth AI gateway that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint while reusing a machine's existing Codex OAuth
session. The current implementation is optimized for low-latency text
generation and internal use, not for multi-tenant public SaaS operation.

## OpenClaw Insights

The review of `openclaw` showed two distinct Codex integration paths:

1. `openai-codex`
   - Direct provider integration
   - OAuth PKCE login flow
   - Token storage in a dedicated auth profile store
   - Direct transport to `chatgpt.com/backend-api`
   - WebSocket-first with SSE fallback

2. `codex-cli`
   - CLI backend fallback
   - Text-only safety-net path
   - Slower because each request depends on local CLI execution/session behavior

The key architectural lesson is that the low-latency path is not the CLI
wrapper. The low-latency path is direct provider transport with managed auth.

## Our Current Implementation

### Request Path

1. Client calls `POST /v1/chat/completions`
2. Gateway validates the OpenAI-style request body
3. Gateway converts `messages` into:
   - `instructions` from `system` messages
   - `input` items from `user` and `assistant` messages
4. Gateway reads local Codex auth state from `~/.codex/auth.json` by default
5. Gateway sends a direct SSE request to:
   - `https://chatgpt.com/backend-api/codex/responses`
6. Gateway parses upstream response events and maps them back to:
   - JSON response for non-streaming clients
   - SSE chunks for streaming clients

### Auth Strategy

The gateway currently reuses the existing Codex auth file instead of owning the
full OAuth lifecycle itself.

Supported auth inputs:

- `CODEX_AUTH_FILE`
- `CODEX_ACCESS_TOKEN`
- `CODEX_REFRESH_TOKEN`
- `CODEX_ACCOUNT_ID`

Current behavior:

- Reads access token from env override or `~/.codex/auth.json`
- Sends it as `Authorization: Bearer ...`
- Retries once after re-reading credentials on upstream `401`

Current limitation:

- The gateway does not yet run its own PKCE login flow
- The gateway does not yet own refresh-token exchange logic

### Transport Strategy

The gateway currently uses direct SSE transport to the Codex backend.

Why SSE first:

- Much simpler than WebSocket
- Large latency improvement already achieved compared with `codex exec`
- Lower implementation and operational risk for the current scope

### Run Management

The internal run manager is still in place for:

- queueing
- cancellation
- timeout handling
- run lifecycle inspection

For now, it mainly wraps text-generation requests. The `workspace` and
`sandbox` fields remain in the internal API as placeholders for future agent
mode expansion.

## Latency Findings

Observed behavior during implementation:

- CLI-wrapper path: roughly 3.7s to 5.5s for a trivial prompt
- Direct Codex backend path: roughly 1.6s for the same prompt

Primary reason for the improvement:

- no local CLI process startup
- no CLI JSONL parsing overhead
- no extra local orchestration between gateway and provider

## Public Project Assessment

This repository can become public if the following conditions are met:

1. No real credentials or auth files are committed
2. `openclaw-inspect/` remains ignored
3. No generated local state is committed later

Important public-repo caveats:

- The project depends on local Codex OAuth state
- It targets `chatgpt.com/backend-api`, which is more fragile than official API-key flows
- You should not present it as an official OpenAI integration

## Recommended Next Steps

### 1. Full OAuth Ownership

Add a first-class auth module that supports:

- PKCE login
- local callback capture
- manual redirect URL paste flow for headless/Docker
- refresh-token exchange
- locked writes to a dedicated gateway auth store

Target result:

- no hard runtime dependence on `~/.codex/auth.json`

### 2. Dedicated Gateway Auth Store

Move credentials into a gateway-owned file, for example:

- `state/auth-profiles.json`

Capabilities to add:

- primary store
- atomic writes
- profile rotation
- optional multi-account support

### 3. WebSocket Transport

Add WebSocket-first transport for lower first-token latency.

Target behavior:

- default `auto`
- WebSocket primary
- SSE fallback on connection failure

### 4. Model Discovery

Add `GET /v1/models` with a controlled allowlist and/or runtime discovery.

### 5. Better Production Guardrails

Add:

- structured request tracing
- upstream error normalization
- auth health diagnostics
- rate limiting
- per-token access controls
- request logging with prompt redaction

### 6. Agent Expansion

If agent mode is required later, split the API surface:

- OpenAI-compatible text endpoint
- internal agent endpoint with explicit higher-trust controls

Do not mix dangerous tool execution into the default OpenAI-compatible path.

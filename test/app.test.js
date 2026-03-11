import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { CodexAuthStore } from "../src/codex-auth.js";
import { CodexResponsesClient } from "../src/codex-responses.js";
import { RunManager } from "../src/run-manager.js";
import { createRequestHandler } from "../src/server.js";

function sseResponse(events) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const { event, data } of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.close();
    }
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream"
    }
  });
}

function makeFetch({ fail = false } = {}) {
  return async () => {
    if (fail) {
      return new Response(
        JSON.stringify({
          error: { message: "upstream failed", code: "mock_failure" }
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return sseResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_1", model: "gpt-5-codex" }
        }
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          delta: "Echo:"
        }
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          delta: " done"
        }
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_1",
            model: "gpt-5-codex",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12
            },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Echo: done" }]
              }
            ]
          }
        }
      }
    ]);
  };
}

function makeApp(overrides = {}, dependencies = {}) {
  const config = {
    ...loadConfig({
      GATEWAY_AUTH_TOKEN: "test-token",
      CODEX_WORKSPACE_ROOT: process.cwd(),
      MAX_CONCURRENT_RUNS: "2",
      REQUEST_TIMEOUT_MS: "3000",
      ENABLE_AGENT_ENDPOINTS: "true",
      CODEX_ACCESS_TOKEN: "header.payload.signature",
      CODEX_ACCOUNT_ID: "acct_1"
    }),
    ...overrides
  };
  const logger = createLogger();
  const authStore = new CodexAuthStore({
    config,
    logger,
    readFile: dependencies.readFile
  });
  const runner = new CodexResponsesClient({
    config,
    logger,
    authStore,
    fetchImpl: dependencies.fetchImpl || makeFetch()
  });
  const runManager = new RunManager({ config, logger, runner });
  const handler = createRequestHandler({ config, logger, runManager });
  return { config, logger, runner, runManager, handler };
}

function authHeaders(extra = {}) {
  return {
    authorization: "Bearer test-token",
    "content-type": "application/json",
    ...extra
  };
}

async function invoke(handler, { method, url, headers = {}, body }) {
  const chunks = [];
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  request.method = method;
  request.url = url;
  request.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  const response = {
    statusCode: 200,
    headers: {},
    ended: false,
    writeHead(statusCode, responseHeaders) {
      this.statusCode = statusCode;
      this.headers = { ...responseHeaders };
      return this;
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk = "") {
      if (chunk) {
        this.write(chunk);
      }
      this.ended = true;
    }
  };

  await handler(request, response);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    bodyText: Buffer.concat(chunks).toString("utf8")
  };
}

test("rejects unauthorized requests", async () => {
  const { handler } = makeApp();

  const response = await invoke(handler, {
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: {
      model: "codex-default",
      messages: [{ role: "user", content: "hello" }]
    }
  });

  assert.equal(response.statusCode, 401);
});

test("returns chat completion response", async () => {
  const { handler } = makeApp();

  const response = await invoke(handler, {
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeaders(),
    body: {
      model: "codex-default",
      messages: [{ role: "user", content: "hello world" }]
    }
  });
  const payload = JSON.parse(response.bodyText);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.object, "chat.completion");
  assert.match(payload.choices[0].message.content, /Echo:/);
  assert.deepEqual(payload.usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12
  });
});

test("streams chat completion chunks", async () => {
  const { handler } = makeApp();

  const response = await invoke(handler, {
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeaders(),
    body: {
      model: "codex-default",
      stream: true,
      messages: [{ role: "user", content: "hello stream" }]
    }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.bodyText, /chat\.completion\.chunk/);
  assert.match(response.bodyText, /\[DONE\]/);
});

test("surfaces provider execution failure", async () => {
  const { handler } = makeApp({}, { fetchImpl: makeFetch({ fail: true }) });

  const response = await invoke(handler, {
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeaders(),
    body: {
      model: "codex-default",
      messages: [{ role: "user", content: "hello failure" }]
    }
  });
  const payload = JSON.parse(response.bodyText);

  assert.equal(response.statusCode, 500);
  assert.equal(payload.error.type, "server_error");
});

test("supports internal run lifecycle", async () => {
  const { handler } = makeApp();

  const createResponse = await invoke(handler, {
    method: "POST",
    url: "/internal/agent/runs",
    headers: authHeaders(),
    body: {
      prompt: "agent run",
      mode: "text",
      workspace: process.cwd(),
      sandbox: "read-only",
      timeout_ms: 1000
    }
  });
  const created = JSON.parse(createResponse.bodyText);
  assert.equal(createResponse.statusCode, 202);
  assert.ok(created.run_id);

  await new Promise((resolve) => setTimeout(resolve, 25));

  const getResponse = await invoke(handler, {
    method: "GET",
    url: `/internal/agent/runs/${created.run_id}`,
    headers: { authorization: "Bearer test-token" }
  });
  const details = JSON.parse(getResponse.bodyText);

  assert.equal(getResponse.statusCode, 200);
  assert.equal(details.provider, "codex");
  assert.ok(["running", "completed"].includes(details.status));
});

test("rejects workspace outside root", async () => {
  const { handler } = makeApp();

  const response = await invoke(handler, {
    method: "POST",
    url: "/internal/agent/runs",
    headers: authHeaders(),
    body: {
      prompt: "agent run",
      mode: "text",
      workspace: "/tmp",
      sandbox: "read-only"
    }
  });

  assert.equal(response.statusCode, 403);
});

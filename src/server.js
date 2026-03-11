import http from "node:http";
import { HttpError } from "./errors.js";
import { readJsonBody, json, sanitizeError, createId } from "./utils.js";
import {
  buildPromptFromMessages,
  toChatCompletionChunk,
  toChatCompletionResponse,
  validateChatCompletionRequest
} from "./openai.js";
import { startSse, sendSseEvent, endSse } from "./sse.js";
import {
  buildCodexRequestFromMessages,
  buildCodexRequestFromPrompt,
  resolveGatewayModel
} from "./codex-responses.js";

function unauthorized(response) {
  json(response, 401, {
    error: {
      message: "Unauthorized",
      type: "authentication_error"
    }
  });
}

export function createServer({ config, logger, runManager }) {
  const handler = createRequestHandler({ config, logger, runManager });
  return http.createServer(handler);
}

export function createRequestHandler({ config, logger, runManager }) {
  return async (request, response) => {
    const startedAt = Date.now();
    try {
      authorize(request, config);

      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(request);
        validateChatCompletionRequest(body);
        await handleChatCompletion({ body, response, runManager, config });
        logRequest(logger, request, response.statusCode, startedAt);
        return;
      }

      if (!config.enableAgentEndpoints && url.pathname.startsWith("/internal/agent")) {
        throw new HttpError(404, "Not found");
      }

      if (request.method === "POST" && url.pathname === "/internal/agent/runs") {
        const body = await readJsonBody(request);
        const run = runManager.createRun({
          prompt: String(body.prompt || ""),
          request: buildCodexRequestFromPrompt(String(body.prompt || "")),
          model: resolveGatewayModel(body.model, config),
          mode: body.mode || "text",
          workspace: body.workspace,
          sandbox: body.sandbox || "read-only",
          timeoutMs: body.timeout_ms
        });
        json(response, 202, {
          run_id: run.id,
          provider: run.provider,
          status: run.status,
          created_at: run.createdAt
        });
        logRequest(logger, request, response.statusCode, startedAt);
        return;
      }

      const runIdMatch = url.pathname.match(/^\/internal\/agent\/runs\/([^/]+)$/);
      if (request.method === "GET" && runIdMatch) {
        json(response, 200, runManager.getRun(runIdMatch[1]));
        logRequest(logger, request, response.statusCode, startedAt);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/internal\/agent\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        json(response, 200, runManager.cancelRun(cancelMatch[1]));
        logRequest(logger, request, response.statusCode, startedAt);
        return;
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      handleError({ error, response, logger, request, startedAt });
    }
  };
}

function authorize(request, config) {
  if (!config.authToken) {
    return;
  }

  const header = request.headers.authorization || "";
  if (header !== `Bearer ${config.authToken}`) {
    throw new HttpError(401, "Unauthorized");
  }
}

async function handleChatCompletion({ body, response, runManager, config }) {
  const prompt = buildPromptFromMessages(body.messages);
  const model = resolveGatewayModel(body.model, config);
  const run = runManager.createRun({
    prompt,
    request: buildCodexRequestFromMessages(body.messages),
    model,
    mode: "text",
    workspace: config.workspaceRoot,
    sandbox: "read-only",
    timeoutMs: config.requestTimeoutMs
  });

  if (body.stream) {
    const chunkId = createId("chatcmpl");
    startSse(response);
    sendSseEvent(response, toChatCompletionChunk({
      id: chunkId,
      model,
      delta: { role: "assistant" }
    }));

    let lastLength = 0;
    const interval = setInterval(() => {
      const internal = runManager.runs.get(run.id);
      if (!internal) {
        return;
      }

      const nextText = internal.outputText.slice(lastLength);
      if (nextText) {
        lastLength = internal.outputText.length;
        sendSseEvent(response, toChatCompletionChunk({
          id: chunkId,
          model,
          delta: { content: nextText }
        }));
      }
    }, 100);

    try {
      await runManager.waitForCompletion(run.id);
      const internal = runManager.runs.get(run.id);
      const tail = internal.outputText.slice(lastLength);
      if (tail) {
        sendSseEvent(response, toChatCompletionChunk({
          id: chunkId,
          model,
          delta: { content: tail }
        }));
      }
      sendSseEvent(response, toChatCompletionChunk({
        id: chunkId,
        model,
        delta: {},
        finishReason: "stop"
      }));
      endSse(response);
    } finally {
      clearInterval(interval);
    }
    return;
  }

  await runManager.waitForCompletion(run.id);
  const internal = runManager.runs.get(run.id);
  json(response, 200, toChatCompletionResponse({
    model,
    content: internal.outputText,
    usage: internal.usage
  }));
}

function handleError({ error, response, logger, request, startedAt }) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  if (statusCode === 401) {
    unauthorized(response);
  } else {
    json(response, statusCode, {
      error: {
        message: error.message || "Internal server error",
        type: statusCode >= 500 ? "server_error" : "invalid_request_error",
        details: error.details
      }
    });
  }

  logger.error("request_failed", {
    path: request.url,
    method: request.method,
    statusCode,
    durationMs: Date.now() - startedAt,
    error: sanitizeError(error)
  });
}

function logRequest(logger, request, statusCode, startedAt) {
  logger.info("request_complete", {
    path: request.url,
    method: request.method,
    statusCode,
    durationMs: Date.now() - startedAt
  });
}

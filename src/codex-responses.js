import { CodexExecutionError, HttpError } from "./errors.js";

const DEFAULT_INSTRUCTIONS = "You are Codex. Reply concisely and directly.";
const DEFAULT_PROVIDER = "codex";

export function resolveGatewayProvider(requestedProvider) {
  const provider = String(requestedProvider || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!provider) {
    return DEFAULT_PROVIDER;
  }
  if (provider !== DEFAULT_PROVIDER) {
    throw new HttpError(400, `Unsupported provider: ${provider}`, {
      code: "unsupported_provider",
      provider
    });
  }
  return provider;
}

export function resolveGatewayModel(requestedModel, config) {
  if (!requestedModel || requestedModel === "codex-default") {
    return config.codexModel;
  }

  return requestedModel;
}

export function buildCodexRequestFromMessages(messages) {
  const systemMessages = [];
  const input = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
      continue;
    }

    input.push({
      type: "message",
      role: message.role,
      content: message.content
    });
  }

  if (input.length === 0) {
    input.push({
      type: "message",
      role: "user",
      content: ""
    });
  }

  return {
    instructions: systemMessages.join("\n\n").trim() || DEFAULT_INSTRUCTIONS,
    input
  };
}

export function buildCodexRequestFromPrompt(prompt) {
  return {
    instructions: DEFAULT_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: prompt
      }
    ]
  };
}

function extractAssistantTextFromCompletedEvent(event) {
  const output = event?.response?.output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .filter((item) => item?.type === "message" && item?.role === "assistant")
    .flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

function parseErrorPayload(payload, fallbackStatus) {
  if (!payload) {
    return {
      status: fallbackStatus,
      code: "unknown_error",
      message: "Unknown upstream error"
    };
  }

  if (typeof payload.detail === "string") {
    return {
      status: fallbackStatus,
      code: "upstream_error",
      message: payload.detail
    };
  }

  if (payload.error && typeof payload.error === "object") {
    return {
      status: fallbackStatus,
      code: payload.error.code || "upstream_error",
      message: payload.error.message || "Unknown upstream error"
    };
  }

  return {
    status: fallbackStatus,
    code: "upstream_error",
    message: typeof payload === "string" ? payload : JSON.stringify(payload)
  };
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseSseChunk(chunkBuffer, onEvent) {
  const events = [];
  let rest = chunkBuffer;

  while (true) {
    const boundaryIndex = rest.indexOf("\n\n");
    if (boundaryIndex === -1) {
      break;
    }

    const rawEvent = rest.slice(0, boundaryIndex);
    rest = rest.slice(boundaryIndex + 2);
    const lines = rawEvent.split("\n");
    let eventType = "message";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const dataText = dataLines.join("\n");
    if (!dataText) {
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      continue;
    }

    events.push({ eventType, payload });
    onEvent?.(payload, eventType);
  }

  return { events, rest };
}

export class CodexResponsesClient {
  constructor({ config, logger, authStore, fetchImpl = fetch }) {
    this.config = config;
    this.logger = logger;
    this.authStore = authStore;
    this.fetchImpl = fetchImpl;
  }

  run(options) {
    const abortController = new AbortController();
    const completion = this.execute({
      ...options,
      signal: abortController.signal
    });

    return {
      async wait() {
        return completion;
      },
      cancel() {
        abortController.abort();
      }
    };
  }

  async execute(options) {
    const startedAt = Date.now();
    const provider = resolveGatewayProvider(options.provider);
    const model = resolveGatewayModel(options.model, this.config);
    const requestBody = {
      model,
      ...(options.request || buildCodexRequestFromPrompt(options.prompt || "")),
      store: false,
      stream: true,
      text: {
        format: { type: "text" },
        verbosity: "medium"
      }
    };

    let credentials = await this.authStore.readCredentials();
    let response = await this.fetchSseResponse({
      provider,
      credentials,
      body: requestBody,
      signal: options.signal
    });

    if (response.status === 401) {
      credentials = await this.authStore.readCredentials();
      response = await this.fetchSseResponse({
        provider,
        credentials,
        body: requestBody,
        signal: options.signal
      });
    }

    if (!response.ok) {
      const payload = await readJsonSafe(response);
      const errorInfo = parseErrorPayload(payload, response.status);
      throw new CodexExecutionError(errorInfo.message, {
        code: errorInfo.code,
        status: errorInfo.status
      });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new CodexExecutionError("Codex upstream returned no response body", {
        code: "missing_body"
      });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let outputText = "";
    let usage = null;
    let responseId = "";
    let responseModel = model;
    let firstDeltaAt = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer, options.onRawEvent);
      buffer = parsed.rest;

      for (const { payload } of parsed.events) {
        if (payload?.type === "response.created") {
          responseId = payload.response?.id || responseId;
          responseModel = payload.response?.model || responseModel;
        }

        if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") {
          outputText += payload.delta;
          if (firstDeltaAt == null) {
            firstDeltaAt = Date.now();
          }
          options.onTextDelta?.(payload.delta, payload);
        }

        if (payload?.type === "response.completed") {
          responseId = payload.response?.id || responseId;
          responseModel = payload.response?.model || responseModel;
          usage = payload.response?.usage || null;
          if (!outputText) {
            const completedText = extractAssistantTextFromCompletedEvent(payload);
            if (completedText) {
              outputText = completedText;
            }
          }
        }
      }
    }

    if (!outputText.trim()) {
      throw new CodexExecutionError("Codex upstream produced no assistant text", {
        code: "empty_output"
      });
    }

    return {
      outputText,
      responseId,
      model: responseModel,
      provider,
      usage,
      metrics: {
        totalMs: Date.now() - startedAt,
        firstDeltaMs: firstDeltaAt == null ? null : firstDeltaAt - startedAt
      }
    };
  }

  async fetchSseResponse({ provider, credentials, body, signal }) {
    if (provider !== DEFAULT_PROVIDER) {
      throw new HttpError(400, `Unsupported provider: ${provider}`, {
        code: "unsupported_provider",
        provider
      });
    }

    const headers = {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    };

    if (credentials.accountId) {
      headers["ChatGPT-Account-Id"] = credentials.accountId;
    }

    return this.fetchImpl(`${this.config.codexBaseUrl}/codex/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
  }
}

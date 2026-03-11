import { createId, nowSeconds } from "./utils.js";

const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

export function validateChatCompletionRequest(body) {
  if (!body || typeof body !== "object") {
    throw new TypeError("Request body must be a JSON object");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new TypeError("messages must be a non-empty array");
  }

  for (const message of body.messages) {
    if (!SUPPORTED_MESSAGE_ROLES.has(message?.role)) {
      throw new TypeError("messages role must be system, user, or assistant");
    }

    if (typeof message?.content !== "string") {
      throw new TypeError("messages content must be a string");
    }
  }
}

export function buildPromptFromMessages(messages) {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

function toUsage(usage) {
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))
  };
}

export function toChatCompletionResponse({ model, content, finishReason = "stop", usage = null }) {
  return {
    id: createId("chatcmpl"),
    object: "chat.completion",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: finishReason
      }
    ],
    usage: toUsage(usage)
  };
}

export function toChatCompletionChunk({ id, model, delta, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
}

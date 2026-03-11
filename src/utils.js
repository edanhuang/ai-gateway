import crypto from "node:crypto";

export function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function sanitizeError(error) {
  return {
    message: error?.message || "Unknown error",
    type: error?.name || "Error"
  };
}

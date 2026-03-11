import path from "node:path";
import { resolveDefaultCodexAuthFile } from "./codex-auth.js";

function parseBoolean(value, defaultValue = false) {
  if (value == null) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function loadConfig(env = process.env) {
  return {
    port: parseInteger(env.PORT, 8787),
    authToken: env.GATEWAY_AUTH_TOKEN || "",
    workspaceRoot: path.resolve(env.CODEX_WORKSPACE_ROOT || process.cwd()),
    maxConcurrentRuns: parseInteger(env.MAX_CONCURRENT_RUNS, 2),
    requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, 120000),
    enableAgentEndpoints: parseBoolean(env.ENABLE_AGENT_ENDPOINTS, false),
    codexAuthFile: path.resolve(env.CODEX_AUTH_FILE || resolveDefaultCodexAuthFile()),
    codexAccessToken: env.CODEX_ACCESS_TOKEN || "",
    codexRefreshToken: env.CODEX_REFRESH_TOKEN || "",
    codexAccountId: env.CODEX_ACCOUNT_ID || "",
    codexBaseUrl: env.CODEX_BASE_URL || "https://chatgpt.com/backend-api",
    codexModel: env.CODEX_MODEL || "gpt-5-codex"
  };
}

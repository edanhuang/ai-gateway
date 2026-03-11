import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexExecutionError } from "./errors.js";

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function resolveDefaultCodexAuthFile() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export class CodexAuthStore {
  constructor({ config, logger, readFile = fs.readFile }) {
    this.config = config;
    this.logger = logger;
    this.readFile = readFile;
  }

  async readCredentials() {
    if (this.config.codexAccessToken) {
      const payload = decodeJwtPayload(this.config.codexAccessToken);
      return {
        accessToken: this.config.codexAccessToken,
        refreshToken: this.config.codexRefreshToken || "",
        accountId: this.config.codexAccountId || payload?.account_id || payload?.accountId || "",
        expiresAtMs: typeof payload?.exp === "number" ? payload.exp * 1000 : null,
        source: "env"
      };
    }

    let parsed;
    try {
      const raw = await this.readFile(this.config.codexAuthFile, "utf8");
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CodexExecutionError("Unable to read Codex auth file", {
        code: "auth_unavailable",
        authFile: this.config.codexAuthFile,
        cause: error instanceof Error ? error.message : String(error)
      });
    }

    const accessToken = parsed?.tokens?.access_token || parsed?.tokens?.accessToken || "";
    const refreshToken = parsed?.tokens?.refresh_token || parsed?.tokens?.refreshToken || "";
    const accountId = parsed?.tokens?.account_id || parsed?.tokens?.accountId || "";
    if (!accessToken) {
      throw new CodexExecutionError("Codex auth file does not contain an access token", {
        code: "auth_missing_access_token",
        authFile: this.config.codexAuthFile
      });
    }

    const payload = decodeJwtPayload(accessToken);
    return {
      accessToken,
      refreshToken,
      accountId: accountId || payload?.account_id || payload?.accountId || "",
      expiresAtMs: typeof payload?.exp === "number" ? payload.exp * 1000 : null,
      source: "file"
    };
  }
}

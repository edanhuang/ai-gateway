import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { CodexAuthStore } from "./codex-auth.js";
import { CodexResponsesClient } from "./codex-responses.js";
import { RunManager } from "./run-manager.js";
import { createServer } from "./server.js";

const config = loadConfig();
const logger = createLogger();
const authStore = new CodexAuthStore({ config, logger });
const runner = new CodexResponsesClient({ config, logger, authStore });
const runManager = new RunManager({ config, logger, runner });
const server = createServer({ config, logger, runManager });

server.listen(config.port, () => {
  logger.info("server_listening", {
    port: config.port,
    workspaceRoot: config.workspaceRoot,
    maxConcurrentRuns: config.maxConcurrentRuns,
    enableAgentEndpoints: config.enableAgentEndpoints
  });
});

import path from "node:path";
import { createId } from "./utils.js";
import { HttpError } from "./errors.js";

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class RunManager {
  constructor({ config, logger, runner }) {
    this.config = config;
    this.logger = logger;
    this.runner = runner;
    this.runs = new Map();
    this.queue = [];
    this.activeCount = 0;
  }

  listableRun(run) {
    return {
      id: run.id,
      provider: run.provider,
      mode: run.mode,
      status: run.status,
      workspace: run.workspace,
      sandbox: run.sandbox,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      timeoutMs: run.timeoutMs,
      error: run.error,
      outputPreview: run.outputPreview,
      model: run.model,
      responseId: run.responseId,
      metrics: run.metrics
    };
  }

  createRun({ prompt, request, model, mode = "text", workspace, sandbox = "read-only", timeoutMs }) {
    const resolvedWorkspace = path.resolve(workspace || this.config.workspaceRoot);
    if (!isWithin(this.config.workspaceRoot, resolvedWorkspace)) {
      throw new HttpError(403, "workspace is outside CODEX_WORKSPACE_ROOT");
    }

    const run = {
      id: createId("run"),
      provider: "codex",
      mode,
      prompt,
      request: request || null,
      model: model || null,
      workspace: resolvedWorkspace,
      sandbox,
      timeoutMs: timeoutMs || this.config.requestTimeoutMs,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      outputText: "",
      outputPreview: "",
      error: null,
      process: null,
      cancelRequested: false,
      responseId: null,
      usage: null,
      metrics: null
    };

    this.runs.set(run.id, run);
    const completion = new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });
    completion.catch(() => {});
    run.completion = completion;
    this.queue.push(run);
    this.pump();
    return run;
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HttpError(404, "run not found");
    }

    return this.listableRun(run);
  }

  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HttpError(404, "run not found");
    }

    run.cancelRequested = true;

    if (run.status === "queued") {
      run.status = "cancelled";
      run.endedAt = new Date().toISOString();
      run.error = { code: "cancelled", message: "Run cancelled before start" };
      run.reject?.(new Error("cancelled"));
      this.queue = this.queue.filter((item) => item.id !== runId);
      return this.listableRun(run);
    }

    if (run.status === "running" && run.process) {
      run.process.cancel();
    }

    return this.listableRun(run);
  }

  async waitForCompletion(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HttpError(404, "run not found");
    }

    return run.completion;
  }

  pump() {
    while (this.activeCount < this.config.maxConcurrentRuns && this.queue.length > 0) {
      const run = this.queue.shift();
      this.executeRun(run);
    }
  }

  async executeRun(run) {
    this.activeCount += 1;
    run.status = "running";
    run.startedAt = new Date().toISOString();

    const timer = setTimeout(() => {
      if (run.status === "running" && run.process) {
        run.process.cancel();
      }
    }, run.timeoutMs);

    try {
      const processHandle = this.runner.run({
        model: run.model,
        request: run.request,
        prompt: run.prompt,
        workspace: run.workspace,
        sandbox: run.sandbox,
        onTextDelta: (delta) => {
          run.outputText += delta;
          run.outputPreview = preview(run.outputText);
        }
      });
      run.process = processHandle;

      const result = await processHandle.wait();
      run.status = "completed";
      run.endedAt = new Date().toISOString();
      run.outputText = result.outputText;
      run.outputPreview = preview(result.outputText);
      run.responseId = result.responseId;
      run.model = result.model || run.model;
      run.usage = result.usage || null;
      run.metrics = result.metrics || null;
      run.resolve?.(this.listableRun(run));
    } catch (error) {
      run.status = run.cancelRequested ? "cancelled" : "failed";
      run.endedAt = new Date().toISOString();
      run.error = {
        code: error?.details?.code || (run.cancelRequested ? "cancelled" : "run_failed"),
        message: error?.message || "Run failed"
      };
      run.reject?.(error);
    } finally {
      clearTimeout(timer);
      run.process = null;
      this.activeCount -= 1;
      this.pump();
    }
  }
}

function preview(text, size = 160) {
  if (!text) {
    return "";
  }

  if (text.length <= size) {
    return text;
  }

  return `${text.slice(0, size)}...`;
}

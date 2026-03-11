export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class CodexExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexExecutionError";
    this.details = details;
  }
}

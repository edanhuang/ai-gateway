function redactText(value) {
  if (!value) {
    return value;
  }

  return `${String(value).slice(0, 32)}...[redacted]`;
}

export function createLogger() {
  function log(level, message, meta = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta
    };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    info(message, meta) {
      log("info", message, meta);
    },
    warn(message, meta) {
      log("warn", message, meta);
    },
    error(message, meta) {
      log("error", message, meta);
    },
    redactText
  };
}

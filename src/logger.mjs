export class StructuredLogger {
  constructor({ sink = process.stdout } = {}) {
    this.sink = sink;
  }

  info(message, fields = {}) {
    this.write("info", message, fields);
  }

  warn(message, fields = {}) {
    this.write("warn", message, fields);
  }

  error(message, fields = {}) {
    this.write("error", message, fields);
  }

  write(level, message, fields) {
    const parts = [
      `level=${level}`,
      `message=${JSON.stringify(message)}`,
      ...Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ];
    try {
      this.sink.write(`${parts.join(" ")}\n`);
    } catch {
      // Logging must not crash orchestration.
    }
  }
}

export function nullLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

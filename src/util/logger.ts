// Simple logging abstraction for the sentinel project.
// Phase 1: wrap console with a tiny helper so we can evolve logging later without touching tests.

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, namespace: string, message: string, ...args: unknown[]): void {
  const prefix = `[${namespace}]`;
  // eslint-disable-next-line no-console
  console[level](`${prefix} ${message}`, ...args);
}

export function createLogger(namespace: string) {
  return {
    info: (message: string, ...args: unknown[]) => log("info", namespace, message, ...args),
    warn: (message: string, ...args: unknown[]) => log("warn", namespace, message, ...args),
    error: (message: string, ...args: unknown[]) => log("error", namespace, message, ...args),
    debug: (message: string, ...args: unknown[]) => log("debug", namespace, message, ...args),
  };
}



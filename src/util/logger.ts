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

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Generic, reusable check-result logger.
 *
 * Example output:
 *   [sanity/connection] StorageHub connection: [OK]
 *   [sanity/connection] MSP connection: [FAIL] - timed out
 */
export function logCheckResult(
  namespace: string,
  label: string,
  ok: boolean,
  error?: unknown,
): void {
  const status = ok ? "[OK]" : "[FAIL]";
  const suffix = ok || error === undefined ? "" : ` - ${formatError(error)}`;
  // eslint-disable-next-line no-console
  console.log(`[${namespace}] ${label}: ${status}${suffix}`);
}

export function logSectionSeparator(label?: string): void {
  const base = "----------";
  // eslint-disable-next-line no-console
  console.log(label ? `${base} ${label} ${base}` : base);
}


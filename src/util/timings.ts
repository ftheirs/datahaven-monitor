// Basic timing utilities (stub).
// Phase 1: tiny helper to measure duration of async operations.

export interface TimingResult<T> {
  readonly result: T;
  readonly durationMs: number;
}

export async function timeAsync<T>(fn: () => Promise<T>): Promise<TimingResult<T>> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();

  return {
    result,
    durationMs: end - start,
  };
}



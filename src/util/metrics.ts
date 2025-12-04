// Basic in-memory metrics aggregation (stub).
// Phase 1: simple counters; can be extended with histograms and exports later.

export interface CounterMetric {
  readonly name: string;
  readonly value: number;
}

const counters = new Map<string, number>();

export function incrementCounter(name: string, amount = 1): void {
  const current = counters.get(name) ?? 0;
  counters.set(name, current + amount);
}

export function getCounters(): CounterMetric[] {
  return Array.from(counters.entries()).map(([name, value]) => ({
    name,
    value,
  }));
}



// Generic retry helper (stub).
// Phase 1: simple implementation with fixed delay; can be extended to exponential backoff later.

export interface RetryOptions {
	readonly retries: number;
	readonly delayMs: number;
}

export async function retry<T>(
	fn: () => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	const { retries, delayMs } = options;
	let attempt = 0;

	// Basic loop; later we can add jitter, backoff, and onRetry hooks.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			return await fn();
		} catch (error) {
			attempt += 1;
			if (attempt > retries) {
				throw error;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, delayMs);
			});
		}
	}
}

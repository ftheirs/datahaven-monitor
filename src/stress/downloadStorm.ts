// Stress test stub: high-rate download storm.
// Future goal: repeatedly download a set of known IDs and measure throughput and error rates.

import type { StressRunOptions } from "./index";

export async function runDownloadStorm(
	options: StressRunOptions,
): Promise<void> {
	// TODO: implement real download storm stress test.
	// eslint-disable-next-line no-console
	console.log("[stress/downloadStorm] Not implemented yet. Options:", options);
}

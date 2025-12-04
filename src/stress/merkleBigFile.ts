// Stress test stub: merkle operations on large files.
// Future goal: compute and verify merkle roots for big payloads and observe performance.

import type { StressRunOptions } from "./index";

export async function runMerkleBigFile(
	options: StressRunOptions,
): Promise<void> {
	// TODO: implement real large-file merkle stress test.
	// eslint-disable-next-line no-console
	console.log("[stress/merkleBigFile] Not implemented yet. Options:", options);
}

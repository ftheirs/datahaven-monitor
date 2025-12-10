// Stage 2: Health check

import type { MonitorContext } from "../types";

/**
 * Check MSP backend health endpoint returns healthy status
 */
export async function healthStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient) {
		throw new Error("MspClient not initialized");
	}

	console.log("[health] Checking MSP backend health...");
	const health = await ctx.mspClient.info.getHealth();

	if (health.status !== "healthy") {
		throw new Error(`MSP health check failed: ${health.status}`);
	}

	console.log(`[health] ✓ MSP backend is healthy`);
}

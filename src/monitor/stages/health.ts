// Stage 2: MSP health check

import type { MonitorContext } from "../types";

/**
 * Check MSP backend health endpoint
 */
export async function healthStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient) {
		throw new Error("MSP client not initialized");
	}

	console.log("[health] Checking MSP health...");
	const health = await ctx.mspClient.info.getHealth();

	if (health.status !== "healthy") {
		throw new Error(`MSP health check failed: ${health.status}`);
	}

	console.log("[health] ✓ MSP is healthy");
}

// Main orchestrator for DataHaven monitoring suite

import { initializeContext } from "./context";
import { authStage } from "./stages/auth";
import { bucketCreateStage } from "./stages/bucket-create";
import { bucketDeleteStage } from "./stages/bucket-delete";
import { connectionStage } from "./stages/connection";
import { fileDeleteStage } from "./stages/file-delete";
import { fileDownloadStage } from "./stages/file-download";
import { fileUploadStage } from "./stages/file-upload";
import { healthStage } from "./stages/health";
import { storageRequestStage } from "./stages/storage-request";
import type { MonitorContext, StageFunction, StageResult } from "./types";
import { generateBadges } from "./utils/badges";

const STAGES: Array<{ name: string; fn: StageFunction }> = [
	{ name: "connection", fn: connectionStage },
	{ name: "health", fn: healthStage },
	{ name: "auth", fn: authStage },
	{ name: "bucket-create", fn: bucketCreateStage },
	{ name: "storage-request", fn: storageRequestStage },
	{ name: "file-upload", fn: fileUploadStage },
	{ name: "file-download", fn: fileDownloadStage },
	{ name: "file-delete", fn: fileDeleteStage },
	{ name: "bucket-delete", fn: bucketDeleteStage },
];

/**
 * Run a single stage and capture its result
 */
async function runStage(
	name: string,
	fn: StageFunction,
	ctx: MonitorContext,
	results: StageResult[],
): Promise<void> {
	console.log(`\n${"=".repeat(80)}`);
	console.log(`[monitor] Running stage: ${name}`);
	console.log("=".repeat(80));

	const start = Date.now();
	try {
		await fn(ctx);
		const duration = Date.now() - start;
		results.push({ stage: name, status: "passed", duration });
		console.log(`[monitor] ✓ Stage ${name} passed (${duration}ms)`);
	} catch (error) {
		const duration = Date.now() - start;
		const errorMessage = error instanceof Error ? error.message : String(error);
		results.push({
			stage: name,
			status: "failed",
			error: errorMessage,
			duration,
		});
		console.error(
			`[monitor] ✗ Stage ${name} failed (${duration}ms):`,
			errorMessage,
		);
		// Don't throw - continue to next stage
	}
}

/**
 * Cleanup resources
 */
async function cleanup(ctx: MonitorContext): Promise<void> {
	console.log("\n[monitor] Cleaning up...");

	// Disconnect userApi
	try {
		if (ctx.userApi) {
			await ctx.userApi.disconnect();
			console.log("[monitor] Disconnected userApi");
		}
	} catch (error) {
		console.warn("[monitor] Failed to disconnect userApi:", error);
	}
}

/**
 * Main monitor execution
 */
export async function runMonitor(): Promise<void> {
	console.log("=".repeat(80));
	console.log("DataHaven Monitor - Testnet Sentinel");
	console.log("=".repeat(80));

	const results: StageResult[] = [];
	let ctx: MonitorContext | undefined;

	try {
		// Initialize context
		ctx = await initializeContext();

		// Run all stages sequentially
		for (const stage of STAGES) {
			await runStage(stage.name, stage.fn, ctx, results);
		}
	} catch (error) {
		console.error("[monitor] Fatal error:", error);
		process.exitCode = 1;
	} finally {
		// Cleanup
		if (ctx) {
			await cleanup(ctx);
		}

		// Generate badges
		try {
			const badgesDir = process.env.MONITOR_OUTPUT_DIR ?? "badges";
			await generateBadges(results, badgesDir);
		} catch (error) {
			console.error("[monitor] Failed to generate badges:", error);
		}

		// Print summary
		console.log("\n" + "=".repeat(80));
		console.log("Monitor Summary");
		console.log("=".repeat(80));
		for (const result of results) {
			const icon =
				result.status === "passed"
					? "✓"
					: result.status === "failed"
						? "✗"
						: "○";
			console.log(
				`${icon} ${result.stage.padEnd(20)} ${result.status.padEnd(10)} ${result.duration ? `${result.duration}ms` : ""}`,
			);
			if (result.error) {
				console.log(`  Error: ${result.error}`);
			}
		}
		console.log("=".repeat(80));

		// Exit with error if any stage failed
		const failed = results.some((r) => r.status === "failed");
		if (failed) {
			console.error("\n[monitor] ✗ Monitor failed - one or more stages failed");
			process.exitCode = 1;
		} else {
			console.log("\n[monitor] ✓ Monitor completed successfully");
		}
	}
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
	void runMonitor();
}

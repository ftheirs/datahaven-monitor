// Main monitor orchestrator

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkConfig, getPrivateKey } from "./config";
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

async function runStage(
	name: string,
	fn: StageFunction,
	ctx: MonitorContext,
	results: StageResult[],
): Promise<boolean> {
	console.log(`\n${"=".repeat(80)}`);
	console.log(`[monitor] Running stage: ${name}`);
	console.log("=".repeat(80));

	const startTime = Date.now();
	try {
		await fn(ctx);
		const duration = Date.now() - startTime;
		results.push({ stage: name, status: "passed", duration });
		console.log(`[monitor] ✓ Stage ${name} passed (${duration}ms)`);
		return true;
	} catch (error) {
		const duration = Date.now() - startTime;
		const errorMsg = error instanceof Error ? error.message : String(error);
		results.push({ stage: name, status: "failed", error: errorMsg, duration });
		console.log(`[monitor] ✗ Stage ${name} failed (${duration}ms): ${errorMsg}`);
		return false;
	}
}

async function cleanup(ctx: MonitorContext): Promise<void> {
	console.log("\n[monitor] Cleaning up resources...");

	// Disconnect userApi if connected
	if (ctx.userApi) {
		try {
			await ctx.userApi.disconnect();
			console.log("[monitor] Disconnected userApi");
		} catch (error) {
			console.log("[monitor] Failed to disconnect userApi:", error);
		}
	}
}

export async function runMonitor(): Promise<void> {
	const network = getNetworkConfig();
	const privateKey = getPrivateKey();

	console.log("=".repeat(80));
	console.log("[monitor] DataHaven Monitor");
	console.log(`[monitor] Network: ${network.name}`);
	console.log("=".repeat(80));

	// Initialize account and clients
	const account = privateKeyToAccount(privateKey);
	const walletClient = createWalletClient({
		account,
		transport: http(network.chain.evmRpcUrl),
	});
	const publicClient = createPublicClient({
		transport: http(network.chain.evmRpcUrl),
	});

	const ctx: MonitorContext = {
		network,
		account,
		walletClient,
		publicClient,
	};

	const results: StageResult[] = [];
	let failed = false;

	try {
		// Run all stages sequentially
		for (const stage of STAGES) {
			if (failed) {
				// Skip remaining stages if one failed
				results.push({
					stage: stage.name,
					status: "skipped",
					duration: 0,
				});
			} else {
				const success = await runStage(stage.name, stage.fn, ctx, results);
				if (!success) {
					failed = true;
				}
			}
		}
	} catch (error) {
		console.error("\n[monitor] Fatal error:", error);
		failed = true;
	} finally {
		// Cleanup resources
		await cleanup(ctx);

		// Generate badges
		console.log("\n[monitor] Generating badges...");
		await generateBadges(results);

		// Print summary
		console.log("\n" + "=".repeat(80));
		console.log("Monitor Summary");
		console.log("=".repeat(80));
		for (const result of results) {
			const icon = result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○";
			const status = result.status.padEnd(10);
			const duration = `${result.duration}ms`.padStart(8);
			console.log(`${icon} ${result.stage.padEnd(20)} ${status} ${duration}`);
			if (result.error) {
				console.log(`  Error: ${result.error}`);
			}
		}
		console.log("=".repeat(80));

		if (failed) {
			console.log("\n[monitor] ✗ Monitor failed - one or more stages failed");
			process.exitCode = 1;
		} else {
			console.log("\n[monitor] ✓ Monitor completed successfully");
			process.exitCode = 0;
		}
	}
}

// Run monitor if executed directly
if (import.meta.main) {
	runMonitor().catch((err) => {
		console.error("❌ Monitor crashed:", err);
		process.exit(1);
	});
}


// Stage 8: File deletion

import type { FileInfo } from "@storagehub-sdk/core";
import { pollBackend, waitForFinalization } from "../utils/waits";
import type { MonitorContext } from "../types";

/**
 * Request file deletion on-chain and verify cleanup
 */
export async function fileDeleteStage(ctx: MonitorContext): Promise<void> {
	if (
		!ctx.storageHubClient ||
		!ctx.mspClient ||
		!ctx.userApi ||
		!ctx.bucketId ||
		!ctx.fileKey ||
		!ctx.fileLocation ||
		!ctx.fingerprint ||
		ctx.fileSize === undefined
	) {
		throw new Error("Required context not initialized");
	}

	// Create file info for deletion
	const fileInfo: FileInfo = {
		fileKey: ctx.fileKey as `0x${string}`,
		bucketId: ctx.bucketId as `0x${string}`,
		location: ctx.fileLocation,
		size: ctx.fileSize,
		fingerprint: ctx.fingerprint as `0x${string}`,
		blockHash:
			"0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
	};

	// Request file deletion
	console.log("[file-delete] Requesting file deletion on-chain...");
	const txHash = await ctx.storageHubClient.requestDeleteFile(fileInfo);
	console.log(`[file-delete] Transaction: ${txHash}`);

	// Wait for transaction receipt
	const receipt = await ctx.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Delete file transaction failed");
	}

	// Wait for finalization
	console.log("[file-delete] Waiting for finalization...");
	await waitForFinalization(ctx.userApi);

	// Verify deletion event
	console.log("[file-delete] Verifying deletion event...");
	const events = await ctx.userApi.query.system.events();
	const eventsArray = events as any;
	const deletionEvent = eventsArray.find(
		(e: any) =>
			e.event.section === "fileSystem" &&
			e.event.method === "FileDeletionRequested",
	);
	if (!deletionEvent) {
		throw new Error("FileDeletionRequested event not found");
	}

	// Wait for MSP to remove the file
	console.log("[file-delete] Waiting for MSP to remove file...");
	await pollBackend(
		async () => {
			try {
				const downloadResponse = await ctx.mspClient!.files.downloadFile(
					ctx.fileKey!,
				);
				// If download succeeds, file still exists
				return downloadResponse.status === 404;
			} catch {
				// If download fails, assume file is deleted
				return true;
			}
		},
		(deleted) => deleted,
		{ retries: 60, delayMs: 5000 }, // Give more time for deletion cleanup
	);

	console.log(`[file-delete] ✓ File deleted: ${ctx.fileKey}`);
}

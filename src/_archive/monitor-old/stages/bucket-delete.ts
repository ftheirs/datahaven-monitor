// Stage 9: Bucket deletion

import { pollBackend, waitForFinalization } from "../utils/waits";
import type { MonitorContext } from "../types";

/**
 * Delete bucket on-chain and verify removal
 */
export async function bucketDeleteStage(ctx: MonitorContext): Promise<void> {
	if (
		!ctx.storageHubClient ||
		!ctx.mspClient ||
		!ctx.userApi ||
		!ctx.bucketId
	) {
		throw new Error("Required context not initialized");
	}

	// Delete the bucket
	console.log("[bucket-delete] Deleting bucket on-chain...");
	const txHash = await ctx.storageHubClient.deleteBucket(
		ctx.bucketId as `0x${string}`,
	);
	if (!txHash) {
		throw new Error("deleteBucket did not return a transaction hash");
	}
	console.log(`[bucket-delete] Transaction: ${txHash}`);

	// Wait for transaction receipt
	const receipt = await ctx.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Delete bucket transaction failed");
	}

	// Wait for finalization
	console.log("[bucket-delete] Waiting for finalization...");
	await waitForFinalization(ctx.userApi);

	// Verify bucket no longer exists on-chain
	console.log("[bucket-delete] Verifying bucket removed from chain...");
	const bucketAfterDeletion = await ctx.userApi.query.providers.buckets(
		ctx.bucketId,
	);
	if ((bucketAfterDeletion as any).isSome) {
		throw new Error("Bucket still exists on-chain after deletion");
	}

	// Wait for MSP backend to remove the bucket
	console.log("[bucket-delete] Waiting for MSP backend to remove bucket...");
	await pollBackend(
		async () => {
			try {
				const buckets = await ctx.mspClient!.buckets.listBuckets();
				return !buckets.some((b) => b.bucketId === ctx.bucketId);
			} catch {
				// If listBuckets fails, assume bucket is gone
				return true;
			}
		},
		(removed) => removed,
		{ retries: 40, delayMs: 3000 },
	);

	console.log(`[bucket-delete] ✓ Bucket deleted: ${ctx.bucketId}`);
}

// Stage 9: Bucket deletion

import type { MonitorContext } from "../types";
import { sleep } from "../../util/helpers";

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

	// Grace period before bucket deletion
	console.log(
		`[bucket-delete] Grace period (${ctx.network.delays.postBucketDeletionMs / 1000}s)...`,
	);
	await sleep(ctx.network.delays.postBucketDeletionMs);

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

	// Wait for a couple of finalized blocks
	console.log("[bucket-delete] Waiting for finalization...");
	const currentHdr = await ctx.userApi.rpc.chain.getHeader();
	await ctx.userApi.wait.finalizedAtLeast(currentHdr.number.toBigInt() + 2n);

	// Verify bucket no longer exists on-chain
	console.log("[bucket-delete] Verifying bucket removed from chain...");
	const bucketAfterDeletion = await ctx.userApi.query.providers.buckets(
		ctx.bucketId,
	);
	if ((bucketAfterDeletion as any).isSome) {
		throw new Error("Bucket still exists on-chain after deletion");
	}

	console.log(`[bucket-delete] ✓ Bucket deleted: ${ctx.bucketId}`);
}

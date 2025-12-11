// Stage 4: Bucket creation

import { pollBackend, waitForFinalization } from "../utils/waits";
import type { MonitorContext } from "../types";

/**
 * Create a bucket on-chain and verify it's indexed by MSP backend
 */
export async function bucketCreateStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.storageHubClient || !ctx.mspClient || !ctx.userApi) {
		throw new Error("Required clients not initialized");
	}

	// Get MSP info to retrieve mspId
	console.log("[bucket-create] Getting MSP info...");
	const mspInfo = await ctx.mspClient.info.getInfo();
	ctx.mspId = mspInfo.mspId;
	console.log(`[bucket-create] MSP ID: ${ctx.mspId}`);

	// Get value proposition for the MSP
	console.log("[bucket-create] Getting value propositions...");
	const valueProps = await ctx.mspClient.info.getValuePropositions();
	if (!valueProps || valueProps.length === 0) {
		throw new Error("No value propositions found for MSP");
	}
	const valuePropId = valueProps[0].id as `0x${string}`;
	console.log(`[bucket-create] Using value prop: ${valuePropId}`);

	// Derive bucket ID with unique name
	ctx.bucketName = `monitor-test-${Date.now()}`;
	ctx.bucketId = (await ctx.storageHubClient.deriveBucketId(
		ctx.account.address,
		ctx.bucketName,
	)) as string;
	console.log(`[bucket-create] Bucket name: ${ctx.bucketName}`);
	console.log(`[bucket-create] Bucket ID: ${ctx.bucketId}`);

	// Create the bucket
	console.log("[bucket-create] Creating bucket on-chain...");
	const txHash = await ctx.storageHubClient.createBucket(
		ctx.mspId as `0x${string}`,
		ctx.bucketName,
		false,
		valuePropId,
	);
	if (!txHash) {
		throw new Error("createBucket did not return a transaction hash");
	}
	console.log(`[bucket-create] Transaction: ${txHash}`);

	// Wait for transaction receipt
	const receipt = await ctx.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Create bucket transaction failed");
	}

	// Wait for finalization
	console.log("[bucket-create] Waiting for finalization...");
	await waitForFinalization(ctx.userApi);

	// Verify bucket exists on-chain
	console.log("[bucket-create] Verifying bucket exists on-chain...");
	const bucketAfter = await ctx.userApi.query.providers.buckets(ctx.bucketId);
	if ((bucketAfter as any).isNone) {
		throw new Error("Bucket not found on-chain after creation");
	}

	// Wait for MSP backend to index the bucket
	console.log("[bucket-create] Waiting for MSP backend to index bucket...");
	await pollBackend(
		async () => {
			const buckets = await ctx.mspClient!.buckets.listBuckets();
			return buckets.some((b) => b.bucketId === ctx.bucketId);
		},
		{ retries: 40, delayMs: 3000 },
	);

	console.log(`[bucket-create] ✓ Bucket created and indexed: ${ctx.bucketId}`);
}

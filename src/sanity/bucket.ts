// Sanity test: basic bucket creation flow using StorageHubClient and MspClient.
// Goal: create a uniquely named bucket, wait for the tx to be included, and verify
// its presence via the MSP backend.

import type { StorageHubClient } from "@storagehub-sdk/core";
import type { Bucket, MspClient, ValueProp } from "@storagehub-sdk/msp-client";

import { logCheckResult } from "../util/logger";
import type { ViemClients } from "../util/viemClient";

const NAMESPACE = "sanity/bucket";

function normalizeBucketId(id: string): `0x${string}` {
	const hex = id.startsWith("0x") ? id : `0x${id}`;
	return hex.toLowerCase() as `0x${string}`;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForBucketIndexed(
	mspClient: MspClient,
	bucketId: `0x${string}`,
	{
		retries = 24, // ~2 minutes at 5s intervals
		delayMs = 5000,
	}: { retries?: number; delayMs?: number } = {},
): Promise<void> {
	for (let attempt = 0; attempt < retries; attempt += 1) {
		// Try getBucket first (more direct) and fall back to listBuckets.
		try {
			const bucket = await mspClient.buckets.getBucket(bucketId);
			if (bucket?.bucketId && normalizeBucketId(bucket.bucketId) === bucketId) {
				return;
			}
		} catch {
			// ignore and continue polling
		}

		try {
			const listedBuckets: Bucket[] = await mspClient.buckets.listBuckets();
			const found =
				Array.isArray(listedBuckets) &&
				listedBuckets.some((b) => normalizeBucketId(b.bucketId) === bucketId);
			if (found) {
				return;
			}
		} catch {
			// ignore and continue polling
		}

		await sleep(delayMs);
	}

	throw new Error(
		"Bucket not visible in MSP backend after waiting for indexing.",
	);
}

async function waitForBucketRemoved(
	mspClient: MspClient,
	bucketId: `0x${string}`,
	{ retries = 24, delayMs = 5000 }: { retries?: number; delayMs?: number } = {},
): Promise<void> {
	for (let attempt = 0; attempt < retries; attempt += 1) {
		try {
			const listedBuckets: Bucket[] = await mspClient.buckets.listBuckets();
			const stillPresent =
				Array.isArray(listedBuckets) &&
				listedBuckets.some((b) => normalizeBucketId(b.bucketId) === bucketId);
			if (!stillPresent) {
				return;
			}
		} catch {
			// ignore and continue polling
		}

		try {
			const bucket = await mspClient.buckets.getBucket(bucketId);
			const exists =
				bucket?.bucketId && normalizeBucketId(bucket.bucketId) === bucketId;
			if (!exists) {
				return;
			}
		} catch {
			// getBucket threw; assume not visible yet and keep polling
		}

		await sleep(delayMs);
	}

	throw new Error(
		"Bucket still visible in MSP backend after waiting for removal.",
	);
}

export async function runBucketCreationCheck(
	storageHubClient: StorageHubClient,
	mspClient: MspClient,
	viem: ViemClients,
): Promise<[string, string]> {
	const bucketName = `sanity-bucket-${Date.now().toString(36)}`;

	// 1) Fetch MSP info and value propositions. Use info.mspId explicitly to avoid
	// mismatches with value proposition data.
	const info = await mspClient.info.getInfo();
	const mspId = info.mspId as `0x${string}`;

	const sdkValueProps: ValueProp[] =
		await mspClient.info.getValuePropositions();
	if (!Array.isArray(sdkValueProps) || sdkValueProps.length === 0) {
		throw new Error("No value propositions returned by MSP backend.");
	}

	const selectedVp = sdkValueProps[0];
	if (!selectedVp.id) {
		throw new Error("Selected value proposition has no id.");
	}

	const valuePropId = selectedVp.id as `0x${string}`;

	// 2) Derive a bucket ID for the current account and chosen name.
	const derivedId = (await storageHubClient.deriveBucketId(
		viem.account.address,
		bucketName,
	)) as string;
	const bucketId = normalizeBucketId(derivedId);

	// 3) Create the bucket via the StorageHub client.
	const txHash = await storageHubClient.createBucket(
		mspId,
		bucketName,
		false,
		valuePropId,
	);
	if (!txHash) {
		throw new Error("Create bucket did not return a transaction hash.");
	}

	// 4) Wait for transaction receipt and ensure success.
	const receipt = await viem.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Create bucket transaction failed.");
	}

	// TODO: wait until backend returns the new bucket

	// 5) Verify via MSP that the bucket is now listed (simple polling).
	const expectedBucketId = bucketId;
	await waitForBucketIndexed(mspClient, expectedBucketId, {
		retries: 24,
		delayMs: 5000,
	});

	logCheckResult(NAMESPACE, "Bucket creation", true);

	return [bucketName, bucketId];
}

export async function runBucketDeletionCheck(
	storageHubClient: StorageHubClient,
	mspClient: MspClient,
	viem: ViemClients,
	bucketName: string,
	bucketId: string,
): Promise<void> {
	// 1) Delete the bucket via the StorageHub client.
	const deleteTxHash = await storageHubClient.deleteBucket(
		bucketId as `0x${string}`,
	);
	if (!deleteTxHash) {
		throw new Error(
			`Delete bucket "${bucketName}" did not return a transaction hash.`,
		);
	}

	// 2) Wait for transaction receipt and ensure success.
	const deleteReceipt = await viem.publicClient.waitForTransactionReceipt({
		hash: deleteTxHash,
	});
	if (deleteReceipt.status !== "success") {
		throw new Error(`Delete bucket "${bucketName}" transaction failed.`);
	}

	// TODO: wait until bucket is deleted and no longer displayed in backend

	// 3) Verify via MSP that the bucket is no longer listed.
	const listedBuckets: Bucket[] = await mspClient.buckets.listBuckets();
	const expectedBucketId = normalizeBucketId(bucketId);
	const stillPresent =
		Array.isArray(listedBuckets) &&
		listedBuckets.some(
			(b) => normalizeBucketId(b.bucketId) === expectedBucketId,
		);

	if (stillPresent) {
		await waitForBucketRemoved(mspClient, expectedBucketId, {
			retries: 24,
			delayMs: 5000,
		});
	}

	logCheckResult(NAMESPACE, "Bucket deletion", true);
}

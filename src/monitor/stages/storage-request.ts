// Stage 5: Issue storage request

import { readFile } from "node:fs/promises";
import { TypeRegistry } from "@polkadot/types";
import { FileManager, ReplicationLevel, initWasm } from "@storagehub-sdk/core";
import type { FileManager as FM } from "@storagehub-sdk/core";
import { waitForFinalization } from "../utils/waits";
import type { MonitorContext } from "../types";

/**
 * Issue storage request on-chain for test file
 */
export async function storageRequestStage(ctx: MonitorContext): Promise<void> {
	if (
		!ctx.storageHubClient ||
		!ctx.mspClient ||
		!ctx.userApi ||
		!ctx.bucketId ||
		!ctx.mspId
	) {
		throw new Error("Required context not initialized");
	}

	// Initialize WASM (if not already done)
	await initWasm();

	// Load test file
	console.log("[storage-request] Loading test file...");
	const fileBuffer = await readFile(ctx.network.test.testFilePath);
	ctx.fileBlob = new Blob([fileBuffer]);

	// Create FileManager
	const fileManager = new FileManager({
		size: ctx.fileBlob.size,
		stream: () => ctx.fileBlob!.stream() as ReadableStream<Uint8Array>,
	});

	// Compute fingerprint and size
	console.log("[storage-request] Computing fingerprint...");
	const fingerprintResult = await fileManager.getFingerprint();
	ctx.fingerprint = fingerprintResult.toHex() as `0x${string}`;
	ctx.fileSize = BigInt(fileManager.getFileSize());
	console.log(`[storage-request] Fingerprint: ${ctx.fingerprint}`);
	console.log(`[storage-request] Size: ${ctx.fileSize} bytes`);

	// Generate file location (simple filename like demo)
	ctx.fileLocation = "adolphus.jpg";
	console.log(`[storage-request] Location: ${ctx.fileLocation}`);

	// Get MSP peer ID if available
	const mspInfo = await ctx.mspClient.info.getInfo();
	const peerId = extractPeerId(mspInfo.multiaddresses);

	// Issue storage request
	console.log("[storage-request] Issuing storage request on-chain...");
	const txHash = await ctx.storageHubClient.issueStorageRequest(
		ctx.bucketId as `0x${string}`,
		ctx.fileLocation,
		ctx.fingerprint as `0x${string}`,
		ctx.fileSize,
		ctx.mspId as `0x${string}`,
		peerId ? [peerId] : [],
		ReplicationLevel.Custom,
		2,
	);
	if (!txHash) {
		throw new Error("issueStorageRequest did not return a transaction hash");
	}
	console.log(`[storage-request] Transaction: ${txHash}`);

	// Wait for transaction receipt
	const receipt = await ctx.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Storage request transaction failed");
	}

	// Wait for finalization
	console.log("[storage-request] Waiting for finalization...");
	await waitForFinalization(ctx.userApi);

	// Compute file key
	console.log("[storage-request] Computing file key...");
	const registry = new TypeRegistry();
	type FileManagerOwner = Parameters<FM["computeFileKey"]>[0];
	type FileManagerBucket = Parameters<FM["computeFileKey"]>[1];
	const owner = registry.createType(
		"AccountId20",
		ctx.account.address,
	) as unknown as FileManagerOwner;
	const bucketIdH256 = registry.createType(
		"H256",
		ctx.bucketId,
	) as unknown as FileManagerBucket;
	const fileKeyH256 = await fileManager.computeFileKey(
		owner,
		bucketIdH256,
		ctx.fileLocation,
	);
	ctx.fileKey = fileKeyH256.toHex();
	console.log(`[storage-request] File key: ${ctx.fileKey}`);

	// Verify storage request exists on-chain
	console.log("[storage-request] Verifying storage request on-chain...");
	const storageRequest = await ctx.userApi.query.fileSystem.storageRequests(
		ctx.fileKey,
	);
	if ((storageRequest as any).isNone) {
		throw new Error("Storage request not found on-chain");
	}

	// Wait for MSP to process the storage request (critical for upload readiness)
	console.log(
		`[storage-request] Waiting for MSP to process (${ctx.network.delays.postStorageRequestMs / 1000}s)...`,
	);
	await new Promise((r) =>
		setTimeout(r, ctx.network.delays.postStorageRequestMs),
	);

	console.log("[storage-request] ✓ Storage request issued and verified");
}

function extractPeerId(multiaddresses: string[]): string | undefined {
	for (const ma of multiaddresses) {
		const idx = ma.lastIndexOf("/p2p/");
		if (idx !== -1) return ma.slice(idx + 5);
	}
	return undefined;
}

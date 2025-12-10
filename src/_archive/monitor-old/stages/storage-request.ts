// Stage 5: Issue storage request

import { readFile } from "node:fs/promises";
import { TypeRegistry } from "@polkadot/types";
import type { AccountId20, H256 } from "@polkadot/types/interfaces";
import { FileManager, ReplicationLevel } from "@storagehub-sdk/core";
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

	// Generate file location
	ctx.fileLocation = "/monitor/adolphus.jpg";
	console.log(`[storage-request] Location: ${ctx.fileLocation}`);

	// Issue storage request
	console.log("[storage-request] Issuing storage request on-chain...");
	const txHash = await ctx.storageHubClient.issueStorageRequest(
		ctx.bucketId as `0x${string}`,
		ctx.fileLocation,
		ctx.fingerprint as `0x${string}`,
		ctx.fileSize,
		ctx.mspId as `0x${string}`,
		[], // peerIds - let MSP distribute
		ReplicationLevel.Basic,
		0, // replicas - only used for Custom replication
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
	const owner = registry.createType("AccountId20", ctx.account.address);
	const bucketIdH256 = registry.createType("H256", ctx.bucketId);
	const fileKeyH256 = await fileManager.computeFileKey(
		owner as any,
		bucketIdH256 as any,
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

	const storageRequestData = (storageRequest as any).unwrap();
	if (storageRequestData.bucketId.toString() !== ctx.bucketId) {
		throw new Error("Storage request bucketId mismatch");
	}
	if (storageRequestData.location.toUtf8() !== ctx.fileLocation) {
		throw new Error("Storage request location mismatch");
	}
	if (
		storageRequestData.fingerprint.toString() !== fingerprintResult.toString()
	) {
		throw new Error("Storage request fingerprint mismatch");
	}
	if (storageRequestData.size_.toString() !== ctx.fileSize.toString()) {
		throw new Error("Storage request size mismatch");
	}

	console.log("[storage-request] ✓ Storage request issued and verified");
}

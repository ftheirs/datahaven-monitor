// Stage 8: File deletion

import type { FileInfo } from "@storagehub-sdk/core";
import type { FileTree } from "@storagehub-sdk/msp-client";
import type { MonitorContext } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

	// Wait for FileDeletionRequested event
	console.log("[file-delete] Waiting for FileDeletionRequested event...");
	const { blockHash } = await ctx.userApi.wait.forFinalizedEvent(
		"fileSystem",
		"FileDeletionRequested",
		60_000,
	);
	console.log(`[file-delete] FileDeletionRequested seen in block ${blockHash}`);

	// Wait for a couple of finalized blocks
	const currentHdr = await ctx.userApi.rpc.chain.getHeader();
	await ctx.userApi.wait.finalizedAtLeast(currentHdr.number.toBigInt() + 2n);

	// Grace period for MSP to process deletion
	console.log(
		`[file-delete] Grace period (${ctx.network.delays.postFileDeletionMs / 1000}s)...`,
	);
	await sleep(ctx.network.delays.postFileDeletionMs);

	// Wait for MSP to remove the file from bucket listing
	console.log("[file-delete] Waiting for MSP to remove file from bucket...");
	const isFilePresent = async (): Promise<boolean> => {
		try {
			const resp = await ctx.mspClient!.buckets.getFiles(ctx.bucketId!);
			const stack: FileTree[] = [...resp.files];
			while (stack.length > 0) {
				const node = stack.pop()!;
				if (node.type === "file") {
					if (node.fileKey === ctx.fileKey) return true;
				} else {
					stack.push(...node.children);
				}
			}
			return false;
		} catch {
			return false;
		}
	};

	const maxWaitMs = 120_000;
	const stepMs = 1_000;
	let waited = 0;
	while (await isFilePresent()) {
		if (waited >= maxWaitMs) {
			throw new Error("File not removed from bucket in time");
		}
		await sleep(stepMs);
		waited += stepMs;
	}

	console.log(`[file-delete] ✓ File deleted and removed from bucket`);
}

// Stage 7: File download and verification

import { readFile } from "node:fs/promises";
import { FileManager, initWasm } from "@storagehub-sdk/core";
import { Readable } from "stream";
import type { MonitorContext } from "../types";

/**
 * Download file from MSP and verify content matches upload
 */
export async function fileDownloadStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient || !ctx.bucketId || !ctx.fileKey || !ctx.fingerprint) {
		throw new Error("Required context not initialized");
	}

	// Download file from MSP
	console.log("[file-download] Downloading file from MSP backend...");
	const download = await ctx.mspClient.files.downloadFile(ctx.fileKey);

	if (download.status !== 200) {
		throw new Error(`Download failed with status: ${download.status}`);
	}

	// Read downloaded stream into blob
	console.log("[file-download] Reading download stream...");
	const chunks: Uint8Array[] = [];
	const reader = download.stream.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	// Combine chunks into single Uint8Array
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const downloadedData = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		downloadedData.set(chunk, offset);
		offset += chunk.length;
	}

	const downloadedBlob = new Blob([downloadedData]);

	console.log(
		`[file-download] Downloaded ${downloadedBlob.size} bytes (expected ${ctx.fileBlob?.size || ctx.fileSize})`,
	);

	// Verify fingerprint matches original
	console.log("[file-download] Verifying file integrity (fingerprint)...");
	await initWasm();
	const downloadedFileManager = new FileManager({
		size: downloadedBlob.size,
		stream: () => downloadedBlob.stream() as ReadableStream<Uint8Array>,
	});

	const downloadedFingerprint = await downloadedFileManager.getFingerprint();
	const downloadedFingerprintHex = downloadedFingerprint.toHex();

	if (downloadedFingerprintHex !== ctx.fingerprint) {
		throw new Error(
			`Fingerprint mismatch! Original: ${ctx.fingerprint}, Downloaded: ${downloadedFingerprintHex}`,
		);
	}

	console.log(`[file-download] ✓ Fingerprint verified: ${downloadedFingerprintHex}`);
	console.log(`[file-download] ✓ File downloaded and verified successfully`);
}


// Stage 7: File download

import type { MonitorContext } from "../types";

/**
 * Download file from MSP and verify content matches upload
 */
export async function fileDownloadStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient || !ctx.fileKey || !ctx.fileBlob) {
		throw new Error("Required context not initialized");
	}

	// Download the file
	console.log("[file-download] Downloading file from MSP backend...");
	const downloadResponse = await ctx.mspClient.files.downloadFile(ctx.fileKey);

	if (downloadResponse.status !== 200) {
		throw new Error(`Download failed with status: ${downloadResponse.status}`);
	}

	if (!downloadResponse.stream) {
		throw new Error("Download did not return a stream");
	}

	// Convert stream to blob
	const downloadedBlob = await new Response(downloadResponse.stream).blob();

	// Compare with original file
	console.log("[file-download] Verifying downloaded content...");
	const originalBuffer = Buffer.from(await ctx.fileBlob.arrayBuffer());
	const downloadedBuffer = Buffer.from(await downloadedBlob.arrayBuffer());

	if (originalBuffer.length !== downloadedBuffer.length) {
		throw new Error(
			`Downloaded file size mismatch: ${originalBuffer.length} !== ${downloadedBuffer.length}`,
		);
	}

	if (!originalBuffer.equals(downloadedBuffer)) {
		throw new Error("Downloaded file content mismatch");
	}

	console.log(
		`[file-download] ✓ File downloaded and verified (${downloadedBuffer.length} bytes)`,
	);
}

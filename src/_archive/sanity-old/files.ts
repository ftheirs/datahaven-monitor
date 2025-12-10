// Sanity test: file upload, download, and deletion checks.
// Goal: upload a test file, verify it's accessible, download and verify content, then delete it.

import { FileManager, ReplicationLevel } from "@storagehub-sdk/core";
import type { StorageHubClient } from "@storagehub-sdk/core";
import type { MspClient } from "@storagehub-sdk/msp-client";
import type { AccountId20, H256 } from "@polkadot/types/interfaces";
import { TypeRegistry } from "@polkadot/types/create";
import { logCheckResult } from "../util/logger";
import type { ViemClients } from "../util/viemClient";

const NAMESPACE = "sanity/files";

/**
 * Generates a simple test file with deterministic content for testing.
 */
function createTestFile(): Blob {
	const content = `Test file content - ${Date.now()}\nThis is a sanity test file for DataHaven monitor.`;
	return new Blob([content], { type: "text/plain" });
}

/**
 * Loads a local file (relative to this module) into a Blob.
 * Example: loadLocalFileBlob("../../resources/adolphus.jpg", "image/jpeg")
 */
export async function loadLocalFileBlob(
	relativePath: string,
	mimeType = "application/octet-stream",
): Promise<Blob> {
	const url = new URL(relativePath, import.meta.url);
	const filePath = url.pathname;

	try {
		// Use Bun's file API (available at runtime)
		// @ts-expect-error - Bun.file is available at runtime but not in types
		const file = Bun.file(filePath);

		if (!(await file.exists())) {
			throw new Error(`File not found at ${filePath}`);
		}

		const arrayBuffer = await file.arrayBuffer();
		return new Blob([arrayBuffer], { type: mimeType });
	} catch (error) {
		throw new Error(
			`Failed to load file from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Generates a random binary file of the specified size (in bytes).
 * Useful for testing large file uploads.
 */
export function createRandomBinaryFile(sizeBytes: number): Blob {
	const buffer = new Uint8Array(sizeBytes);
	crypto.getRandomValues(buffer);
	return new Blob([buffer], { type: "application/octet-stream" });
}

/**
 * Computes a simple hash-like string for the test file (for fingerprint verification).
 * In a real scenario, this would use SHA-256, but for sanity tests we'll keep it simple.
 */
async function computeFileFingerprint(blob: Blob): Promise<string> {
	const arrayBuffer = await blob.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a unique file key (hex string with 0x prefix) for the test file.
 */
function generateFileKey(): `0x${string}` {
	const randomBytes = new Uint8Array(32);
	crypto.getRandomValues(randomBytes);
	const hex = Array.from(randomBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as `0x${string}`;
}

/**
 * Sanity check: upload a test file to a bucket via MSP backend.
 * Returns the fileKey, fileLocation, and original file content for subsequent checks.
 *
 * @param mspClient - MSP client instance
 * @param bucketId - Bucket ID to upload to
 * @param ownerAddress - Owner's Ethereum address
 * @param file - Optional Blob to upload. If not provided, creates a default test file.
 * @param fileLocation - Optional file location/path. If not provided, generates one.
 * @param fileKey - Optional file key. If not provided, generates one.
 */
export async function runFileUploadCheck(
	mspClient: MspClient,
	bucketId: string,
	ownerAddress: string,
	file?: Blob,
	fileLocation?: string,
	fileKey?: `0x${string}`,
): Promise<[string, string, Blob]> {
	const finalFileKey = fileKey ?? generateFileKey();
	const finalFileLocation = fileLocation ?? generateFileLocation("test.txt");
	const fileToUpload = file ?? createTestFile();

	// Upload the file via MSP backend.
	// Note: uploadFile expects fileKey as string (with or without 0x prefix).
	const uploadResponse = await mspClient.files.uploadFile(
		bucketId,
		finalFileKey,
		fileToUpload,
		ownerAddress,
		finalFileLocation,
	);

	// Verify upload response.
	if (uploadResponse.status !== "upload_successful") {
		throw new Error(
			`Upload failed with status: ${uploadResponse.status}. Expected "upload_successful".`,
		);
	}

	// Normalize fileKey comparison (API may return with or without 0x prefix).
	const normalizedResponseKey = uploadResponse.fileKey.startsWith("0x")
		? uploadResponse.fileKey
		: `0x${uploadResponse.fileKey}`;
	if (normalizedResponseKey !== finalFileKey) {
		throw new Error(
			`Upload returned unexpected fileKey. Expected ${finalFileKey}, got ${normalizedResponseKey}.`,
		);
	}

	if (`0x${uploadResponse.bucketId}` !== `0x${bucketId}`) {
		throw new Error(
			`Upload returned unexpected bucketId. Expected 0x${bucketId}, got 0x${uploadResponse.bucketId}.`,
		);
	}

	if (uploadResponse.location !== finalFileLocation) {
		throw new Error(
			`Upload returned unexpected location. Expected ${finalFileLocation}, got ${uploadResponse.location}.`,
		);
	}

	// Compute expected fingerprint and verify.
	const expectedFingerprint = await computeFileFingerprint(fileToUpload);
	if (uploadResponse.fingerprint !== expectedFingerprint) {
		throw new Error(
			`Upload returned unexpected fingerprint. Expected ${expectedFingerprint}, got ${uploadResponse.fingerprint}.`,
		);
	}

	// Verify file appears in bucket's file tree.
	const fileList = await mspClient.buckets.getFiles(bucketId);
	if (!Array.isArray(fileList.files)) {
		throw new Error("File list should contain an array of files.");
	}

	// Recursively search for the file in the file tree.
	function findFileInTree(trees: typeof fileList.files): boolean {
		for (const item of trees) {
			if (item.type === "file" && item.fileKey === finalFileKey) {
				return true;
			}
			if (item.type === "folder" && item.children) {
				if (findFileInTree(item.children)) {
					return true;
				}
			}
		}
		return false;
	}

	const fileFound = findFileInTree(fileList.files);

	if (!fileFound) {
		throw new Error(
			`Uploaded file with key ${finalFileKey} not found in bucket file tree.`,
		);
	}

	// Verify file info is accessible.
	// getFileInfo expects fileKey as string (with or without 0x prefix).
	const fileInfo = await mspClient.files.getFileInfo(bucketId, finalFileKey);
	const normalizedBucketId = bucketId.startsWith("0x")
		? bucketId
		: `0x${bucketId}`;
	if (fileInfo.bucketId !== normalizedBucketId) {
		throw new Error(
			`File info returned unexpected bucketId. Expected ${normalizedBucketId}, got ${fileInfo.bucketId}.`,
		);
	}

	if (fileInfo.fileKey !== finalFileKey) {
		throw new Error(
			`File info returned unexpected fileKey. Expected ${finalFileKey}, got ${fileInfo.fileKey}.`,
		);
	}

	logCheckResult(NAMESPACE, "File upload", true);

	// Return fileKey (with 0x prefix) for use in subsequent operations.
	return [finalFileKey, finalFileLocation, fileToUpload];
}

function normalizeHex(hex: string): `0x${string}` {
	return hex.startsWith("0x")
		? (hex as `0x${string}`)
		: (`0x${hex}` as `0x${string}`);
}

function mapReplicationLevel(level: string | undefined): ReplicationLevel {
	switch (level) {
		case "Standard":
			return ReplicationLevel.Standard;
		case "HighSecurity":
			return ReplicationLevel.HighSecurity;
		case "SuperHighSecurity":
			return ReplicationLevel.SuperHighSecurity;
		case "UltraHighSecurity":
			return ReplicationLevel.UltraHighSecurity;
		case "Custom":
			return ReplicationLevel.Custom;
		case "Basic":
		default:
			return ReplicationLevel.Basic;
	}
}

/**
 * Issues a storage request for a file and returns the derived fileKey and fingerprint.
 * The caller is responsible for providing the MSP ID and replication settings.
 */
export async function runIssueStorageRequest(
	storageHubClient: StorageHubClient,
	viem: ViemClients,
	bucketId: string,
	file: Blob,
	fileLocation: string,
	mspId: `0x${string}`,
	replicationLevel: string,
	replicas: number,
): Promise<{
	fileKey: `0x${string}`;
	fingerprint: `0x${string}`;
	fileBlob: Blob;
}> {
	const registry = new TypeRegistry();
	const fileManager = new FileManager({
		size: file.size,
		stream: () => file.stream(),
	});

	const fingerprintH256 = await fileManager.getFingerprint();
	const fingerprint = normalizeHex(fingerprintH256.toString());
	const fileSize = BigInt(fileManager.getFileSize());
	const peerIds: string[] = [];
	const replication = mapReplicationLevel(replicationLevel);

	const bucketIdHex = normalizeHex(bucketId);

	const txHash = await storageHubClient.issueStorageRequest(
		bucketIdHex,
		fileLocation,
		fingerprint,
		fileSize,
		mspId,
		peerIds,
		replication,
		replicas,
	);

	if (!txHash) {
		throw new Error("issueStorageRequest did not return a transaction hash.");
	}

	const receipt = await viem.publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Storage request transaction failed.");
	}

	// Derive fileKey using FileManager + substrate types. Relaxed casting to avoid
	// version skew between bundled polkadot types.
	const owner = registry.createType(
		"AccountId20",
		viem.account.address,
	) as unknown as AccountId20;
	const bucketIdH256 = registry.createType(
		"H256",
		bucketIdHex,
	) as unknown as H256;
	const fileKeyH256 = await fileManager.computeFileKey(
		owner as unknown as any,
		bucketIdH256 as unknown as any,
		fileLocation,
	);
	const fileKey = normalizeHex(
		(fileKeyH256 as unknown as { toString: () => string }).toString(),
	);

	return { fileKey, fingerprint, fileBlob: file };
}

/**
 * Generates a random file location path by choosing among predefined base paths
 * (including the option of no subdirectory) and appending the provided filename.
 */
const FILE_LOCATION_BASES = [
	"",
	"test",
	"test/data",
	"test/data/nested",
	"uploads",
	"uploads/images",
];

export function generateFileLocation(filename: string): string {
	const base =
		FILE_LOCATION_BASES[Math.floor(Math.random() * FILE_LOCATION_BASES.length)];
	if (!base) {
		return `/${filename}`;
	}
	return `/${base}/${filename}`;
}

/**
 * Sanity check: download a file and verify its content matches the original.
 */
export async function runFileDownloadCheck(
	mspClient: MspClient,
	fileKey: string,
	expectedContent: Blob,
): Promise<void> {
	// Download the file.
	// fileKey should already have 0x prefix from upload step.
	const downloadResult = await mspClient.files.downloadFile(fileKey);

	if (!downloadResult.stream) {
		throw new Error("Download did not return a stream.");
	}

	// Read the stream into a Blob.
	const chunks: BlobPart[] = [];
	const reader = downloadResult.stream.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				// Convert Uint8Array to a regular ArrayBuffer-backed Uint8Array
				chunks.push(new Uint8Array(value));
			}
		}
	} finally {
		reader.releaseLock();
	}

	const downloadedBlob = new Blob(chunks);

	// Compare downloaded content with original (works for both text and binary).
	const originalArrayBuffer = await expectedContent.arrayBuffer();
	const downloadedArrayBuffer = await downloadedBlob.arrayBuffer();

	if (originalArrayBuffer.byteLength !== downloadedArrayBuffer.byteLength) {
		throw new Error(
			`Downloaded file size mismatch. Expected ${originalArrayBuffer.byteLength} bytes, got ${downloadedArrayBuffer.byteLength} bytes.`,
		);
	}

	const originalBytes = new Uint8Array(originalArrayBuffer);
	const downloadedBytes = new Uint8Array(downloadedArrayBuffer);

	for (let i = 0; i < originalBytes.length; i++) {
		if (originalBytes[i] !== downloadedBytes[i]) {
			throw new Error(
				`Downloaded file content mismatch at byte ${i}. Expected ${originalBytes[i]}, got ${downloadedBytes[i]}.`,
			);
		}
	}

	logCheckResult(NAMESPACE, "File download", true);
}

/**
 * Sanity check: delete a file and verify it's removed from the bucket.
 * Note: This uses StorageHubClient.requestDeleteFile as the MSP client doesn't expose delete.
 */
export async function runFileDeletionCheck(
	storageHubClient: StorageHubClient,
	mspClient: MspClient,
	viem: ViemClients,
	bucketId: string,
	fileKey: string,
): Promise<void> {
	// Get file info first (required for delete request).
	// fileKey should already have 0x prefix from upload step.
	const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);

	// Request file deletion via StorageHubClient.
	const deleteTxHash = await storageHubClient.requestDeleteFile(fileInfo);
	if (!deleteTxHash) {
		throw new Error("Delete file did not return a transaction hash.");
	}

	// Wait for transaction receipt and ensure success.
	const receipt = await viem.publicClient.waitForTransactionReceipt({
		hash: deleteTxHash,
	});
	if (receipt.status !== "success") {
		throw new Error("Delete file transaction failed.");
	}

	// Verify file is no longer in bucket's file tree.
	const fileList = await mspClient.buckets.getFiles(bucketId);
	if (!Array.isArray(fileList.files)) {
		throw new Error("File list should contain an array of files.");
	}

	// Recursively search for the file in the file tree.
	function findFileInTree(trees: typeof fileList.files): boolean {
		for (const item of trees) {
			if (item.type === "file" && item.fileKey === (fileKey as `0x${string}`)) {
				return true;
			}
			if (item.type === "folder" && item.children) {
				if (findFileInTree(item.children)) {
					return true;
				}
			}
		}
		return false;
	}

	const fileStillPresent = findFileInTree(fileList.files);

	if (fileStillPresent) {
		throw new Error(
			`File with key ${fileKey} still present in bucket file tree after deletion.`,
		);
	}

	logCheckResult(NAMESPACE, "File deletion", true);
}

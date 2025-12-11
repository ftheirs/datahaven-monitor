// File upload stress test: concurrent upload and deletion of multiple files
import { TypeRegistry } from "@polkadot/types";
import {
	FileManager as FM,
	type FileManager,
	initWasm,
	ReplicationLevel,
	SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	StorageHubClient,
	type FileInfo as CoreFileInfo,
} from "@storagehub-sdk/core";
import { MspClient } from "@storagehub-sdk/msp-client";
import { Readable } from "stream";
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkConfig, getPrivateKey } from "../monitor/config";
import {
	extractPeerId,
	generateRandomBytes,
	sleep,
	to0x,
} from "../util/helpers";
import type { StressRunOptions } from "./index";

// ============================================================================
// STRESS TEST CONFIG
// ============================================================================
const STRESS_CONFIG = {
	bucketName: "stress-test-bucket", // Static bucket name
	fileCount: 25, // Number of files to upload
	fileSizeBytes: 500 * 1024, // 500 kB per file
	concurrency: 5, // Upload N files at a time
};

// ============================================================================
// MAIN STRESS TEST
// ============================================================================

export async function runFileUploadStress(
	options: StressRunOptions,
): Promise<void> {
	console.log("\n" + "=".repeat(80));
	console.log("FILE UPLOAD STRESS TEST");
	console.log("=".repeat(80));
	console.log(
		`Config: ${STRESS_CONFIG.fileCount} files × ${STRESS_CONFIG.fileSizeBytes} bytes`,
	);
	console.log(`Concurrency: ${STRESS_CONFIG.concurrency} uploads at a time`);
	console.log(`Options:`, options);
	console.log("=".repeat(80) + "\n");

	const network = getNetworkConfig();
	const privateKey = getPrivateKey();

	console.log(`[stress] Network: ${network.name}`);
	console.log(`[stress] MSP: ${network.msp.baseUrl}`);
	console.log(`[stress] Chain: ${network.chain.evmRpcUrl}`);

	// Initialize WASM
	console.log("[stress] Initializing WASM...");
	await initWasm();

	// Setup clients
	const account = privateKeyToAccount(privateKey);
	console.log(`[stress] Account: ${account.address}`);

	const publicClient = createPublicClient({
		transport: http(network.chain.evmRpcUrl),
	});

	const walletClient = createWalletClient({
		account,
		transport: http(network.chain.evmRpcUrl),
	});

	const chain = defineChain({
		id: network.chain.id,
		name: network.chain.name,
		nativeCurrency: { name: "Token", symbol: "TKN", decimals: 18 },
		rpcUrls: {
			default: { http: [network.chain.evmRpcUrl] },
		},
	});

	const storageHubClient = new StorageHubClient({
		rpcUrl: network.chain.evmRpcUrl,
		chain,
		walletClient,
		filesystemContractAddress:
			network.chain.filesystemPrecompileAddress ??
			SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	});

	// Authenticate with MSP
	console.log("[stress] Authenticating with MSP via SIWE...");
	let currentSession: any = undefined;
	const sessionProvider = async () => currentSession;

	const mspClient = await MspClient.connect(
		{
			baseUrl: network.msp.baseUrl,
			timeoutMs: network.msp.timeoutMs,
		},
		sessionProvider,
	);

	const siweSession = await mspClient.auth.SIWE(
		walletClient,
		network.msp.siweDomain,
		network.msp.siweUri,
	);
	currentSession = Object.freeze(siweSession);

	console.log("[stress] ✓ Authenticated with MSP");
	console.log("[stress] ✓ Clients initialized\n");

	// ========================================================================
	// STEP 1: Ensure bucket exists
	// ========================================================================
	console.log(
		`[stress] Checking if bucket "${STRESS_CONFIG.bucketName}" exists...`,
	);

	try {
		const info = await mspClient.info.getInfo();
		const mspId = info.mspId as `0x${string}`;

		const buckets = await mspClient.buckets.listBuckets();
		const existingBucket = buckets.find(
			(b: { name: string; bucketId: string }) =>
				b.name === STRESS_CONFIG.bucketName,
		);

		let bucketId: `0x${string}`;

		if (existingBucket) {
			console.log(
				`[stress] ✓ Bucket already exists: ${existingBucket.bucketId}`,
			);
			bucketId = existingBucket.bucketId as `0x${string}`;
		} else {
			console.log("[stress] Creating new bucket...");
			const vp = await mspClient.info.getValuePropositions();
			if (vp.length === 0) {
				throw new Error("No value propositions available on MSP");
			}
			const valuePropId = vp[0].id as `0x${string}`;

			bucketId = (await storageHubClient.deriveBucketId(
				account.address,
				STRESS_CONFIG.bucketName,
			)) as `0x${string}`;

			const createBucketTx = await storageHubClient.createBucket(
				mspId,
				STRESS_CONFIG.bucketName,
				false,
				valuePropId,
			);

			if (!createBucketTx) {
				throw new Error("createBucket returned no tx hash");
			}

			const createBucketRcpt = await publicClient.waitForTransactionReceipt({
				hash: createBucketTx,
			});

			if (createBucketRcpt.status !== "success") {
				throw new Error("createBucket transaction failed");
			}

			console.log(`[stress] ✓ Bucket created: ${bucketId}`);

			// Wait for indexing
			console.log("[stress] Waiting for bucket indexing (15s)...");
			await sleep(15_000);
		}

		// ========================================================================
		// STEP 2: Generate and upload files
		// ========================================================================
		console.log(
			`\n[stress] Generating ${STRESS_CONFIG.fileCount} random files...`,
		);

		type FileData = {
			name: string;
			location: string;
			bytes: Uint8Array;
			fileKey?: `0x${string}`;
		};

		const files: FileData[] = [];
		for (let i = 0; i < STRESS_CONFIG.fileCount; i++) {
			const name = `stress-file-${Date.now()}-${i}.bin`;
			const bytes = generateRandomBytes(STRESS_CONFIG.fileSizeBytes);
			files.push({ name, location: name, bytes });
		}
		console.log(`[stress] ✓ Generated ${files.length} files\n`);

		// Prepare TypeRegistry for file key computation
		const registry = new TypeRegistry();
		type FileManagerOwner = Parameters<FileManager["computeFileKey"]>[0];
		type FileManagerBucket = Parameters<FileManager["computeFileKey"]>[1];
		const owner = registry.createType(
			"AccountId20",
			account.address,
		) as unknown as FileManagerOwner;
		const bucketIdH256 = registry.createType(
			"H256",
			bucketId,
		) as unknown as FileManagerBucket;

		// Get peer ID from MSP info
		const peerId = extractPeerId(info.multiaddresses);

		// ========================================================================
		// STEP 2.1: Issue storage requests SEQUENTIALLY (avoid nonce conflicts)
		// ========================================================================
		console.log(
			`\n[stress] Issuing storage requests sequentially (avoids nonce conflicts)...`,
		);
		const storageStartTime = Date.now();
		let storageRequested = 0;

		for (const file of files) {
			try {
				// Validate file size
				if (file.bytes.length === 0) {
					throw new Error("Generated file has zero bytes");
				}

				// Create FileManager from bytes (fresh copy)
				const fileManager = new FM({
					size: file.bytes.length,
					stream: () =>
						Readable.toWeb(
							Readable.from(Buffer.from(file.bytes)),
						) as ReadableStream<Uint8Array>,
				});

				// Get fingerprint
				const fingerprint = await fileManager.getFingerprint();

				// Issue storage request ON-CHAIN (sequential to avoid nonce conflicts)
				const storageReqTx = await storageHubClient.issueStorageRequest(
					bucketId,
					file.location,
					fingerprint.toHex() as `0x${string}`,
					BigInt(file.bytes.length),
					mspId,
					peerId ? [peerId] : [],
					ReplicationLevel.Basic,
					0,
				);

				if (!storageReqTx) {
					throw new Error("issueStorageRequest returned no tx hash");
				}

				await publicClient.waitForTransactionReceipt({
					hash: storageReqTx,
				});

				// Recompute file key after storage request
				const recomputedFM = new FM({
					size: file.bytes.length,
					stream: () =>
						Readable.toWeb(
							Readable.from(Buffer.from(file.bytes)),
						) as ReadableStream<Uint8Array>,
				});

				const fileKey = await recomputedFM.computeFileKey(
					owner,
					bucketIdH256,
					file.location,
				);
				file.fileKey = fileKey.toHex() as `0x${string}`;

				storageRequested++;
				console.log(
					`[stress]   ✓ ${file.name} storage request issued (${storageRequested}/${files.length})`,
				);
			} catch (error) {
				console.error(
					`[stress]   ✗ ${file.name} storage request failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		const storageDuration = Date.now() - storageStartTime;
		console.log(
			`[stress] ✓ Storage requests complete: ${storageRequested}/${files.length} in ${(storageDuration / 1000).toFixed(1)}s`,
		);

		if (storageRequested === 0) {
			console.log("[stress] ✗ No storage requests succeeded, aborting test");
			return;
		}

		// Wait for MSP to process all storage requests
		console.log("[stress] Waiting for MSP to process storage requests (5s)...");
		await sleep(5_000);

		// ========================================================================
		// STEP 2.2: Upload files CONCURRENTLY (HTTP calls, no nonce issues)
		// ========================================================================
		console.log(
			`\n[stress] Uploading files (${STRESS_CONFIG.concurrency} concurrent)...`,
		);
		const uploadStartTime = Date.now();
		let uploaded = 0;

		const filesToUpload = files.filter((f) => f.fileKey);

		for (let i = 0; i < filesToUpload.length; i += STRESS_CONFIG.concurrency) {
			const batch = filesToUpload.slice(i, i + STRESS_CONFIG.concurrency);
			const batchNum = Math.floor(i / STRESS_CONFIG.concurrency) + 1;
			const totalBatches = Math.ceil(
				filesToUpload.length / STRESS_CONFIG.concurrency,
			);

			console.log(
				`[stress] Batch ${batchNum}/${totalBatches}: Uploading ${batch.length} files...`,
			);

			await Promise.all(
				batch.map(async (file) => {
					if (!file.fileKey) return;

					try {
						// Create fresh FileManager for upload
						const uploadFM = new FM({
							size: file.bytes.length,
							stream: () =>
								Readable.toWeb(
									Readable.from(Buffer.from(file.bytes)),
								) as ReadableStream<Uint8Array>,
						});

						const freshBlob = await uploadFM.getFileBlob();
						const uploadResult = await mspClient.files.uploadFile(
							bucketId,
							file.fileKey,
							freshBlob,
							account.address,
							file.location,
						);

						if (uploadResult.status !== "upload_successful") {
							throw new Error(`Upload failed: ${uploadResult.status}`);
						}

						uploaded++;
						console.log(
							`[stress]   ✓ ${file.name} uploaded (${uploaded}/${filesToUpload.length})`,
						);
					} catch (error) {
						console.error(
							`[stress]   ✗ ${file.name} upload failed:`,
							error instanceof Error ? error.message : error,
						);
					}
				}),
			);
		}

		const uploadDuration = Date.now() - uploadStartTime;

		console.log(
			`\n[stress] ✓ Upload complete: ${uploaded}/${filesToUpload.length} files in ${(uploadDuration / 1000).toFixed(1)}s`,
		);

		if (uploaded === 0) {
			console.log(
				"[stress] ✗ No files uploaded successfully, skipping deletion",
			);
			return;
		}

		// Wait for all files to be indexed before deleting
		console.log("\n[stress] Waiting for files to be fully indexed (30s)...");
		await sleep(30_000);

		// ========================================================================
		// STEP 3: Delete files SEQUENTIALLY (avoid nonce conflicts)
		// ========================================================================
		console.log(
			`\n[stress] Deleting ${uploaded} uploaded files sequentially (avoids nonce conflicts)...`,
		);
		const deleteStartTime = Date.now();
		let deleted = 0;

		const filesToDelete = files.filter((f) => f.fileKey);

		for (const file of filesToDelete) {
			if (!file.fileKey) continue;

			try {
				// Get file info from MSP
				const fileInfo = await mspClient.files.getFileInfo(
					bucketId,
					file.fileKey,
				);

				// Convert to CoreFileInfo
				const coreInfo: CoreFileInfo = {
					fileKey: to0x(fileInfo.fileKey),
					fingerprint: to0x(fileInfo.fingerprint),
					bucketId: to0x(fileInfo.bucketId),
					location: fileInfo.location,
					size: BigInt(fileInfo.size),
					blockHash: to0x(fileInfo.blockHash),
					...(fileInfo.txHash ? { txHash: to0x(fileInfo.txHash) } : {}),
				};

				const deleteTx = await storageHubClient.requestDeleteFile(coreInfo);

				if (!deleteTx) {
					throw new Error("requestDeleteFile returned no tx hash");
				}

				await publicClient.waitForTransactionReceipt({ hash: deleteTx });

				deleted++;
				console.log(
					`[stress]   ✓ ${file.name} deleted (${deleted}/${filesToDelete.length})`,
				);
			} catch (error) {
				console.error(
					`[stress]   ✗ ${file.name} deletion failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		const deleteDuration = Date.now() - deleteStartTime;
		console.log(
			`\n[stress] ✓ Deletion complete: ${deleted}/${filesToDelete.length} files in ${(deleteDuration / 1000).toFixed(1)}s`,
		);

		// ========================================================================
		// SUMMARY
		// ========================================================================
		const totalDuration = storageDuration + uploadDuration + deleteDuration;
		console.log("\n" + "=".repeat(80));
		console.log("STRESS TEST SUMMARY");
		console.log("=".repeat(80));
		console.log(`Bucket: ${STRESS_CONFIG.bucketName} (${bucketId})`);
		console.log(`Files generated: ${files.length}`);
		console.log(
			`Storage requests: ${storageRequested}/${files.length} (${((storageRequested / files.length) * 100).toFixed(1)}%)`,
		);
		console.log(`  Duration: ${(storageDuration / 1000).toFixed(1)}s`);
		console.log(
			`Files uploaded: ${uploaded}/${storageRequested} (${((uploaded / storageRequested) * 100).toFixed(1)}%)`,
		);
		console.log(`  Duration: ${(uploadDuration / 1000).toFixed(1)}s`);
		console.log(
			`  Average: ${uploaded > 0 ? (uploadDuration / uploaded).toFixed(0) : 0}ms per file`,
		);
		console.log(
			`Files deleted: ${deleted}/${filesToDelete.length} (${((deleted / filesToDelete.length) * 100).toFixed(1)}%)`,
		);
		console.log(`  Duration: ${(deleteDuration / 1000).toFixed(1)}s`);
		console.log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
		console.log("=".repeat(80));

		if (
			storageRequested === files.length &&
			uploaded === storageRequested &&
			deleted === filesToDelete.length
		) {
			console.log("✅ Stress test PASSED");
		} else {
			console.log("⚠️ Stress test completed with some failures");
			process.exitCode = 1;
		}
	} catch (error) {
		console.error("\n[stress] ✗ Fatal error:", error);
		throw error;
	}
}

// Run if executed directly
if (import.meta.main) {
	runFileUploadStress({})
		.then(() => {
			console.log("\n[stress] Done");
		})
		.catch((err) => {
			console.error("\n[stress] ✗ Crashed:", err);
			process.exit(1);
		});
}

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
import type { StressRunOptions } from "./index";

// ============================================================================
// STRESS TEST CONFIG
// ============================================================================
const STRESS_CONFIG = {
  bucketName: "stress-test-bucket", // Static bucket name
  fileCount: 25, // Number of files to upload
  fileSizeBytes: 500 * 1024, // 10 KB per file
  concurrency: 5, // Upload N files at a time
};

// ============================================================================
// HELPERS
// ============================================================================

function generateRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function to0x(val: string): `0x${string}` {
  return val.startsWith("0x")
    ? (val as `0x${string}`)
    : (`0x${val}` as `0x${string}`);
}

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

    // Upload files in batches
    console.log(
      `[stress] Uploading files (${STRESS_CONFIG.concurrency} concurrent)...`,
    );
    const startTime = Date.now();
    let uploaded = 0;

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

    for (let i = 0; i < files.length; i += STRESS_CONFIG.concurrency) {
      const batch = files.slice(i, i + STRESS_CONFIG.concurrency);
      const batchNum = Math.floor(i / STRESS_CONFIG.concurrency) + 1;
      const totalBatches = Math.ceil(files.length / STRESS_CONFIG.concurrency);

      console.log(
        `[stress] Batch ${batchNum}/${totalBatches}: Uploading ${batch.length} files...`,
      );

      await Promise.all(
        batch.map(async (file) => {
          try {
            // Create FileManager from bytes
            const fileManager = new FM({
              size: file.bytes.length,
              stream: () =>
                Readable.toWeb(
                  Readable.from(file.bytes),
                ) as ReadableStream<Uint8Array>,
            });

            // Get fingerprint
            const fingerprint = await fileManager.getFingerprint();

            // Issue storage request
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

            // Wait for MSP to process (2s as per demo)
            await sleep(2_000);

            // Recompute file key after storage request
            const recomputedFM = new FM({
              size: file.bytes.length,
              stream: () =>
                Readable.toWeb(
                  Readable.from(file.bytes),
                ) as ReadableStream<Uint8Array>,
            });

            const fileKey = await recomputedFM.computeFileKey(
              owner,
              bucketIdH256,
              file.location,
            );
            const fileKeyHex = fileKey.toHex() as `0x${string}`;
            file.fileKey = fileKeyHex;

            // Upload file
            const freshFM = new FM({
              size: file.bytes.length,
              stream: () =>
                Readable.toWeb(
                  Readable.from(file.bytes),
                ) as ReadableStream<Uint8Array>,
            });

            const freshBlob = await freshFM.getFileBlob();
            const uploadResult = await mspClient.files.uploadFile(
              bucketId,
              fileKeyHex,
              freshBlob,
              account.address,
              file.location,
            );

            if (uploadResult.status !== "upload_successful") {
              throw new Error(`Upload failed: ${uploadResult.status}`);
            }

            uploaded++;
            console.log(
              `[stress]   ✓ ${file.name} uploaded (${uploaded}/${files.length})`,
            );
          } catch (error) {
            console.error(
              `[stress]   ✗ ${file.name} failed:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    }

    const uploadDuration = Date.now() - startTime;
    console.log(
      `\n[stress] ✓ Upload complete: ${uploaded}/${files.length} files in ${(uploadDuration / 1000).toFixed(1)}s`,
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
    // STEP 3: Delete all uploaded files
    // ========================================================================
    console.log(`\n[stress] Deleting ${uploaded} uploaded files...`);
    const deleteStartTime = Date.now();
    let deleted = 0;

    const filesToDelete = files.filter((f) => f.fileKey);

    for (let i = 0; i < filesToDelete.length; i += STRESS_CONFIG.concurrency) {
      const batch = filesToDelete.slice(i, i + STRESS_CONFIG.concurrency);
      const batchNum = Math.floor(i / STRESS_CONFIG.concurrency) + 1;
      const totalBatches = Math.ceil(
        filesToDelete.length / STRESS_CONFIG.concurrency,
      );

      console.log(
        `[stress] Batch ${batchNum}/${totalBatches}: Deleting ${batch.length} files...`,
      );

      await Promise.all(
        batch.map(async (file) => {
          if (!file.fileKey) return;

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
        }),
      );
    }

    const deleteDuration = Date.now() - deleteStartTime;
    console.log(
      `\n[stress] ✓ Deletion complete: ${deleted}/${filesToDelete.length} files in ${(deleteDuration / 1000).toFixed(1)}s`,
    );

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log("\n" + "=".repeat(80));
    console.log("STRESS TEST SUMMARY");
    console.log("=".repeat(80));
    console.log(`Bucket: ${STRESS_CONFIG.bucketName} (${bucketId})`);
    console.log(`Files generated: ${files.length}`);
    console.log(
      `Files uploaded: ${uploaded}/${files.length} (${((uploaded / files.length) * 100).toFixed(1)}%)`,
    );
    console.log(`Upload duration: ${(uploadDuration / 1000).toFixed(1)}s`);
    console.log(
      `Average upload time: ${(uploadDuration / uploaded).toFixed(0)}ms per file`,
    );
    console.log(
      `Files deleted: ${deleted}/${filesToDelete.length} (${((deleted / filesToDelete.length) * 100).toFixed(1)}%)`,
    );
    console.log(`Deletion duration: ${(deleteDuration / 1000).toFixed(1)}s`);
    console.log(
      `Total duration: ${((uploadDuration + deleteDuration) / 1000).toFixed(1)}s`,
    );
    console.log("=".repeat(80));

    if (uploaded === files.length && deleted === filesToDelete.length) {
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

// Helper to extract peer ID from multiaddresses
function extractPeerId(multiaddrs: string[]): string {
  if (multiaddrs.length === 0) throw new Error("No multiaddresses available");
  const parts = multiaddrs[0].split("/");
  const peerIdIndex = parts.findIndex((p) => p === "p2p");
  if (peerIdIndex === -1 || peerIdIndex === parts.length - 1) {
    throw new Error("Could not extract peer ID from multiaddress");
  }
  return parts[peerIdIndex + 1];
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

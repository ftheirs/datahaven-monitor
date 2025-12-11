// Stage 6: File upload

import { readFile } from "node:fs/promises";
import { TypeRegistry } from "@polkadot/types";
import { FileManager, initWasm } from "@storagehub-sdk/core";
import type { FileManager as FM } from "@storagehub-sdk/core";
import { pollBackend, waitForStorageRequestFulfilled } from "../utils/waits";
import type { MonitorContext } from "../types";
import { sleep } from "../../util/helpers";

/**
 * Upload file to MSP backend with retry logic
 */
async function uploadWithRetry(
  ctx: MonitorContext,
  fileKey: string,
  fileBlob: Blob,
  {
    retries = 5,
    delayMs = 10_000,
  }: { retries?: number; delayMs?: number } = {},
) {
  for (let i = 0; i < retries; i++) {
    try {
      return await ctx.mspClient!.files.uploadFile(
        ctx.bucketId!,
        fileKey,
        fileBlob,
        ctx.account.address,
        ctx.fileLocation!,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If MSP says "not expecting file key", returns 400, or times out, wait and retry
      if (
        errorMsg.includes("not expecting") ||
        errorMsg.includes("400") ||
        errorMsg.includes("HTTP 400") ||
        errorMsg.includes("timed out") ||
        errorMsg.includes("timeout")
      ) {
        if (i < retries - 1) {
          console.log(
            `[file-upload] MSP not ready/slow, retrying in ${delayMs / 1000}s... (attempt ${i + 1}/${retries})`,
          );
          await sleep(delayMs);
          continue;
        }
      }

      // Other errors or final retry - throw
      throw error;
    }
  }
  throw new Error("Upload failed after all retries");
}

/**
 * Upload test file to MSP backend
 */
export async function fileUploadStage(ctx: MonitorContext): Promise<void> {
  if (
    !ctx.mspClient ||
    !ctx.userApi ||
    !ctx.bucketId ||
    !ctx.fileLocation ||
    !ctx.fingerprint ||
    !ctx.fileKey
  ) {
    throw new Error("Required context not initialized");
  }

  // Wait for MSP to process storage request
  console.log(
    `[file-upload] Waiting for MSP readiness (${ctx.network.delays.beforeUploadMs / 1000}s)...`,
  );
  await sleep(ctx.network.delays.beforeUploadMs);

  // Recompute file key after storage request (CRITICAL)
  console.log("[file-upload] Recomputing file key after storage request...");
  await initWasm();
  const fileBuffer = await readFile(ctx.network.test.testFilePath);
  const fileBlob = new Blob([fileBuffer]);
  const fileManager = new FileManager({
    size: fileBlob.size,
    stream: () => fileBlob.stream() as ReadableStream<Uint8Array>,
  });

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
  const finalFileKey = await fileManager.computeFileKey(
    owner,
    bucketIdH256,
    ctx.fileLocation,
  );
  const fileKeyHex = finalFileKey.toHex();

  console.log(`[file-upload] Recomputed file key: ${fileKeyHex}`);
  if (ctx.fileKey && fileKeyHex !== ctx.fileKey) {
    console.warn(
      `[file-upload] Warning: Recomputed fileKey differs from original`,
    );
  }

  // Get fresh blob for upload
  console.log("[file-upload] Getting fresh file blob...");
  const uploadBlob = await fileManager.getFileBlob();

  // Upload the file with retries
  console.log("[file-upload] Uploading file to MSP backend...");
  const uploadResponse = await uploadWithRetry(ctx, fileKeyHex, uploadBlob, {
    retries: 5,
    delayMs: 10_000,
  });

  // Verify upload response
  if (uploadResponse.status !== "upload_successful") {
    throw new Error(`Upload failed with status: ${uploadResponse.status}`);
  }
  if (uploadResponse.fileKey !== fileKeyHex) {
    throw new Error("Upload fileKey mismatch");
  }

  console.log(`[file-upload] ✓ File uploaded: ${fileKeyHex}`);

  // Listen for on-chain fulfillment
  console.log("[file-upload] Listening for StorageRequestFulfilled event...");
  const blockHash = await waitForStorageRequestFulfilled(
    ctx.userApi,
    fileKeyHex as `0x${string}`,
  );
  console.log(
    `[file-upload] StorageRequestFulfilled seen in block ${blockHash}`,
  );

  // Wait for file to be indexed by MSP backend
  console.log("[file-upload] Waiting for file to be indexed by MSP backend...");
  await pollBackend(
    async () => {
      try {
        const fileInfo = await ctx.mspClient!.files.getFileInfo(
          ctx.bucketId!,
          fileKeyHex,
        );
        return fileInfo && fileInfo.fileKey === fileKeyHex;
      } catch {
        return false;
      }
    },
    { retries: 40, delayMs: 3000 },
  );

  // Store the final fileKey in context for subsequent stages
  ctx.fileKey = fileKeyHex;

  console.log(`[file-upload] ✓ File uploaded and indexed: ${fileKeyHex}`);
}

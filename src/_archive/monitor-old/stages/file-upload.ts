// Stage 6: File upload

import { readFile } from "node:fs/promises";
import { TypeRegistry } from "@polkadot/types";
import type { AccountId20, H256 } from "@polkadot/types/interfaces";
import { FileManager } from "@storagehub-sdk/core";
import type { MspClient } from "@storagehub-sdk/msp-client";
import { pollBackend, sleep } from "../utils/waits";
import type { MonitorContext } from "../types";

/**
 * Upload file to MSP backend with retry logic
 */
async function uploadWithRetry(
  mspClient: MspClient,
  bucketId: string,
  fileKey: string,
  fileBlob: Blob,
  address: string,
  location: string,
  { retries = 3, delayMs = 5000 }: { retries?: number; delayMs?: number } = {},
) {
  for (let i = 0; i < retries; i += 1) {
    try {
      return await mspClient.files.uploadFile(
        bucketId,
        fileKey,
        fileBlob,
        address,
        location,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If MSP says "not expecting file key" or returns 400, wait and retry
      if (
        errorMsg.includes("not expecting") ||
        errorMsg.includes("400") ||
        errorMsg.includes("HTTP 400")
      ) {
        if (i < retries - 1) {
          console.log(
            `[file-upload] MSP not ready yet, retrying in ${delayMs / 1000}s... (attempt ${i + 1}/${retries})`,
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
    !ctx.fingerprint
  ) {
    throw new Error("Required context not initialized");
  }

  // CRITICAL: Recompute fileKey AFTER storage request (matching minimal flow)
  console.log("[file-upload] Recomputing file key after storage request...");
  const fileBuffer = await readFile(ctx.network.test.testFilePath);
  const fileBlob = new Blob([fileBuffer]);
  const fileManager = new FileManager({
    size: fileBlob.size,
    stream: () => fileBlob.stream() as ReadableStream<Uint8Array>,
  });

  const registry = new TypeRegistry();
  const owner = registry.createType("AccountId20", ctx.account.address);
  const bucketIdH256 = registry.createType("H256", ctx.bucketId);
  const finalFileKey = await fileManager.computeFileKey(
    owner as any,
    bucketIdH256 as any,
    ctx.fileLocation,
  );
  const fileKeyHex = finalFileKey.toHex();

  console.log(`[file-upload] Recomputed file key: ${fileKeyHex}`);
  if (ctx.fileKey && fileKeyHex !== ctx.fileKey) {
    console.warn(
      `[file-upload] Warning: Recomputed fileKey differs from original`,
    );
  }

  // Wait for MSP to process storage request (matching demo app timing)
  console.log(
    "[file-upload] Waiting for MSP to process storage request (15s)...",
  );
  await sleep(15000);

  // Get fresh blob for upload (matching minimal flow)
  console.log("[file-upload] Getting fresh file blob...");
  const uploadBlob = await fileManager.getFileBlob();

  // Upload the file with retries
  console.log("[file-upload] Uploading file to MSP backend...");
  const uploadResponse = await uploadWithRetry(
    ctx.mspClient,
    ctx.bucketId,
    fileKeyHex,
    uploadBlob,
    ctx.account.address,
    ctx.fileLocation,
    {
      retries: 5,
      delayMs: 10000,
    },
  );

  // Verify upload response
  if (uploadResponse.status !== "upload_successful") {
    throw new Error(`Upload failed with status: ${uploadResponse.status}`);
  }
  if (uploadResponse.fileKey !== fileKeyHex) {
    throw new Error("Upload fileKey mismatch");
  }
  if (`0x${uploadResponse.bucketId}` !== ctx.bucketId) {
    throw new Error("Upload bucketId mismatch");
  }
  if (uploadResponse.fingerprint !== ctx.fingerprint) {
    throw new Error("Upload fingerprint mismatch");
  }
  if (uploadResponse.location !== ctx.fileLocation) {
    throw new Error("Upload location mismatch");
  }

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
    (found) => found,
    { retries: 40, delayMs: 3000 },
  );

  // Store the final fileKey and blob in context for subsequent stages
  ctx.fileKey = fileKeyHex;
  ctx.fileBlob = uploadBlob;

  console.log(`[file-upload] ✓ File uploaded and indexed: ${fileKeyHex}`);
}

// Wait and polling utilities for monitor

import type { FileTree, MspClient } from "@storagehub-sdk/msp-client";
import { sleep } from "../../util/helpers";
import type { EnrichedUserApi } from "../../userApi";

/**
 * Wait for chain finalization (next finalized block)
 */
export async function waitForFinalization(
  userApi: EnrichedUserApi,
): Promise<void> {
  const currentHdr = await userApi.rpc.chain.getHeader();
  const target = currentHdr.number.toBigInt() + 1n;
  await userApi.wait.finalizedAtLeast(target);
}

/**
 * Wait for on-chain data with polling
 */
export async function waitForOnChainData<T>(
  query: () => Promise<T>,
  validator: (data: T) => boolean,
  { retries = 24, delayMs = 5000 }: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const data = await query();
    if (validator(data)) return data;
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for on-chain data (${retries * delayMs}ms)`);
}

/**
 * Poll MSP backend with retry
 */
export async function pollBackend(
  fetchFn: () => Promise<boolean>,
  { retries = 40, delayMs = 3000 }: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fetchFn();
      if (result) return;
    } catch {
      // Ignore errors and continue polling
    }
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for MSP backend (${retries * delayMs}ms)`);
}

/**
 * Wait for StorageRequestFulfilled event for a specific fileKey
 */
export async function waitForStorageRequestFulfilled(
  userApi: EnrichedUserApi,
  fileKey: `0x${string}`,
  timeoutMs = 660_000, // 11 minutes (networks/backends can be slow/flaky)
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Timeout waiting for StorageRequestFulfilled");
    }
    const { blockHash, event } = await userApi.wait.forFinalizedEvent(
      "fileSystem",
      "StorageRequestFulfilled",
      remaining,
    );
    const data = userApi.events.fileSystem.StorageRequestFulfilled.is(
      event.event,
    )
      ? (event.event.data as unknown as
        | { fileKey?: { toString: () => string } }
        | any[])
      : undefined;
    const emittedFileKey =
      (data as any)?.fileKey?.toString?.() ??
      (Array.isArray(data) && data[0]?.toString?.());
    if (
      emittedFileKey &&
      emittedFileKey.toString().toLowerCase() === fileKey.toLowerCase()
    ) {
      return blockHash;
    }
    // Continue listening if event doesn't match our fileKey
  }
}

/**
 * Wait until storage request is cleared from on-chain storageRequests
 */
export async function waitForStorageRequestCleared(
  userApi: EnrichedUserApi,
  fileKey: `0x${string}`,
  timeoutMs = 120_000,
  stepMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const storageRequest =
      await userApi.query.fileSystem.storageRequests(fileKey);
    if ((storageRequest as any).isNone) return;
    if (Date.now() >= deadline) {
      throw new Error("Timeout waiting for storage request to clear");
    }
    await sleep(stepMs);
  }
}

function findFileStatus(
  files: FileTree[],
  fileKey: `0x${string}`,
): string | undefined {
  const target = fileKey.toLowerCase();
  const stack: FileTree[] = [...files];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "file") {
      if (node.fileKey.toLowerCase() === target) return node.status;
    } else {
      stack.push(...node.children);
    }
  }
  return undefined;
}

function formatMspStatus(status: string): string {
  if (status === "ready") return "Ready";
  if (status === "in_progress" || status === "inProgress") return "InProgress";
  if (status === "missing") return "Missing";
  return status;
}

/**
 * Wait for MSP file status to become ready, with snapshot logging.
 */
export async function waitForMspFileReadyWithSnapshot(
  mspClient: MspClient,
  bucketId: `0x${string}`,
  fileKey: `0x${string}`,
  {
    timeoutMs = 660_000,
    intervalMs = 30_000,
    label = "file",
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {},
): Promise<void> {
  console.log(
    `[${label}] Waiting for MSP file to be ready via bucket getFiles...`,
  );
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  let attempt = 0;

  while (true) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const resp = await mspClient.buckets.getFiles(bucketId);
      const status = findFileStatus(resp.files, fileKey) ?? "missing";

      if (lastStatus !== "ready" && status === "ready") {
        console.log(`[${label}] MSP file became ready: ${fileKey}`);
      }
      lastStatus = status;

      console.log("=".repeat(80));
      console.log(
        `[${label}] MSP status snapshot (attempt ${attempt}, remaining=${Math.max(
          0,
          Math.round(remainingMs / 1000),
        )}s):`,
      );
      console.log(
        `  Filekey: ${fileKey} Status: ${formatMspStatus(lastStatus)}`,
      );
      console.log("=".repeat(80));

      if (status === "expired" || status === "missing") {
        throw new Error(
          `MSP file status ${formatMspStatus(status)} (aborting)`,
        );
      }

      if (status === "ready") return;
    } catch {
      // ignore transient backend errors and continue polling
    }

    await sleep(intervalMs);
  }

  console.log(
    `[${label}] Timeout waiting for MSP file to be ready (lastStatus=${formatMspStatus(
      lastStatus ?? "unknown",
    )})`,
  );
  throw new Error("Timeout waiting for MSP file to be ready");
}

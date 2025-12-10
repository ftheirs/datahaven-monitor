// Wait and polling utilities for monitor

import type { EnrichedUserApi } from "../../userApi";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  timeoutMs = 180_000,
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
    const data = userApi.events.fileSystem.StorageRequestFulfilled.is(event.event)
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


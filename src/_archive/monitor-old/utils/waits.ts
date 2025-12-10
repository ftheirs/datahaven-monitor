// Wait and polling utilities for monitor stages

import type { EnrichedUserApi } from "../../userApi";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait for the chain to finalize at least the target block number
 */
export async function waitForFinalization(
  userApi: EnrichedUserApi,
  minBlockNumber?: bigint,
): Promise<void> {
  const currentHeader = await userApi.rpc.chain.getHeader();
  const target = minBlockNumber ?? currentHeader.number.toBigInt() + 1n;
  await userApi.wait.finalizedAtLeast(target);
}

/**
 * Poll a backend endpoint until a condition is met
 */
export async function pollBackend<T>(
  fetchFn: () => Promise<T>,
  validator: (data: T) => boolean,
  { retries = 40, delayMs = 3000 }: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const data = await fetchFn();
      if (validator(data)) {
        return data;
      }
    } catch {
      // Ignore errors and continue polling
    }
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for backend (${retries * delayMs}ms)`);
}

/**
 * Wait for on-chain data to satisfy a condition
 */
export async function waitForOnChainData<T>(
  query: () => Promise<T>,
  validator: (data: T) => boolean,
  { retries = 24, delayMs = 5000 }: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  for (let i = 0; i < retries; i += 1) {
    const data = await query();
    if (validator(data)) {
      return data;
    }
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for on-chain data (${retries * delayMs}ms)`);
}

/**
 * Wait for storage request to be ready for upload by waiting for finalized blocks
 * and verifying the storage request still exists (not rejected)
 *
 * This approach works on public networks where MSP node RPC is not accessible
 */
export async function waitForStorageRequestReady(
  userApi: EnrichedUserApi,
  fileKey: string,
  {
    blocks = 6,
    extraDelayMs = 10000,
  }: { blocks?: number; extraDelayMs?: number } = {},
): Promise<void> {
  // 1. Wait for several finalized blocks (gives MSP time to index)
  console.log(
    `[wait] Waiting for ${blocks} finalized blocks (~${(blocks * 6) / 60} minutes)...`,
  );
  const currentHeader = await userApi.rpc.chain.getHeader();
  const targetBlock = currentHeader.number.toBigInt() + BigInt(blocks);
  await userApi.wait.finalizedAtLeast(targetBlock);

  // 2. Extra delay to ensure MSP backend has processed
  console.log(
    `[wait] Waiting additional ${extraDelayMs / 1000}s for MSP backend processing...`,
  );
  await sleep(extraDelayMs);

  // 3. Verify storage request still exists (not rejected)
  console.log("[wait] Verifying storage request still exists...");
  const storageRequest =
    await userApi.query.fileSystem.storageRequests(fileKey);
  if ((storageRequest as any).isNone) {
    throw new Error(
      "Storage request no longer exists - may have been rejected by MSP",
    );
  }

  console.log("[wait] Storage request is ready for upload");
}

/**
 * Combined wait: finalization + on-chain data + backend indexing
 */
export async function waitForIndexed(
  userApi: EnrichedUserApi,
  chainQuery: () => Promise<boolean>,
  backendQuery: () => Promise<boolean>,
): Promise<void> {
  // 1. Wait for finalization
  await waitForFinalization(userApi);

  // 2. Wait for on-chain data
  await waitForOnChainData(chainQuery, (exists) => exists);

  // 3. Wait for backend to index
  await pollBackend(backendQuery, (indexed) => indexed);
}

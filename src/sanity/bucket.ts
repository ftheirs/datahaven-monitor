// Sanity test: basic bucket creation flow using StorageHubClient and MspClient.
// Goal: create a uniquely named bucket, wait for the tx to be included, and verify
// its presence via the MSP backend.

import type { StorageHubClient } from "@storagehub-sdk/core";
import type { Bucket, MspClient, ValueProp } from "@storagehub-sdk/msp-client";

import { logCheckResult } from "../util/logger";
import type { ViemClients } from "../util/viemClient";

const NAMESPACE = "sanity/bucket";

export async function runBucketCreationCheck(
  storageHubClient: StorageHubClient,
  mspClient: MspClient,
  viem: ViemClients,
): Promise<[string, string]> {
  const bucketName = `sanity-bucket-${Date.now().toString(36)}`;

  // 1) Fetch value propositions from MSP backend and pick one.
  const sdkValueProps: ValueProp[] = await mspClient.info.getValuePropositions();
  if (!Array.isArray(sdkValueProps) || sdkValueProps.length === 0) {
    throw new Error("No value propositions returned by MSP backend.");
  }

  const selectedVp = sdkValueProps[0];
  if (!selectedVp.id) {
    throw new Error("Selected value proposition has no id.");
  }

  const valuePropId = selectedVp.id as `0x${string}`;
  const mspId = (("mspId" in selectedVp && selectedVp.mspId) || selectedVp.id) as `0x${string}`;

  // 2) Derive a bucket ID for the current account and chosen name.
  const bucketId = (await storageHubClient.deriveBucketId(
    viem.account.address,
    bucketName,
  )) as string;

  // 3) Create the bucket via the StorageHub client.
  const txHash = await storageHubClient.createBucket(mspId, bucketName, false, valuePropId);
  if (!txHash) {
    throw new Error("Create bucket did not return a transaction hash.");
  }

  // 4) Wait for transaction receipt and ensure success.
  const receipt = await viem.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Create bucket transaction failed.");
  }

  // TODO: wait until backend returns the new bucket

  // 5) Verify via MSP that the bucket is now listed.
  const listedBuckets: Bucket[] = await mspClient.buckets.listBuckets();
  const expectedBucketId = `0x${bucketId}`;
  const found =
    Array.isArray(listedBuckets)
    && listedBuckets.some((b) => `0x${b.bucketId}` === expectedBucketId);

  if (!found) {
    throw new Error("MSP listBuckets did not include the newly created bucket.");
  }

  logCheckResult(NAMESPACE, "Bucket creation", true);

  return [bucketName, bucketId];
}

export async function runBucketDeletionCheck(
  storageHubClient: StorageHubClient,
  mspClient: MspClient,
  viem: ViemClients,
  bucketName: string,
  bucketId: string,
): Promise<void> {
  // 1) Delete the bucket via the StorageHub client.
  const deleteTxHash = await storageHubClient.deleteBucket(bucketId as `0x${string}`);
  if (!deleteTxHash) {
    throw new Error(`Delete bucket "${bucketName}" did not return a transaction hash.`);
  }

  // 2) Wait for transaction receipt and ensure success.
  const deleteReceipt = await viem.publicClient.waitForTransactionReceipt({ hash: deleteTxHash });
  if (deleteReceipt.status !== "success") {
    throw new Error(`Delete bucket "${bucketName}" transaction failed.`);
  }

  // TODO: wait until bucket is deleted and no longer displayed in backend

  // 3) Verify via MSP that the bucket is no longer listed.
  const listedBuckets: Bucket[] = await mspClient.buckets.listBuckets();
  const expectedBucketId = `0x${bucketId}`;
  const stillPresent =
    Array.isArray(listedBuckets)
    && listedBuckets.some((b) => `0x${b.bucketId}` === expectedBucketId);

  if (stillPresent) {
    throw new Error(`MSP listBuckets still includes bucket "${bucketName}" after deletion.`);
  }

  logCheckResult(NAMESPACE, "Bucket deletion", true);
}



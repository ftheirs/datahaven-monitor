// Entry point for the sanity test suite.
// Flow:
//   Create network config + viem clients
//   Connection check (StorageHub + MSP + RPC chain id)
//   MSP backend health check
//   MSP SIWE auth check
//   Hello-world SDK import check

import type { Session, SessionProvider } from "@storagehub-sdk/msp-client";
import { logSectionSeparator } from "../util/logger";
import { createViemClients } from "../util/viemClient";
import { runBucketCreationCheck, runBucketDeletionCheck } from "./bucket";
import { getNetworkConfigFromEnv } from "./config";
import { runConnectionCheck } from "./connection";
import {
  createRandomBinaryFile,
  generateFileLocation,
  loadLocalFileBlob,
  runFileDeletionCheck,
  runFileDownloadCheck,
  runIssueStorageRequest,
  runFileUploadCheck,
} from "./files";
import { runBackendHealthCheck } from "./healthcheck";
import { runHelloWorld } from "./helloWorld";
import { runSiweAuthCheck } from "./siwx";

async function main(): Promise<void> {
  try {
    // Create network config + viem clients.
    const network = getNetworkConfigFromEnv();
    const viem = createViemClients(network);

    // Session provider is passed in so that connection/auth tests do not own how
    // sessions are persisted. We use a simple in-memory implementation for now.
    let currentSession: Session | undefined;
    const sessionProvider: SessionProvider = async () => currentSession;

    // Ensure we can connect to StorageHub and MSP backends.
    console.log("[sanity] Running connection check…");
    const [storageHubClient, mspClient] = await runConnectionCheck(
      network,
      viem,
      sessionProvider,
    );
    logSectionSeparator("Connection");

    // Check MSP backend health.
    console.log("[sanity] Running MSP backend health check…");
    await runBackendHealthCheck(mspClient);
    logSectionSeparator("MSP Health");

    // Perform SIWE-style authentication against the MSP backend.
    console.log("[sanity] Running MSP SIWE auth check…");
    const siweSession = await runSiweAuthCheck(mspClient, viem);
    // Make the authenticated session available through the SessionProvider so
    // subsequent calls can use authenticated methods.
    currentSession = siweSession;
    logSectionSeparator("MSP SIWE");

    // Create a bucket via the SDK and verify via MSP.
    console.log("[sanity] Running bucket creation check…");
    const [bucketName, bucketId] = await runBucketCreationCheck(
      storageHubClient,
      mspClient,
      viem,
    );
    // bucketName and bucketId can be reused by subsequent sanity steps when needed.
    logSectionSeparator("Bucket");

    // Issue storage request + upload adolphus.jpg (from resources).
    console.log("[sanity] Running adolphus.jpg storage request + upload…");
    const valueProps = await mspClient.info.getValuePropositions();
    if (!Array.isArray(valueProps) || valueProps.length === 0) {
      throw new Error("No value propositions available to determine MSP ID.");
    }
    const selectedVp = valueProps[0];
    const mspId =
      (("mspId" in selectedVp && selectedVp.mspId) || selectedVp.id) as `0x${string}`;
    const adolphusBlob = await loadLocalFileBlob(
      "../../resources/adolphus.jpg",
      "image/jpeg",
    );
    const adolphusLocation = generateFileLocation("adolphus.jpg");
    const { fileKey: adolphusFileKey, fileBlob: adolphusFile } =
      await runIssueStorageRequest(
        storageHubClient,
        viem,
        bucketId,
        adolphusBlob,
        adolphusLocation,
        mspId,
        network.defaults.replicationLevel,
        network.defaults.replicas,
      );
    await runFileUploadCheck(
      mspClient,
      bucketId,
      viem.account.address,
      adolphusBlob,
      adolphusLocation,
      adolphusFileKey,
    );
    logSectionSeparator("Adolphus.jpg Upload");

    // Download adolphus.jpg and verify content.
    console.log("[sanity] Running adolphus.jpg download check…");
    await runFileDownloadCheck(mspClient, adolphusFileKey, adolphusFile);
    logSectionSeparator("Adolphus.jpg Download");

    // Issue storage request + upload a random 5MB binary file.
    console.log("[sanity] Running random 5MB storage request + upload…");
    const randomFile = createRandomBinaryFile(5 * 1024 * 1024);
    const randomLocation = generateFileLocation("random-5mb.bin");
    const { fileKey: randomFileKey, fileBlob: randomFileBlob } =
      await runIssueStorageRequest(
        storageHubClient,
        viem,
        bucketId,
        randomFile,
        randomLocation,
        mspId,
        network.defaults.replicationLevel,
        network.defaults.replicas,
      );
    await runFileUploadCheck(
      mspClient,
      bucketId,
      viem.account.address,
      randomFile,
      randomLocation,
      randomFileKey,
    );
    logSectionSeparator("Random 5MB Upload");

    // Download the random binary file and verify content.
    console.log("[sanity] Running random binary file download check…");
    await runFileDownloadCheck(mspClient, randomFileKey, randomFileBlob);
    logSectionSeparator("Random Binary Download");

    // Delete adolphus.jpg and verify it's removed.
    console.log("[sanity] Running adolphus.jpg deletion check…");
    await runFileDeletionCheck(
      storageHubClient,
      mspClient,
      viem,
      bucketId,
      adolphusFileKey,
    );
    logSectionSeparator("Adolphus.jpg Deletion");

    // Delete the random binary file and verify it's removed.
    console.log("[sanity] Running random binary file deletion check…");
    await runFileDeletionCheck(
      storageHubClient,
      mspClient,
      viem,
      bucketId,
      randomFileKey,
    );
    logSectionSeparator("Random Binary Deletion");

    // Verify SDK imports / basic behavior.
    console.log("[sanity] Starting hello-world sanity check…");
    await runHelloWorld();
    console.log("[sanity] Hello-world sanity check completed successfully.");
    logSectionSeparator("Hello World");

    // Delete the bucket and verify it is gone.
    console.log("[sanity] Running bucket deletion check…");
    await runBucketDeletionCheck(
      storageHubClient,
      mspClient,
      viem,
      bucketName,
      bucketId,
    );
    logSectionSeparator("Bucket Deletion");
  } catch (error) {
    console.error("[sanity] Sanity suite failed:", error);
    process.exitCode = 1;
  }
}

void main();

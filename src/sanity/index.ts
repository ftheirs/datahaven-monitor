// Entry point for the Testnet Sentinel sanity suite.
// Flow is parameterized so CI workflows can stop at a specific checkpoint while
// still reusing the same underlying steps.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

type Stage =
  | "connection"
  | "health"
  | "siwe"
  | "upload"
  | "download"
  | "delete"
  | "sdk";

type StageStatus = "passed" | "failed" | "skipped";

const SANITY_TARGETS = [
  "connection",
  "health",
  "siwe",
  "upload",
  "download",
  "delete",
  "full",
] as const;

export type SanityTarget = (typeof SANITY_TARGETS)[number];

const STAGE_LABELS: Record<Stage, string> = {
  connection: "Connection",
  health: "Health",
  siwe: "SIWE",
  upload: "Upload",
  download: "Download",
  delete: "Delete",
  sdk: "SDK",
};

function resolveTarget(): SanityTarget {
  const input = (process.env.SANITY_TARGET ?? process.argv[2] ?? "full").toLowerCase();
  if (SANITY_TARGETS.includes(input as SanityTarget)) {
    return input as SanityTarget;
  }
  console.warn(`[sanity] Unknown SANITY_TARGET "${input}", defaulting to "full".`);
  return "full";
}

function shouldStopAt(target: SanityTarget, checkpoint: SanityTarget): boolean {
  return target === checkpoint;
}

function assertPresent<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is not initialized`);
  }
  return value;
}

async function writeStatusFile(
  statusFilePath: string,
  stageStatuses: Record<Stage, StageStatus>,
): Promise<void> {
  const payload = {
    generatedAt: new Date().toISOString(),
    stages: stageStatuses,
  };
  await mkdir(dirname(statusFilePath), { recursive: true });
  await writeFile(statusFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function runSanitySuite(target: SanityTarget = "full"): Promise<void> {
  // Create network config + viem clients.
  const network = getNetworkConfigFromEnv();
  const viem = createViemClients(network);

  // Session provider is passed in so that connection/auth tests do not own how
  // sessions are persisted. We use a simple in-memory implementation for now.
  let currentSession: Session | undefined;
  const sessionProvider: SessionProvider = async () => currentSession;

  let storageHubClient: Awaited<ReturnType<typeof runConnectionCheck>>[0] | undefined;
  let mspClient: Awaited<ReturnType<typeof runConnectionCheck>>[1] | undefined;
  let bucketName: string | undefined;
  let bucketId: string | undefined;
  let adolphusFileKey: `0x${string}` | undefined;
  let randomFileKey: `0x${string}` | undefined;
  let adolphusFileBlob: Blob | undefined;
  let randomFileBlob: Blob | undefined;

  const stageStatuses: Record<Stage, StageStatus> = {
    connection: "skipped",
    health: "skipped",
    siwe: "skipped",
    upload: "skipped",
    download: "skipped",
    delete: "skipped",
    sdk: "skipped",
  };
  const statusFile = process.env.SANITY_STATUS_FILE ?? "sanity-status.json";

  async function runStage(stage: Stage, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      stageStatuses[stage] = "passed";
    } catch (error) {
      stageStatuses[stage] = "failed";
      throw error;
    }
  }

  async function cleanup(label: string): Promise<void> {
    if (!storageHubClient || !mspClient || !bucketId || !bucketName) {
      return;
    }

    try {
      if (adolphusFileKey) {
        await runFileDeletionCheck(
          storageHubClient,
          mspClient,
          viem,
          bucketId,
          adolphusFileKey,
        );
      }
    } catch (error) {
      console.warn(`[sanity] Cleanup (${label}) failed while deleting adolphus.jpg:`, error);
    }

    try {
      if (randomFileKey) {
        await runFileDeletionCheck(
          storageHubClient,
          mspClient,
          viem,
          bucketId,
          randomFileKey,
        );
      }
    } catch (error) {
      console.warn(`[sanity] Cleanup (${label}) failed while deleting random file:`, error);
    }

    try {
      await runBucketDeletionCheck(
        storageHubClient,
        mspClient,
        viem,
        bucketName,
        bucketId,
      );
    } catch (error) {
      console.warn(`[sanity] Cleanup (${label}) failed while deleting bucket:`, error);
    }
  }

  try {
    console.log(`[sanity] Running Testnet Sentinel with target="${target}"…`);

    await runStage("connection", async () => {
      // Ensure we can connect to StorageHub and MSP backends.
      console.log("[sanity] Running connection check…");
      [storageHubClient, mspClient] = await runConnectionCheck(network, viem, sessionProvider);
      logSectionSeparator("Connection");
    });

    if (shouldStopAt(target, "connection")) {
      return;
    }

    await runStage("health", async () => {
      // Check MSP backend health.
      console.log("[sanity] Running MSP backend health check…");
      const msp = assertPresent(mspClient, "mspClient");
      await runBackendHealthCheck(msp);
      logSectionSeparator("MSP Health");
    });

    if (shouldStopAt(target, "health")) {
      return;
    }

    await runStage("siwe", async () => {
      // Perform SIWE-style authentication against the MSP backend.
      console.log("[sanity] Running MSP SIWE auth check…");
      const msp = assertPresent(mspClient, "mspClient");
      const siweSession = await runSiweAuthCheck(msp, viem);
      // Make the authenticated session available through the SessionProvider so
      // subsequent calls can use authenticated methods.
      currentSession = siweSession;
      logSectionSeparator("MSP SIWE");
    });

    if (shouldStopAt(target, "siwe")) {
      return;
    }

    await runStage("upload", async () => {
      // Create a bucket via the SDK and verify via MSP.
      console.log("[sanity] Running bucket creation check…");
      const sh = assertPresent(storageHubClient, "storageHubClient");
      const msp = assertPresent(mspClient, "mspClient");
      [bucketName, bucketId] = await runBucketCreationCheck(
        sh,
        msp,
        viem,
      );
      logSectionSeparator("Bucket");

      // Resolve MSP ID for subsequent storage requests.
      const valueProps = await msp.info.getValuePropositions();
      if (!Array.isArray(valueProps) || valueProps.length === 0) {
        throw new Error("No value propositions available to determine MSP ID.");
      }
      const selectedVp = valueProps[0];
      const mspId =
        (("mspId" in selectedVp && selectedVp.mspId) || selectedVp.id) as `0x${string}`;

      // Issue storage request + upload adolphus.jpg (from resources).
      console.log("[sanity] Running adolphus.jpg storage request + upload…");
      const adolphusBlob = await loadLocalFileBlob(
        "../../resources/adolphus.jpg",
        "image/jpeg",
      );
      const adolphusLocation = generateFileLocation("adolphus.jpg");
      const adolphusResult = await runIssueStorageRequest(
        sh,
        viem,
        assertPresent(bucketId, "bucketId"),
        adolphusBlob,
        adolphusLocation,
        mspId,
        network.defaults.replicationLevel,
        network.defaults.replicas,
      );
      adolphusFileKey = adolphusResult.fileKey;
      adolphusFileBlob = adolphusResult.fileBlob;
      await runFileUploadCheck(
        msp,
        assertPresent(bucketId, "bucketId"),
        viem.account.address,
        adolphusBlob,
        adolphusLocation,
        adolphusFileKey,
      );
      logSectionSeparator("Adolphus.jpg Upload");

      // Issue storage request + upload a random 5MB binary file.
      console.log("[sanity] Running random 5MB storage request + upload…");
      const randomFile = createRandomBinaryFile(5 * 1024 * 1024);
      const randomLocation = generateFileLocation("random-5mb.bin");
      const randomResult = await runIssueStorageRequest(
        sh,
        viem,
        assertPresent(bucketId, "bucketId"),
        randomFile,
        randomLocation,
        mspId,
        network.defaults.replicationLevel,
        network.defaults.replicas,
      );
      randomFileKey = randomResult.fileKey;
      randomFileBlob = randomResult.fileBlob;
      await runFileUploadCheck(
        msp,
        assertPresent(bucketId, "bucketId"),
        viem.account.address,
        randomFile,
        randomLocation,
        randomFileKey,
      );
      logSectionSeparator("Random 5MB Upload");
    });

    if (shouldStopAt(target, "upload")) {
      await cleanup("upload");
      return;
    }

    await runStage("download", async () => {
      // Download adolphus.jpg and verify content.
      if (!adolphusFileKey || !adolphusFileBlob) {
        throw new Error("Missing adolphus upload artifacts for download check.");
      }
      console.log("[sanity] Running adolphus.jpg download check…");
      await runFileDownloadCheck(assertPresent(mspClient, "mspClient"), adolphusFileKey, adolphusFileBlob);
      logSectionSeparator("Adolphus.jpg Download");

      // Download the random binary file and verify content.
      if (!randomFileKey || !randomFileBlob) {
        throw new Error("Missing random file artifacts for download check.");
      }
      console.log("[sanity] Running random binary file download check…");
      await runFileDownloadCheck(assertPresent(mspClient, "mspClient"), randomFileKey, randomFileBlob);
      logSectionSeparator("Random Binary Download");
    });

    if (shouldStopAt(target, "download")) {
      await cleanup("download");
      return;
    }

    await runStage("delete", async () => {
      // Delete adolphus.jpg and verify it's removed.
      console.log("[sanity] Running adolphus.jpg deletion check…");
      await runFileDeletionCheck(
        assertPresent(storageHubClient, "storageHubClient"),
        assertPresent(mspClient, "mspClient"),
        viem,
        assertPresent(bucketId, "bucketId"),
        assertPresent(adolphusFileKey, "adolphusFileKey"),
      );
      logSectionSeparator("Adolphus.jpg Deletion");

      // Delete the random binary file and verify it's removed.
      console.log("[sanity] Running random binary file deletion check…");
      await runFileDeletionCheck(
        assertPresent(storageHubClient, "storageHubClient"),
        assertPresent(mspClient, "mspClient"),
        viem,
        assertPresent(bucketId, "bucketId"),
        assertPresent(randomFileKey, "randomFileKey"),
      );
      logSectionSeparator("Random Binary Deletion");
    });

    if (shouldStopAt(target, "delete")) {
      await runBucketDeletionCheck(
        assertPresent(storageHubClient, "storageHubClient"),
        assertPresent(mspClient, "mspClient"),
        viem,
        assertPresent(bucketName, "bucketName"),
        assertPresent(bucketId, "bucketId"),
      );
      logSectionSeparator("Bucket Deletion");
      return;
    }

    await runStage("sdk", async () => {
      // Verify SDK imports / basic behavior.
      console.log("[sanity] Starting SDK smoke check…");
      await runHelloWorld();
      console.log("[sanity] SDK smoke check completed successfully.");
      logSectionSeparator("SDK Smoke");
    });

    // Delete the bucket and verify it is gone.
    console.log("[sanity] Running bucket deletion check…");
    await runBucketDeletionCheck(
      assertPresent(storageHubClient, "storageHubClient"),
      assertPresent(mspClient, "mspClient"),
      viem,
      assertPresent(bucketName, "bucketName"),
      assertPresent(bucketId, "bucketId"),
    );
    logSectionSeparator("Bucket Deletion");
  } catch (error) {
    console.error("[sanity] Sanity suite failed:", error);
    await cleanup("failure");
    process.exitCode = 1;
  } finally {
    try {
      await writeStatusFile(statusFile, stageStatuses);
    } catch (writeError) {
      console.error("[sanity] Failed to write status file:", writeError);
    }
  }
}

void runSanitySuite(resolveTarget());

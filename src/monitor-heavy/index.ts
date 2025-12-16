// Alternative heavy monitor entrypoint
// NOTE: This does not replace the existing monitor. It is designed for higher-load scenarios.

import { TypeRegistry } from "@polkadot/types";
import {
  FileManager,
  ReplicationLevel,
  SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
  StorageHubClient,
  initWasm,
  type FileInfo as CoreFileInfo,
} from "@storagehub-sdk/core";
import { MspClient } from "@storagehub-sdk/msp-client";
import type { FileTree, Session } from "@storagehub-sdk/msp-client";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Readable } from "node:stream";

import { getNetworkConfig, getPrivateKey } from "../monitor/config";
import { createUserApi } from "../userApi";
import {
  pollBackend,
  waitForStorageRequestCleared,
} from "../monitor/utils/waits";
import {
  extractPeerId,
  generateRandomBytes,
  sleep,
  to0x,
} from "../util/helpers";

type HeavyPhaseStatus = "passed" | "failed" | "skipped";
type HeavyPhaseResult = {
  name: string;
  status: HeavyPhaseStatus;
  durationMs: number;
  error?: string;
};

type BadgeEndpoint = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
};

function phaseLabel(name: string): string {
  // Keep these human-friendly for Slack + future badges
  switch (name) {
  case "bucket-create":
    return "Bucket Create";
  case "storage-request-batch1":
    return "Storage Req (Batch 1)";
  case "upload-batch1":
    return "Upload (Batch 1)";
  case "file-delete-first5":
    return "Delete Half";
  case "storage-request-batch2":
    return "Storage Req (Batch 2)";
  case "upload-batch2":
    return "Upload (Batch 2)";
  case "file-delete-all10":
    return "Delete All";
  case "bucket-delete":
    return "Bucket Delete";
  default:
    return name;
  }
}

function statusColor(status: HeavyPhaseStatus): string {
  switch (status) {
  case "passed":
    return "brightgreen";
  case "failed":
    return "red";
  default:
    return "lightgrey";
  }
}

async function writeHeavyOutputs(opts: {
  outputDir: string;
  networkName: string;
  overall: "success" | "failed";
  phases: HeavyPhaseResult[];
  summary: Record<string, unknown>;
}): Promise<void> {
  await mkdir(opts.outputDir, { recursive: true });

  const status = {
    timestamp: new Date().toISOString(),
    monitor: "monitor-heavy",
    network: opts.networkName,
    overall: opts.overall,
    summary: opts.summary,
    phases: opts.phases.map((p) => ({
      name: p.name,
      label: phaseLabel(p.name),
      status: p.status,
      durationMs: p.durationMs,
      error: p.error,
    })),
  };

  await writeFile(
    join(opts.outputDir, "monitor-heavy-status.json"),
    JSON.stringify(status, null, 2) + "\n",
  );

  const failed = opts.phases.some((p) => p.status === "failed");
  const passed = opts.phases.filter((p) => p.status === "passed").length;
  const total = opts.phases.length;
  const summaryBadge: BadgeEndpoint = {
    schemaVersion: 1,
    label: "Monitor Heavy",
    message: failed ? `failed (${passed}/${total} passed)` : `${passed}/${total} passed`,
    color: failed ? "red" : "brightgreen",
    cacheSeconds: 300,
  };
  await writeFile(
    join(opts.outputDir, "status.json"),
    JSON.stringify(summaryBadge, null, 2) + "\n",
  );
}

async function uploadWithRetry(opts: {
  mspClient: MspClient;
  bucketId: `0x${string}`;
  fileKey: `0x${string}`;
  blob: Blob;
  owner: `0x${string}`;
  location: string;
  reAuth: () => Promise<void>;
  retries?: number;
  delayMs?: number;
  maxTotalMs?: number;
  maxDelayMs?: number;
}) {
  const startedAt = Date.now();
  const maxTotalMs = opts.maxTotalMs ?? 8 * 60_000; // default: 8 minutes
  const maxDelayMs = opts.maxDelayMs ?? 60_000;

  // Back-compat: if callers pass retries/delayMs, interpret as a minimum retry budget.
  const minRetries = opts.retries ?? 5;
  const baseDelayMs = opts.delayMs ?? 10_000;

  let attempt = 0;
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (attempt >= minRetries && elapsed > maxTotalMs) {
      throw new Error("upload failed after retry window elapsed");
    }
    attempt += 1;

    try {
      return await opts.mspClient.files.uploadFile(
        opts.bucketId,
        opts.fileKey,
        opts.blob,
        opts.owner,
        opts.location,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      const shouldRetry =
        msg.includes("not expecting") ||
        msg.includes("HTTP 400") ||
        msg.includes("HTTP 403") ||
        msg.includes("HTTP 404") ||
        msg.includes("timeout") ||
        msg.includes("timed out");

      // If forbidden, refresh SIWE session and retry.
      if (msg.includes("HTTP 403")) {
        try {
          await opts.reAuth();
        } catch {
          // ignore
        }
      }

      if (shouldRetry) {
        const elapsedNow = Date.now() - startedAt;
        if (attempt >= minRetries && elapsedNow > maxTotalMs) {
          throw error;
        }
        // Simple exponential backoff with cap.
        const nextDelay = Math.min(
          maxDelayMs,
          Math.floor(baseDelayMs * Math.pow(1.5, attempt - 1)),
        );
        await sleep(nextDelay);
        continue;
      }

      throw error;
    }
  }
}

// ============================================================================
// Config (keep this small and centralized so it can scale to 100+ files later)
// ============================================================================
const HEAVY_CONFIG = {
  // Counts
  initialFileCount: 10,
  deleteFirstCount: 5,
  secondBatchCount: 5,

  // File sizes
  minFileSizeBytes: 100 * 1024, // 100kB
  maxFileSizeBytes: 1 * 1024 * 1024, // 1MB

  // Upload concurrency (HTTP)
  uploadConcurrency: 5,

  // Replication
  batch1Replicas: 1, // replicas=1
  // Default desired replicas for batch2. We will override to 1 on networks that
  // don't have enough BSPs (e.g. Stagenet).
  batch2Replicas: 2, // replicas=2 (may be overridden at runtime)

  // Waits/timeouts
  postStorageRequestBulkWaitMs: 10_000,
  // Ensure we don't try to upload "too soon" after issuing the on-chain storage request.
  // Stagenet can lag in backend indexing/authorization, leading to transient HTTP 403s.
  minIssueToUploadMs: 60_000,
  // Upload retry window (keep under typical SR upload expiry)
  uploadRetryMaxTotalMs: 8 * 60_000,
  uploadRetryBaseDelayMs: 10_000,
  uploadRetryMaxDelayMs: 60_000,
  deleteRetryDelaysMs: [30_000, 60_000, 90_000],
  storageRequestClearedTimeoutMs: 10 * 60_000, // 10 min per file
  bucketReadyPoll: { retries: 80, delayMs: 3_000 }, // 4 min
} as const;

type FileSpec = {
  name: string;
  location: string;
  bytes: Uint8Array;
  sizeBytes: number;
  fingerprintHex?: `0x${string}`;
  fileKeyHex?: `0x${string}`;
  storageRequestIssuedAtMs?: number;
};

function randomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createRandomFiles(prefix: string, count: number): FileSpec[] {
  const files: FileSpec[] = [];
  for (let i = 0; i < count; i++) {
    const sizeBytes = randomIntInclusive(
      HEAVY_CONFIG.minFileSizeBytes,
      HEAVY_CONFIG.maxFileSizeBytes,
    );
    const name = `${prefix}-${Date.now()}-${i}-${sizeBytes}.bin`;
    const bytes = generateRandomBytes(sizeBytes);
    files.push({
      name,
      location: name,
      bytes,
      sizeBytes,
    });
  }
  return files;
}

function flattenFileTree(
  files: FileTree[],
): Map<string, { status: string; name: string }> {
  const map = new Map<string, { status: string; name: string }>();
  const stack: FileTree[] = [...files];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "file") {
      map.set(node.fileKey.toLowerCase(), {
        status: node.status,
        name: node.name,
      });
    } else {
      stack.push(...node.children);
    }
  }
  return map;
}

async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
}

async function waitUntilFilesReadyViaTree(
  mspClient: MspClient,
  bucketId: `0x${string}`,
  fileKeys: `0x${string}`[],
  label: string,
): Promise<void> {
  console.log(
    `[monitor-heavy] Waiting for ${label} files to be ready via bucket getFiles...`,
  );
  await pollBackend(async () => {
    const resp = await mspClient.buckets.getFiles(bucketId);
    const map = flattenFileTree(resp.files);
    return fileKeys.every(
      (fk) => map.get(fk.toLowerCase())?.status === "ready",
    );
  }, HEAVY_CONFIG.bucketReadyPoll);
}

async function waitUntilFilesAbsentViaTree(
  mspClient: MspClient,
  bucketId: `0x${string}`,
  fileKeys: `0x${string}`[],
  label: string,
): Promise<void> {
  console.log(
    `[monitor-heavy] Waiting for ${label} files to disappear from bucket listing...`,
  );
  await pollBackend(async () => {
    const resp = await mspClient.buckets.getFiles(bucketId);
    const map = flattenFileTree(resp.files);
    return fileKeys.every((fk) => !map.has(fk.toLowerCase()));
  }, HEAVY_CONFIG.bucketReadyPoll);
}

async function runMonitorHeavy(): Promise<void> {
  const network = getNetworkConfig();
  const privateKey = getPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const outputDir = process.env.MONITOR_OUTPUT_DIR || "badges-heavy";

  console.log("=".repeat(80));
  console.log("[monitor-heavy] Monitor Heavy");
  console.log(`[monitor-heavy] Network: ${network.name}`);
  console.log(`[monitor-heavy] Account: ${account.address}`);
  console.log("=".repeat(80));

  // viem clients
  const walletClient = createWalletClient({
    account,
    transport: http(network.chain.evmRpcUrl),
  });
  const publicClient = createPublicClient({
    transport: http(network.chain.evmRpcUrl),
  });

  const chain = defineChain({
    id: network.chain.id,
    name: network.chain.name,
    nativeCurrency: { name: "Token", symbol: "TKN", decimals: 18 },
    rpcUrls: { default: { http: [network.chain.evmRpcUrl] } },
  });

  const storageHubClient = new StorageHubClient({
    rpcUrl: network.chain.evmRpcUrl,
    chain,
    walletClient,
    filesystemContractAddress:
      network.chain.filesystemPrecompileAddress ??
      SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
  });

  // MSP client + SIWE
  let currentSession: Readonly<Session> | undefined;
  const sessionProvider = async () => currentSession;
  const mspClient = await MspClient.connect(
    { baseUrl: network.msp.baseUrl, timeoutMs: network.msp.timeoutMs },
    sessionProvider,
  );
  async function reAuth(): Promise<void> {
    currentSession = Object.freeze(
      await mspClient.auth.SIWE(
        walletClient,
        network.msp.siweDomain,
        network.msp.siweUri,
      ),
    );
  }
  console.log("[monitor-heavy] Authenticating with MSP via SIWE...");
  await reAuth();

  // userApi (substrate) for on-chain polling
  const userApi = await createUserApi(network.chain.substrateWsUrl);

  const startedAt = Date.now();
  const phases: HeavyPhaseResult[] = [];
  let failed = false;
  let activePhase: { name: string; startedAt: number } | undefined;

  function beginPhase(name: HeavyPhaseResult["name"]) {
    activePhase = { name, startedAt: Date.now() };
  }

  function endPhasePassed() {
    if (!activePhase) return;
    phases.push({
      name: activePhase.name,
      status: "passed",
      durationMs: Date.now() - activePhase.startedAt,
    });
    activePhase = undefined;
  }

  try {
    await initWasm();

    // =====================================================================
    // 1) Create bucket (random name)
    // =====================================================================
    console.log("[monitor-heavy] Creating bucket...");
    beginPhase("bucket-create");
    const info = await mspClient.info.getInfo();
    const mspId = info.mspId as `0x${string}`;
    const peerId = extractPeerId(info.multiaddresses);

    const valueProps = await mspClient.info.getValuePropositions();
    if (!valueProps || valueProps.length === 0)
      throw new Error("No value propositions on MSP");
    const valuePropId = valueProps[0]!.id as `0x${string}`;

    const bucketName = `monitor-heavy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const bucketId = (await storageHubClient.deriveBucketId(
      account.address,
      bucketName,
    )) as `0x${string}`;
    const createBucketTx = await storageHubClient.createBucket(
      mspId,
      bucketName,
      false,
      valuePropId,
    );
    if (!createBucketTx) throw new Error("createBucket returned no tx hash");
    const createBucketRcpt = await publicClient.waitForTransactionReceipt({
      hash: createBucketTx,
    });
    if (createBucketRcpt.status !== "success")
      throw new Error("createBucket failed");

    console.log(
      `[monitor-heavy] ✓ Bucket created: ${bucketName} (${bucketId})`,
    );

    // Wait for backend indexing (bucket appears)
    await pollBackend(async () => {
      const buckets = await mspClient.buckets.listBuckets();
      return buckets.some((b) => b.bucketId === bucketId);
    }, HEAVY_CONFIG.bucketReadyPoll);

    // Some environments lag between listBuckets and allowing file operations.
    // Ensure the bucket is usable via getFiles before issuing uploads.
    await pollBackend(async () => {
      try {
        await mspClient.buckets.getFiles(bucketId);
        return true;
      } catch {
        return false;
      }
    }, HEAVY_CONFIG.bucketReadyPoll);
    endPhasePassed();

    // =====================================================================
    // Helpers for SR/Upload/Delete
    // =====================================================================
    const registry = new TypeRegistry();
    type OwnerT = Parameters<FileManager["computeFileKey"]>[0];
    type BucketT = Parameters<FileManager["computeFileKey"]>[1];
    const owner = registry.createType(
      "AccountId20",
      account.address,
    ) as unknown as OwnerT;
    const bucketIdH256 = registry.createType(
      "H256",
      bucketId,
    ) as unknown as BucketT;

    async function computeFingerprintAndKey(file: FileSpec): Promise<void> {
      const fm = new FileManager({
        size: file.bytes.length,
        stream: () =>
          Readable.toWeb(
            Readable.from(Buffer.from(file.bytes)),
          ) as ReadableStream<Uint8Array>,
      });
      const fp = await fm.getFingerprint();
      file.fingerprintHex = fp.toHex() as `0x${string}`;
      const key = await fm.computeFileKey(owner, bucketIdH256, file.location);
      file.fileKeyHex = key.toHex() as `0x${string}`;
    }

    async function issueStorageRequestSeq(
      files: FileSpec[],
      replicas: 1 | 2,
    ): Promise<void> {
      const replicationTarget =
        replicas === 1 ? ReplicationLevel.Basic : ReplicationLevel.Custom;
      const customReplicationTarget = replicas === 1 ? 0 : 2;

      console.log(
        `[monitor-heavy] Issuing ${files.length} storage requests sequentially (replicas=${replicas})...`,
      );
      for (const f of files) {
        if (!f.fingerprintHex || !f.fileKeyHex) {
          throw new Error(
            "File missing fingerprint/fileKey before issueStorageRequest",
          );
        }
        const tx = await storageHubClient.issueStorageRequest(
          bucketId,
          f.location,
          f.fingerprintHex,
          BigInt(f.bytes.length),
          mspId,
          peerId ? [peerId] : [],
          replicationTarget,
          customReplicationTarget,
        );
        if (!tx) throw new Error("issueStorageRequest returned no tx hash");
        const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
        if (rcpt.status !== "success")
          throw new Error("issueStorageRequest failed");
        f.storageRequestIssuedAtMs = Date.now();
        // small spacing like stress test to avoid transient RPC nonce/fee issues
        await sleep(500);
      }
    }

    async function uploadFilesParallel(files: FileSpec[]): Promise<void> {
      console.log(
        `[monitor-heavy] Uploading ${files.length} files (concurrency=${HEAVY_CONFIG.uploadConcurrency})...`,
      );
      await withConcurrency(
        files,
        HEAVY_CONFIG.uploadConcurrency,
        async (f) => {
          if (!f.fileKeyHex) throw new Error("Missing fileKey for upload");

          // Wait for MSP/backend to be ready to accept uploads for this SR.
          // We enforce a minimum age since SR issuance, plus the existing per-network delay.
          const issuedAt = f.storageRequestIssuedAtMs;
          const minWait = Math.max(
            network.delays.beforeUploadMs,
            HEAVY_CONFIG.minIssueToUploadMs,
          );
          if (issuedAt) {
            const age = Date.now() - issuedAt;
            if (age < minWait) await sleep(minWait - age);
          } else {
            await sleep(minWait);
          }

          // Fresh FileManager + Blob right before upload
          const fm = new FileManager({
            size: f.bytes.length,
            stream: () =>
              Readable.toWeb(
                Readable.from(Buffer.from(f.bytes)),
              ) as ReadableStream<Uint8Array>,
          });
          const blob = await fm.getFileBlob();
          const res = await uploadWithRetry({
            mspClient,
            bucketId,
            fileKey: f.fileKeyHex,
            blob,
            owner: account.address,
            location: f.location,
            reAuth,
            retries: 5,
            delayMs: HEAVY_CONFIG.uploadRetryBaseDelayMs,
            maxTotalMs: HEAVY_CONFIG.uploadRetryMaxTotalMs,
            maxDelayMs: HEAVY_CONFIG.uploadRetryMaxDelayMs,
          });
          if (res.status !== "upload_successful") {
            throw new Error(`upload failed: ${res.status}`);
          }
          if (res.fileKey !== f.fileKeyHex) {
            throw new Error("upload fileKey mismatch");
          }
        },
      );
    }

    async function waitReady(files: FileSpec[], label: string): Promise<void> {
      const fileKeys = files
        .map((f) => f.fileKeyHex!)
        .filter(Boolean) as `0x${string}`[];
      console.log(
        `[monitor-heavy] Waiting for ${label} files to be ready (chain + backend)...`,
      );

      // Chain: wait storage request cleared (fulfilled)
      await withConcurrency(
        fileKeys,
        HEAVY_CONFIG.uploadConcurrency,
        async (fk) => {
          await waitForStorageRequestCleared(
            userApi,
            fk,
            HEAVY_CONFIG.storageRequestClearedTimeoutMs,
            3_000,
          );
        },
      );

      // Backend: wait status ready in file tree
      await waitUntilFilesReadyViaTree(mspClient, bucketId, fileKeys, label);
    }

    async function deleteFilesWithRetry(
      files: FileSpec[],
      label: string,
    ): Promise<void> {
      const fileKeys = files
        .map((f) => f.fileKeyHex!)
        .filter(Boolean) as `0x${string}`[];
      let remaining = [...files];

      console.log(
        `[monitor-heavy] Deleting ${remaining.length} files (${label}) with retries...`,
      );

      for (
        let attempt = 1;
        attempt <= HEAVY_CONFIG.deleteRetryDelaysMs.length;
        attempt++
      ) {
        const failed: FileSpec[] = [];
        console.log(
          `[monitor-heavy] Delete attempt ${attempt}/${HEAVY_CONFIG.deleteRetryDelaysMs.length} (${remaining.length} files)...`,
        );

        for (const f of remaining) {
          try {
            // Prefer MSP fileInfo to populate required fields
            const fi = await mspClient.files.getFileInfo(
              bucketId,
              f.fileKeyHex!,
            );
            const core: CoreFileInfo = {
              fileKey: to0x(fi.fileKey),
              fingerprint: to0x(fi.fingerprint),
              bucketId: to0x(fi.bucketId),
              location: fi.location,
              size: BigInt(fi.size),
              blockHash: to0x(fi.blockHash),
              ...(fi.txHash ? { txHash: to0x(fi.txHash) } : {}),
            };

            const tx = await storageHubClient.requestDeleteFile(core);
            if (!tx) throw new Error("requestDeleteFile returned no tx hash");
            const rcpt = await publicClient.waitForTransactionReceipt({
              hash: tx,
            });
            if (rcpt.status !== "success")
              throw new Error("requestDeleteFile failed");
            await sleep(500);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // If storage request is still active, retry later
            if (msg.includes("FileHasActiveStorageRequest")) {
              failed.push(f);
            } else {
              // keep it as failed; we’ll retry, but log
              console.log(`[monitor-heavy] delete failed (${f.name}): ${msg}`);
              failed.push(f);
            }
          }
        }

        remaining = failed;
        if (remaining.length === 0) break;

        const delay = HEAVY_CONFIG.deleteRetryDelaysMs[attempt - 1]!;
        console.log(
          `[monitor-heavy] Waiting ${delay / 1000}s before retry (${remaining.length} remaining)...`,
        );
        await sleep(delay);
      }

      // Wait until backend removes them (tree absent) + chain cleared
      await withConcurrency(
        fileKeys,
        HEAVY_CONFIG.uploadConcurrency,
        async (fk) => {
          // If already deleted, this should return quickly.
          await waitForStorageRequestCleared(
            userApi,
            fk,
            HEAVY_CONFIG.storageRequestClearedTimeoutMs,
            3_000,
          );
        },
      );
      await waitUntilFilesAbsentViaTree(mspClient, bucketId, fileKeys, label);
    }

    // =====================================================================
    // 2) IssueStorageRequest for 10 random files (replicas=1)
    // =====================================================================
    const initialFiles = createRandomFiles(
      "heavy-a",
      HEAVY_CONFIG.initialFileCount,
    );
    console.log(
      `[monitor-heavy] Generated ${initialFiles.length} initial files`,
    );
    for (const f of initialFiles) await computeFingerprintAndKey(f);
    beginPhase("storage-request-batch1");
    await issueStorageRequestSeq(initialFiles, 1);
    endPhasePassed();

    // 3) Upload all files in parallel and wait until all ready
    await sleep(HEAVY_CONFIG.postStorageRequestBulkWaitMs);
    beginPhase("upload-batch1");
    await uploadFilesParallel(initialFiles);
    await waitReady(initialFiles, "batch1");
    endPhasePassed();

    // 4) Delete the first 5 files
    const firstFive = initialFiles.slice(0, HEAVY_CONFIG.deleteFirstCount);
    beginPhase("file-delete-first5");
    await deleteFilesWithRetry(firstFive, "first 5");
    endPhasePassed();

    // 5) Upload 5 new files with replicas=2 (note: Stagenet may not have enough BSPs)
    const newFiles = createRandomFiles(
      "heavy-b",
      HEAVY_CONFIG.secondBatchCount,
    );
    const batch2Replicas: 1 | 2 =
      network.chain.id === 55932 ? 1 : (HEAVY_CONFIG.batch2Replicas as 1 | 2);
    console.log(
      `[monitor-heavy] Generated ${newFiles.length} new files (replicas=${batch2Replicas})`,
    );
    for (const f of newFiles) await computeFingerprintAndKey(f);
    beginPhase("storage-request-batch2");
    await issueStorageRequestSeq(newFiles, batch2Replicas);
    endPhasePassed();

    // 6) Wait for them to be ready
    await sleep(HEAVY_CONFIG.postStorageRequestBulkWaitMs);
    beginPhase("upload-batch2");
    await uploadFilesParallel(newFiles);
    await waitReady(newFiles, "batch2");
    endPhasePassed();

    // 7) Delete all 10 files (5 remaining old + 5 new). Wait until all deleted.
    const remainingOld = initialFiles.slice(HEAVY_CONFIG.deleteFirstCount);
    const allToDelete = [...remainingOld, ...newFiles];
    beginPhase("file-delete-all10");
    await deleteFilesWithRetry(allToDelete, "all 10");
    endPhasePassed();

    // 8) Delete the bucket
    console.log("[monitor-heavy] Deleting bucket...");
    beginPhase("bucket-delete");
    const delBucketTx = await storageHubClient.deleteBucket(bucketId);
    if (!delBucketTx) throw new Error("deleteBucket returned no tx hash");
    const delBucketRcpt = await publicClient.waitForTransactionReceipt({
      hash: delBucketTx,
    });
    if (delBucketRcpt.status !== "success")
      throw new Error("deleteBucket failed");

    // Wait for backend to reflect removal from listing
    await pollBackend(async () => {
      const buckets = await mspClient.buckets.listBuckets();
      return !buckets.some((b) => b.bucketId === bucketId);
    }, HEAVY_CONFIG.bucketReadyPoll);
    endPhasePassed();

    console.log("[monitor-heavy] ✓ Completed successfully");
    process.exitCode = 0;
  } catch (err) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (activePhase) {
      phases.push({
        name: activePhase.name,
        status: "failed",
        durationMs: Date.now() - activePhase.startedAt,
        error: msg,
      });
      activePhase = undefined;
    }
    console.error("[monitor-heavy] ✗ Failed:", msg);
    process.exitCode = 1;
    throw err;
  } finally {
    const endedAt = Date.now();

    // Write status file for CI/Slack (always try, even on failures).
    try {
      const overall: "success" | "failed" = failed ? "failed" : "success";
      await writeHeavyOutputs({
        outputDir,
        networkName: network.name,
        overall,
        phases,
        summary: {
          durationMs: endedAt - startedAt,
          initialFileCount: HEAVY_CONFIG.initialFileCount,
          deleteFirstCount: HEAVY_CONFIG.deleteFirstCount,
          secondBatchCount: HEAVY_CONFIG.secondBatchCount,
          minFileSizeBytes: HEAVY_CONFIG.minFileSizeBytes,
          maxFileSizeBytes: HEAVY_CONFIG.maxFileSizeBytes,
          uploadConcurrency: HEAVY_CONFIG.uploadConcurrency,
          batch1Replicas: HEAVY_CONFIG.batch1Replicas,
          // replicate the runtime override logic so reports are accurate
          batch2Replicas:
            network.chain.id === 55932
              ? 1
              : (HEAVY_CONFIG.batch2Replicas as 1 | 2),
        },
      });
      console.log(
        `[monitor-heavy] Status written to ${join(outputDir, "monitor-heavy-status.json")}`,
      );
    } catch (e) {
      console.log(
        "[monitor-heavy] Failed to write status output:",
        e instanceof Error ? e.message : String(e),
      );
    }

    try {
      await userApi.disconnect();
    } catch {
      // ignore
    }
  }
}

if (import.meta.main) {
  runMonitorHeavy().catch((err) => {
    console.error("[monitor-heavy] ❌ Crashed:", err);
    // Non-zero exit, but also mark run as failed for status output.
    process.exit(1);
  });
}

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
  waitForFinalization,
  waitForOnChainData,
  waitForStorageRequestCleared,
} from "../monitor/utils/waits";
import {
  extractPeerId,
  generateRandomBytes,
  sleep,
  to0x,
} from "../util/helpers";
import { buildGasTxOpts } from "../util/evmTx";

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
      // High-signal log for diagnosing flaky backend behavior (403/404/timeouts/etc).
      // Keep it short to avoid flooding CI logs with giant SDK stack traces.
      console.log(
        `[monitor-heavy] upload retryable error (attempt ${attempt}): ${msg.slice(0, 180)}`,
      );

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
  uploadConcurrency: 3,

  // Replication
  batch1Replicas: 1, // replicas=1
  // Default desired replicas for batch2. We will override to 1 on networks that
  // don't have enough BSPs (e.g. Stagenet).
  batch2Replicas: 2, // replicas=2 (may be overridden at runtime)

  // Waits/timeouts
  postStorageRequestBulkWaitMs: 10_000,
  // Storage-request confirmation concurrency (receipts/finalization/on-chain visibility)
  srConfirmConcurrency: 3,
  // Spacing between SR submissions to reduce transient nonce/mempool issues
  srSubmitSpacingMs: 250,
  // Ensure we don't try to upload "too soon" after issuing the on-chain storage request.
  // Stagenet can lag in backend indexing/authorization, leading to transient HTTP 403s.
  minIssueToUploadMs: 60_000,
  // Upload retry window (keep under typical SR upload expiry)
  uploadRetryMaxTotalMs: 8 * 60_000,
  uploadRetryBaseDelayMs: 10_000,
  uploadRetryMaxDelayMs: 60_000,
  // On-chain visibility wait for storageRequests(fileKey) after issuing SR tx
  storageRequestVisibleTimeoutMs: 2 * 60_000,
  deleteRetryDelaysMs: [30_000, 60_000, 90_000],
  storageRequestClearedTimeoutMs: 10 * 60_000, // 10 min per file
  // Readiness polling cadence:
  // - We intentionally poll infrequently (every 30s) to reduce backend load and produce readable logs.
  // - Total wait budget is 11 minutes.
  readyPollIntervalMs: 30_000,
  readyPollTotalMs: 11 * 60_000,
  bucketReadyPoll: { retries: 220, delayMs: 3_000 }, // 11 min (used elsewhere)
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

  const deadline = Date.now() + HEAVY_CONFIG.readyPollTotalMs;
  const delayMs = HEAVY_CONFIG.readyPollIntervalMs;
  const lastStatus = new Map<string, string>(); // lower(fileKey) -> status
  const formatStatus = (s: string): string => {
    // Keep this stable/scan-friendly in CI output.
    if (s === "ready") return "Ready";
    if (s === "in_progress" || s === "inProgress") return "InProgress";
    if (s === "missing") return "Missing";
    return s;
  };

  let attempt = 0;
  while (true) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const resp = await mspClient.buckets.getFiles(bucketId);
      const map = flattenFileTree(resp.files);

      let readyCount = 0;
      for (const fk of fileKeys) {
        const key = fk.toLowerCase();
        const status = map.get(key)?.status ?? "missing";
        if (status === "ready") readyCount++;

        const prev = lastStatus.get(key);
        if (prev !== "ready" && status === "ready") {
          console.log(
            `[monitor-heavy] ${label} file became ready: ${fk}`,
          );
        }
        lastStatus.set(key, status);
      }

      // Print a full snapshot on EVERY poll (requested).
      console.log("=".repeat(80));
      console.log(
        `[monitor-heavy] ${label} readiness snapshot (ready ${readyCount}/${fileKeys.length}, remaining=${Math.max(
          0,
          Math.round(remainingMs / 1000),
        )}s):`,
      );
      fileKeys.forEach((fk, idx) => {
        const st = formatStatus(lastStatus.get(fk.toLowerCase()) ?? "unknown");
        console.log(`  ${idx + 1}) Filekey: ${fk} Status: ${st}`);
      });
      console.log("=".repeat(80));

      if (readyCount === fileKeys.length) return;
    } catch {
      // ignore transient backend errors and continue polling
    }

    await sleep(delayMs);
  }

  // Timeout: print which fileKeys never reached "ready"
  const missing = fileKeys.filter(
    (fk) => lastStatus.get(fk.toLowerCase()) !== "ready",
  );
  console.log(
    `[monitor-heavy] Timeout waiting for ${label} files to be ready. Missing (${missing.length}/${fileKeys.length}):`,
  );
  console.log(`[monitor-heavy] ${label} final status snapshot:`);
  fileKeys.forEach((fk, idx) => {
    const st = formatStatus(lastStatus.get(fk.toLowerCase()) ?? "unknown");
    console.log(`  ${idx + 1}) Filekey: ${fk} Status: ${st}`);
  });
  for (const fk of missing) {
    console.log(
      `  - ${fk} (lastStatus=${lastStatus.get(fk.toLowerCase()) ?? "unknown"})`,
    );
  }
  throw new Error(
    `Timeout waiting for ${label} files to be ready (missing ${missing.length}/${fileKeys.length})`,
  );
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
    const createBucketTx = await (storageHubClient as any).createBucket(
      mspId,
      bucketName,
      false,
      valuePropId,
      await buildGasTxOpts(publicClient),
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
      // Phase A: submit txs sequentially (nonce-safe), but don't wait for receipts here.
      const submitted: Array<{ idx: number; file: FileSpec; tx: `0x${string}` }> =
        [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        if (!f.fingerprintHex || !f.fileKeyHex) {
          throw new Error(
            "File missing fingerprint/fileKey before issueStorageRequest",
          );
        }

        const idx = i + 1;
        const size = f.bytes.length;
        console.log(
          `[monitor-heavy] [SR ${idx}/${files.length}] fileKey=${f.fileKeyHex} size=${size}B fingerprint=${f.fingerprintHex}`,
        );

        const srStart = Date.now();
        const tx = await (storageHubClient as any).issueStorageRequest(
          bucketId,
          f.location,
          f.fingerprintHex,
          BigInt(f.bytes.length),
          mspId,
          peerId ? [peerId] : [],
          replicationTarget,
          customReplicationTarget,
          await buildGasTxOpts(publicClient),
        );
        if (!tx) throw new Error("issueStorageRequest returned no tx hash");
        console.log(`[monitor-heavy] [SR ${idx}/${files.length}] tx sent: ${tx}`);
        submitted.push({ idx, file: f, tx: tx as `0x${string}` });

        // small spacing to reduce transient nonce/mempool issues, but keep it fast
        await sleep(HEAVY_CONFIG.srSubmitSpacingMs);

        // keep a bit of visibility while submitting
        console.log(
          `[monitor-heavy] [SR ${idx}/${files.length}] submitted (t=${Date.now() - srStart}ms)`,
        );
      }

      // Phase B: confirm receipts/finalization/on-chain visibility concurrently (bounded).
      console.log(
        `[monitor-heavy] Confirming ${submitted.length} storage requests (concurrency=${HEAVY_CONFIG.srConfirmConcurrency})...`,
      );
      await withConcurrency(
        submitted,
        HEAVY_CONFIG.srConfirmConcurrency,
        async (item) => {
          const { idx, file: f, tx } = item;
          const start = Date.now();
          const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
          if (rcpt.status !== "success") throw new Error("issueStorageRequest failed");

          // Mark SR issuance time once we know the tx landed.
          f.storageRequestIssuedAtMs = Date.now();

          // Wait until the block that included this tx is finalized (best-effort).
          try {
            await userApi.wait.finalizedAtLeast(BigInt(rcpt.blockNumber));
          } catch {
            // fallback to a generic finalized head bump
            await waitForFinalization(userApi);
          }

          await waitForOnChainData(
            () =>
              userApi.query.fileSystem.storageRequests(f.fileKeyHex as `0x${string}`),
            (sr) => !(sr as any).isNone,
            {
              retries: Math.ceil(HEAVY_CONFIG.storageRequestVisibleTimeoutMs / 5_000),
              delayMs: 5_000,
            },
          );

          console.log(
            `[monitor-heavy] [SR ${idx}/${files.length}] confirmed+visible (tx=${tx}) in ${Date.now() - start}ms`,
          );
        },
      );
    }

    async function uploadFilesParallel(
      files: FileSpec[],
      label: string,
    ): Promise<void> {
      console.log(
        `[monitor-heavy] Upload phase (${label}): uploading ${files.length} files (concurrency=${HEAVY_CONFIG.uploadConcurrency})...`,
      );

      const startedAt = Date.now();
      const fileCount = files.length;
      const status = new Map<string, "uploading" | "uploaded">(); // lower(fileKey) -> status
      const started = new Map<string, number>(); // lower(fileKey) -> ms
      let uploadedCount = 0;

      const interval = setInterval(() => {
        const uploadingCount = Array.from(status.values()).filter(
          (s) => s === "uploading",
        ).length;
        const pendingCount = fileCount - uploadedCount - uploadingCount;
        console.log(
          `[monitor-heavy] Upload phase (${label}) progress: uploaded ${uploadedCount}/${fileCount}, uploading ${uploadingCount}, pending ${pendingCount} (elapsed=${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s)`,
        );
      }, 30_000);

      try {
        await withConcurrency(
          files,
          HEAVY_CONFIG.uploadConcurrency,
          async (f, idx) => {
            if (!f.fileKeyHex) throw new Error("Missing fileKey for upload");
            const fk = f.fileKeyHex;
            const fkKey = fk.toLowerCase();
            status.set(fkKey, "uploading");
            started.set(fkKey, Date.now());
            console.log(
              `[monitor-heavy] Upload phase (${label}) start ${idx + 1}/${fileCount}: fileKey=${fk} size=${f.bytes.length}B`,
            );

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

            status.set(fkKey, "uploaded");
            uploadedCount += 1;
            const durMs = Date.now() - (started.get(fkKey) ?? Date.now());
            console.log(
              `[monitor-heavy] Upload phase (${label}) done ${idx + 1}/${fileCount}: fileKey=${fk} (${durMs}ms) uploaded ${uploadedCount}/${fileCount}`,
            );
          },
        );
      } finally {
        clearInterval(interval);
      }
    }

    async function waitReady(files: FileSpec[], label: string): Promise<void> {
      const fileKeys = files
        .map((f) => f.fileKeyHex!)
        .filter(Boolean) as `0x${string}`[];
      console.log(
        `[monitor-heavy] Waiting for ${label} files to be ready (chain + backend)...`,
      );

      // Chain: poll storageRequests(fileKey) once per 30s and print a full table each time.
      {
        const deadline = Date.now() + HEAVY_CONFIG.readyPollTotalMs;
        const delayMs = HEAVY_CONFIG.readyPollIntervalMs;
        const last = new Map<string, "Present" | "Cleared">();

        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;

          // Query all fileKeys with bounded concurrency
          await withConcurrency(
            fileKeys,
            HEAVY_CONFIG.uploadConcurrency,
            async (fk) => {
              const sr = await userApi.query.fileSystem.storageRequests(fk);
              last.set(fk.toLowerCase(), (sr as any).isNone ? "Cleared" : "Present");
            },
          );

          const clearedCount = fileKeys.filter(
            (fk) => last.get(fk.toLowerCase()) === "Cleared",
          ).length;

          console.log("=".repeat(80));
          console.log(
            `[monitor-heavy] ${label} chain snapshot (cleared ${clearedCount}/${fileKeys.length}, remaining=${Math.max(
              0,
              Math.round(remainingMs / 1000),
            )}s):`,
          );
          fileKeys.forEach((fk, idx) => {
            console.log(
              `  ${idx + 1}) Filekey: ${fk} Status: ${last.get(fk.toLowerCase()) ?? "Unknown"}`,
            );
          });
          console.log("=".repeat(80));

          if (clearedCount === fileKeys.length) break;
          await sleep(delayMs);
        }

        const clearedCount = fileKeys.filter(
          (fk) => last.get(fk.toLowerCase()) === "Cleared",
        ).length;
        if (clearedCount !== fileKeys.length) {
          throw new Error(
            `Timeout waiting for ${label} storageRequests to clear (cleared ${clearedCount}/${fileKeys.length})`,
          );
        }
      }

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

            const tx = await (storageHubClient as any).requestDeleteFile(
              core,
              await buildGasTxOpts(publicClient),
            );
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
    await uploadFilesParallel(initialFiles, "batch1");
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
    await uploadFilesParallel(newFiles, "batch2");
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
    const delBucketTx = await (storageHubClient as any).deleteBucket(
      bucketId,
      await buildGasTxOpts(publicClient),
    );
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

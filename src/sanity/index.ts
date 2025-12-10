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
import { FileManager } from "@storagehub-sdk/core";
import { createUserApi, type EnrichedUserApi } from "../userApi";

type Stage =
	| "connection"
	| "health"
	| "siwe"
	| "bucket"
	| "issue"
	| "upload"
	| "download"
	| "filedelete"
	| "bucketdelete";

type StageStatus = "passed" | "failed" | "skipped";

const SANITY_TARGETS = [
	"connection",
	"health",
	"siwe",
	"bucket",
	"issue",
	"upload",
	"download",
	"filedelete",
	"bucketdelete",
	"full",
] as const;

export type SanityTarget = (typeof SANITY_TARGETS)[number];

const STAGE_LABELS: Record<Stage, string> = {
	connection: "Connection",
	health: "Health",
	siwe: "SIWE",
	bucket: "Bucket Create",
	issue: "Issue Storage Request",
	upload: "Upload",
	download: "Download",
	filedelete: "File Deletion",
	bucketdelete: "Bucket Deletion",
};

function resolveTarget(): SanityTarget {
	const input = (
		process.env.SANITY_TARGET ??
		process.argv[2] ??
		"full"
	).toLowerCase();
	if (SANITY_TARGETS.includes(input as SanityTarget)) {
		return input as SanityTarget;
	}
	console.warn(
		`[sanity] Unknown SANITY_TARGET "${input}", defaulting to "full".`,
	);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForFileExpected(
	mspClient: ReturnType<typeof assertPresent>,
	fileKey: `0x${string}`,
	{
		retries = 24, // ~2 minutes at 5s intervals
		delayMs = 5000,
	}: { retries?: number; delayMs?: number } = {},
): Promise<boolean> {
	for (let attempt = 0; attempt < retries; attempt += 1) {
		// Fallback: no backend signal; just wait.
		await sleep(delayMs);
	}
	return false;
}

async function waitForFileInfo(
	mspClient: ReturnType<typeof assertPresent>,
	bucketId: string,
	fileKey: `0x${string}`,
	{ retries = 20, delayMs = 3000 }: { retries?: number; delayMs?: number } = {},
): Promise<boolean> {
	for (let i = 0; i < retries; i += 1) {
		try {
			const info = await (
				mspClient as unknown as {
					files: { getFileInfo: (b: string, f: string) => Promise<any> };
				}
			).files.getFileInfo(bucketId, fileKey);
			if (info?.fileKey) return true;
		} catch {
			// ignore and retry
		}
		await sleep(delayMs);
	}
	return false;
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
	await writeFile(
		statusFilePath,
		`${JSON.stringify(payload, null, 2)}\n`,
		"utf8",
	);
}

export async function runSanitySuite(
	target: SanityTarget = "full",
): Promise<void> {
	// Create network config + viem clients.
	const network = getNetworkConfigFromEnv();
	const viem = createViemClients(network);

	// Session provider is passed in so that connection/auth tests do not own how
	// sessions are persisted. We use a simple in-memory implementation for now.
	let currentSession: Session | undefined;
	const sessionProvider: SessionProvider = async () => currentSession;

	let storageHubClient:
		| Awaited<ReturnType<typeof runConnectionCheck>>[0]
		| undefined;
	let mspClient: Awaited<ReturnType<typeof runConnectionCheck>>[1] | undefined;
	let bucketName: string | undefined;
	let bucketId: string | undefined;
	let adolphusFileKey: `0x${string}` | undefined;
	let randomFileKey: `0x${string}` | undefined;
	let adolphusFileBlob: Blob | undefined;
	let randomFileBlob: Blob | undefined;
	let adolphusLocation: string | undefined;
	let mspIdForUploads: `0x${string}` | undefined;
	let adolphusFingerprint: `0x${string}` | undefined;
	let adolphusSize: bigint | undefined;
	let userApi: EnrichedUserApi | undefined;
	let issueCompleted = false;
	let uploadCompleted = false;

	async function waitForStorageRequestIndexed(
		api: EnrichedUserApi,
		fileKey: `0x${string}`,
		{
			retries = 20,
			delayMs = 3000,
		}: { retries?: number; delayMs?: number } = {},
	): Promise<void> {
		for (let i = 0; i < retries; i += 1) {
			try {
				const storageReq = await (
					api.query as any
				)?.fileSystem?.storageRequests?.(fileKey);
				if (storageReq && storageReq.isSome && storageReq.isSome?.()) {
					return;
				}
			} catch {
				// ignore and retry
			}
			await sleep(delayMs);
		}
		throw new Error("Storage request not visible on chain after waiting.");
	}

	const stageStatuses: Record<Stage, StageStatus> = {
		connection: "skipped",
		health: "skipped",
		siwe: "skipped",
		bucket: "skipped",
		issue: "skipped",
		upload: "skipped",
		download: "skipped",
		filedelete: "skipped",
		bucketdelete: "skipped",
	};
	const statusFile = process.env.SANITY_STATUS_FILE ?? "sanity-status.json";

	async function runStage(
		stage: Stage,
		fn: () => Promise<void>,
	): Promise<void> {
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
			if (adolphusFileKey && uploadCompleted) {
				await runFileDeletionCheck(
					storageHubClient,
					mspClient,
					viem,
					bucketId,
					adolphusFileKey,
				);
			}
		} catch (error) {
			console.warn(
				`[sanity] Cleanup (${label}) failed while deleting adolphus.jpg:`,
				error,
			);
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
			console.warn(
				`[sanity] Cleanup (${label}) failed while deleting bucket:`,
				error,
			);
		}
	}

	try {
		console.log(`[sanity] Running Testnet Sentinel with target="${target}"…`);

		// Optional chain API for waits; skip if no endpoint.
		const wsEndpoint = network.chain.substrateRpcWsUrl;
		if (wsEndpoint) {
			try {
				userApi = await createUserApi(wsEndpoint as `wss://${string}`);
				console.log(`[sanity] Connected userApi at ${wsEndpoint}`);
			} catch (err) {
				console.warn(
					"[sanity] userApi unavailable; chain-based waits will be skipped:",
					err,
				);
			}
		}

		await runStage("connection", async () => {
			// Ensure we can connect to StorageHub and MSP backends.
			console.log("[sanity] Running connection check…");
			[storageHubClient, mspClient] = await runConnectionCheck(
				network,
				viem,
				sessionProvider,
			);
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

		await runStage("bucket", async () => {
			console.log("[sanity] Running bucket creation check…");
			const sh = assertPresent(storageHubClient, "storageHubClient");
			const msp = assertPresent(mspClient, "mspClient");
			[bucketName, bucketId] = await runBucketCreationCheck(sh, msp, viem);
			logSectionSeparator("Bucket");
		});

		if (shouldStopAt(target, "bucket")) {
			return;
		}

		await runStage("issue", async () => {
			const sh = assertPresent(storageHubClient, "storageHubClient");
			const msp = assertPresent(mspClient, "mspClient");
			const info = await msp.info.getInfo();
			mspIdForUploads = info.mspId as `0x${string}`;
			const valueProps = await msp.info.getValuePropositions();
			if (!Array.isArray(valueProps) || valueProps.length === 0) {
				throw new Error(
					"No value propositions available to determine valueProp ID.",
				);
			}
			const selectedVp = valueProps[0];

			console.log("[sanity] Running adolphus.jpg storage request…");
			const adolphusBlob = await loadLocalFileBlob(
				"../../resources/adolphus.jpg",
				"image/jpeg",
			);
			adolphusLocation = generateFileLocation("adolphus.jpg");
			const fileMgr = new FileManager({
				size: adolphusBlob.size,
				stream: () => adolphusBlob.stream(),
			});
			const fingerprintResult = await fileMgr.getFingerprint();
			adolphusFingerprint =
				`0x${fingerprintResult.toString()}` as `0x${string}`;
			adolphusSize = BigInt(fileMgr.getFileSize());
			const adolphusResult = await runIssueStorageRequest(
				sh,
				viem,
				assertPresent(bucketId, "bucketId"),
				adolphusBlob,
				adolphusLocation,
				mspIdForUploads,
				network.defaults.replicationLevel,
				network.defaults.replicas,
			);
			adolphusFileKey = adolphusResult.fileKey;
			adolphusFileBlob = adolphusResult.fileBlob;
			logSectionSeparator("Adolphus IssueStorageRequest");

			// If chain API is available, wait for a finalized head to reduce races.
			if (userApi) {
				try {
					const currentHeader = await userApi.rpc.chain.getHeader();
					const target = currentHeader.number.toBigInt() + 1n;
					await userApi.wait.finalizedAtLeast(target);
					await waitForStorageRequestIndexed(
						userApi,
						assertPresent(adolphusFileKey, "adolphusFileKey"),
					);
				} catch (err) {
					console.warn(
						"[sanity] Skipping chain wait after issueStorageRequest:",
						err,
					);
				}
			} else {
				// Fallback: short backoff to give MSP/indexer time.
				await sleep(5000);
			}
			issueCompleted = true;
		});

		if (shouldStopAt(target, "issue")) {
			await cleanup("issue");
			return;
		}

		await runStage("upload", async () => {
			const sh = assertPresent(storageHubClient, "storageHubClient");
			const msp = assertPresent(mspClient, "mspClient");
			const ready = await waitForFileExpected(
				msp,
				assertPresent(adolphusFileKey, "adolphusFileKey"),
			);
			if (!ready) {
				throw new Error(
					"MSP did not mark fileKey as expected before upload; aborting upload.",
				);
			}
			await runFileUploadCheck(
				msp,
				assertPresent(bucketId, "bucketId"),
				viem.account.address,
				assertPresent(adolphusFileBlob, "adolphusFileBlob"),
				assertPresent(adolphusLocation, "adolphusLocation"),
				assertPresent(adolphusFileKey, "adolphusFileKey"),
			);
			const indexed = await waitForFileInfo(
				msp,
				assertPresent(bucketId, "bucketId"),
				assertPresent(adolphusFileKey, "adolphusFileKey"),
			);
			if (!indexed) {
				throw new Error("MSP did not index uploaded file within the timeout.");
			}
			logSectionSeparator("Adolphus Upload");
			uploadCompleted = true;
		});

		if (shouldStopAt(target, "upload")) {
			await cleanup("upload");
			return;
		}

		await runStage("download", async () => {
			const msp = assertPresent(mspClient, "mspClient");
			if (!uploadCompleted) {
				throw new Error("Skipping download because upload did not complete.");
			}
			await runFileDownloadCheck(
				msp,
				assertPresent(adolphusFileKey, "adolphusFileKey"),
				assertPresent(adolphusFileBlob, "adolphusFileBlob"),
			);
			logSectionSeparator("Adolphus Download");
		});

		if (shouldStopAt(target, "download")) {
			await cleanup("download");
			return;
		}

		await runStage("filedelete", async () => {
			const sh = assertPresent(storageHubClient, "storageHubClient");
			const msp = assertPresent(mspClient, "mspClient");
			if (!uploadCompleted) {
				throw new Error(
					"Skipping file deletion because upload did not complete.",
				);
			}
			await runFileDeletionCheck(
				sh,
				msp,
				viem,
				assertPresent(bucketId, "bucketId"),
				assertPresent(adolphusFileKey, "adolphusFileKey"),
			);
			logSectionSeparator("Adolphus Deletion");
		});

		if (shouldStopAt(target, "filedelete")) {
			await cleanup("filedelete");
			return;
		}

		await runStage("bucketdelete", async () => {
			const sh = assertPresent(storageHubClient, "storageHubClient");
			const msp = assertPresent(mspClient, "mspClient");
			if (!issueCompleted) {
				throw new Error(
					"Skipping bucket deletion because issueStorageRequest did not complete.",
				);
			}
			await runBucketDeletionCheck(
				sh,
				msp,
				viem,
				assertPresent(bucketName, "bucketName"),
				assertPresent(bucketId, "bucketId"),
			);
			logSectionSeparator("Bucket Deletion");
		});

		if (shouldStopAt(target, "bucketdelete")) {
			return;
		}
	} catch (error) {
		console.error("[sanity] Sanity suite failed:", error);
		await cleanup("failure");
		process.exitCode = 1;
	} finally {
		try {
			if (userApi) {
				await userApi.disconnect();
			}
		} catch (err) {
			console.warn("[sanity] Failed to disconnect userApi:", err);
		}
		try {
			await writeStatusFile(statusFile, stageStatuses);
		} catch (writeError) {
			console.error("[sanity] Failed to write status file:", writeError);
		}
	}
}

void runSanitySuite(resolveTarget());

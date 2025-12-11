// storagehub-stagenet-demo.ts
import "@storagehub/api-augment";

import { TypeRegistry } from "@polkadot/types";
import {
	type FileManager,
	ReplicationLevel,
	SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	StorageHubClient,
	initWasm,
	type FileInfo as CoreFileInfo,
} from "@storagehub-sdk/core";
import { FileManager as FM } from "@storagehub-sdk/core";
import type { Session, FileTree } from "@storagehub-sdk/msp-client";
import { MspClient } from "@storagehub-sdk/msp-client";
import { createReadStream, createWriteStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createUserApi, type EnrichedUserApi } from "../src/userApi";

async function main() {
	// Hardcoded config (stagenet)
	const ALITH_PRIVATE_KEY =
		"0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133";
	const STAGENET = {
		chainId: 55932,
		rpcUrl: "https://services.datahaven-dev.network/stagenet",
		wsUrl: "wss://services.datahaven-dev.network/stagenet" as `wss://${string}`,
		mspUrl: "https://deo-dh-backend.stagenet.datahaven-infra.network",
		fsPrecompile: "0x0000000000000000000000000000000000000404" as `0x${string}`,
		siweDomain: "deo-dh-backend.stagenet.datahaven-infra.network",
		siweUri: "https://deo-dh-backend.stagenet.datahaven-infra.network",
		delays: {
			postStorageRequestMs: 10_000,
			beforeUploadMs: 15_000,
			beforeDeleteBucketMs: 5_000,
		},
	};

	// Minimal helpers
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const extractPeerId = (multiaddresses: string[]): string | undefined => {
		for (const ma of multiaddresses) {
			const idx = ma.lastIndexOf("/p2p/");
			if (idx !== -1) return ma.slice(idx + 5);
		}
		return undefined;
	};

	// Define chain for viem
	const storageHubStagenet = defineChain({
		id: STAGENET.chainId,
		name: "DataHaven Stagenet",
		network: "storagehub-stagenet",
		nativeCurrency: { name: "Stage", symbol: "STAGE", decimals: 18 },
		rpcUrls: {
			default: { http: [STAGENET.rpcUrl] },
			public: { http: [STAGENET.rpcUrl] },
		},
	});

	// Wallet + clients
	const account = privateKeyToAccount(ALITH_PRIVATE_KEY);
	const walletClient = createWalletClient({
		account,
		chain: storageHubStagenet,
		transport: http(STAGENET.rpcUrl),
	});
	const publicClient = createPublicClient({
		chain: storageHubStagenet,
		transport: http(STAGENET.rpcUrl),
	});

	// MSP client + SIWE
	let currentSession: Readonly<Session> | undefined;
	const sessionProvider = async () => currentSession;
	const mspClient = await MspClient.connect(
		{ baseUrl: STAGENET.mspUrl, timeoutMs: 30_000 },
		sessionProvider,
	);
	const siweSession = await mspClient.auth.SIWE(
		walletClient,
		STAGENET.siweDomain,
		STAGENET.siweUri,
	);
	currentSession = Object.freeze(siweSession);
	await mspClient.auth.getProfile(); // sanity check

	// StorageHub client
	const storageHubClient = new StorageHubClient({
		rpcUrl: STAGENET.rpcUrl,
		chain: storageHubStagenet,
		walletClient,
		filesystemContractAddress:
			STAGENET.fsPrecompile ?? SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	});
	// Substrate user API for chain events
	const userApi = await createUserApi(STAGENET.wsUrl);

	// Discover MSP IDs/value props
	const info = await mspClient.info.getInfo();
	const mspId = info.mspId as `0x${string}`;
	const vp = await mspClient.info.getValuePropositions();
	if (vp.length === 0)
		throw new Error("No value propositions available on MSP");
	const valuePropId = vp[0].id as `0x${string}`;

	// Create bucket (derive ID first for later)
	const bucketName = `demo-bucket-${Date.now()}`;
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

	console.log(`✓ Bucket created: ${bucketId}`);

	// Prepare the adolphus image
	const FILE_PATH = "./resources/adolphus.jpg";
	const LOCATION = "adolphus.jpg";
	if (!existsSync(FILE_PATH)) throw new Error(`File not found: ${FILE_PATH}`);
	const fileSize = statSync(FILE_PATH).size;
	if (fileSize <= 0) throw new Error("File is empty");

	// Init WASM + FileManager
	await initWasm();
	const fm = new FM({
		size: fileSize,
		stream: () =>
			Readable.toWeb(createReadStream(FILE_PATH)) as ReadableStream<Uint8Array>,
	});

	// Fingerprint + typed params for fileKey
	const fingerprint = await fm.getFingerprint();
	const registry = new TypeRegistry();
	type FileManagerOwner = Parameters<FileManager["computeFileKey"]>[0];
	type FileManagerBucket = Parameters<FileManager["computeFileKey"]>[1];
	const owner = registry.createType(
		"AccountId20",
		account.address,
	) as unknown as FileManagerOwner;
	const bucketIdH256 = registry.createType(
		"H256",
		bucketId,
	) as unknown as FileManagerBucket;

	// Precompute once (not strictly required but mirrors demo flow)
	await fm.computeFileKey(owner, bucketIdH256, LOCATION);

	// Issue storage request (then wait)
	const peerId = extractPeerId(info.multiaddresses);
	const storageReqTx = await storageHubClient.issueStorageRequest(
		bucketId,
		LOCATION,
		fingerprint.toHex() as `0x${string}`,
		BigInt(fileSize),
		mspId,
		peerId ? [peerId] : [],
		ReplicationLevel.Basic,
		0,
	);
	if (!storageReqTx) throw new Error("issueStorageRequest returned no tx hash");
	const storageReqRcpt = await publicClient.waitForTransactionReceipt({
		hash: storageReqTx,
	});
	if (storageReqRcpt.status !== "success")
		throw new Error("issueStorageRequest failed");

	console.log("✓ Storage request issued");

	await sleep(STAGENET.delays.postStorageRequestMs);

	// Recompute final file key after SR
	const finalFileKey = await fm.computeFileKey(owner, bucketIdH256, LOCATION);

	console.log(`✓ File key: ${finalFileKey.toHex()}`);

	// Upload (wait a bit so MSP registers the expectation)
	await sleep(STAGENET.delays.beforeUploadMs);
	const blob = await fm.getFileBlob();
	const uploadReceipt = await mspClient.files.uploadFile(
		bucketId,
		finalFileKey.toHex(),
		blob,
		account.address,
		LOCATION,
	);

	console.log("✓ Upload receipt:", uploadReceipt);

	// Listen for on-chain fulfillment before continuing
	console.log("[demo] Listening for StorageRequestFulfilled on-chain...");
	const fulfilledBlock = await waitForStorageRequestFulfilled(
		userApi,
		finalFileKey.toHex(),
	);
	console.log(`[demo] StorageRequestFulfilled seen in block ${fulfilledBlock}`);

	// Download and save
	const download = await mspClient.files.downloadFile(finalFileKey.toHex());
	if (download.status !== 200)
		throw new Error(`Download failed with status ${download.status}`);

	const out = createWriteStream("./downloaded-adolphus.jpg");
	const nodeReadable = Readable.fromWeb(
		download.stream as unknown as WebReadableStream<Uint8Array>,
	);
	await new Promise<void>((resolve, reject) => {
		nodeReadable
			.pipe(out)
			.on("finish", () => resolve())
			.on("error", (e) => reject(e));
	});

	console.log("✓ Downloaded to ./downloaded-adolphus.jpg");

	// === Delete file ===
	const to0x = (hex: string): `0x${string}` =>
		(hex.startsWith("0x") ? hex : `0x${hex}`) as `0x${string}`;

	const fileInfo = await mspClient.files.getFileInfo(
		bucketId,
		finalFileKey.toHex(),
	);
	const coreInfo: CoreFileInfo = {
		fileKey: to0x(fileInfo.fileKey),
		fingerprint: to0x(fileInfo.fingerprint),
		bucketId: to0x(fileInfo.bucketId),
		location: fileInfo.location,
		size: BigInt(fileInfo.size),
		blockHash: to0x(fileInfo.blockHash),
		...(fileInfo.txHash ? { txHash: to0x(fileInfo.txHash) } : {}),
	};

	const delTx = await storageHubClient.requestDeleteFile(coreInfo);
	const delRcpt = await publicClient.waitForTransactionReceipt({ hash: delTx });
	if (delRcpt.status !== "success") throw new Error("requestDeleteFile failed");

	console.log("✓ File deletion requested");

	// Wait for on-chain FileDeletionRequested event and a couple of finalized blocks
	console.log("[demo] Waiting for FileDeletionRequested on-chain...");
	const { blockHash: deletionBlock } = await userApi.wait.forFinalizedEvent(
		"fileSystem",
		"FileDeletionRequested",
	);
	console.log(`[demo] FileDeletionRequested seen in block ${deletionBlock}`);

	// Give the network a bit of time (no indexer/MSP hooks available here)
	const currentHdr = await userApi.rpc.chain.getHeader();
	await userApi.wait.finalizedAtLeast(currentHdr.number.toBigInt() + 2n);
	await sleep(10_000);

	// Wait for file to be removed from bucket
	const isFilePresent = async (
		bid: string,
		key: `0x${string}`,
	): Promise<boolean> => {
		const resp = await mspClient.buckets.getFiles(bid);
		const stack: FileTree[] = [...resp.files];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.type === "file") {
				if (node.fileKey === key) return true;
			} else {
				stack.push(...node.children);
			}
		}
		return false;
	};

	const maxWaitMs = 120_000;
	const stepMs = 1_000;
	let waited = 0;
	while (await isFilePresent(bucketId, finalFileKey.toHex())) {
		if (waited >= maxWaitMs)
			throw new Error("File not removed from bucket in time");
		await sleep(stepMs);
		waited += stepMs;
	}

	console.log("✓ File removed from bucket");

	// === Delete bucket ===
	await sleep(STAGENET.delays.beforeDeleteBucketMs);

	const delBucketTx = await storageHubClient.deleteBucket(
		bucketId as `0x${string}`,
	);
	if (!delBucketTx) throw new Error("deleteBucket did not return tx hash");

	const delBucketRcpt = await publicClient.waitForTransactionReceipt({
		hash: delBucketTx,
	});
	if (delBucketRcpt.status !== "success")
		throw new Error("deleteBucket failed");

	// Wait for a couple of finalized blocks and a brief delay
	const hdrAfterDelete = await userApi.rpc.chain.getHeader();
	await userApi.wait.finalizedAtLeast(hdrAfterDelete.number.toBigInt() + 2n);
	await sleep(10_000);

	// Verify bucket removed on-chain
	const bucketAfterDeletion = await userApi.query.providers.buckets(bucketId);
	if ((bucketAfterDeletion as any).isSome) {
		throw new Error("Bucket still exists on-chain after deletion");
	}

	console.log("✓ Bucket deleted");
	console.log("\n🎉 Demo completed successfully (with cleanup)!");

	// Close connections so the process can exit cleanly
	await userApi.disconnect();
	console.log("[demo] Connections closed");
}

main().catch((err) => {
	console.error("❌ Demo failed:", err);
	process.exitCode = 1;
});

// Wait for StorageRequestFulfilled event for this fileKey
async function waitForStorageRequestFulfilled(
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
		// if the event does not match our fileKey, continue listening within the remaining window
	}
}

// storagehub-stagenet-end2end.ts
// Simple end-to-end flow: bucket create -> storage request -> upload -> download -> delete file -> delete bucket

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
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
	// Hardcoded config (stagenet)
	const ALITH_PRIVATE_KEY =
		"0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133";
	const STAGENET = {
		chainId: 55932,
		rpcUrl: "https://services.datahaven-dev.network/stagenet",
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

	const sleep = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	const extractPeerId = (multiaddresses: string[]): string | undefined => {
		for (const ma of multiaddresses) {
			const idx = ma.lastIndexOf("/p2p/");
			if (idx !== -1) return ma.slice(idx + 5);
		}
		return undefined;
	};

	// Chain config
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
	await mspClient.auth.getProfile();

	// StorageHub client
	const storageHubClient = new StorageHubClient({
		rpcUrl: STAGENET.rpcUrl,
		chain: storageHubStagenet,
		walletClient,
		filesystemContractAddress:
			STAGENET.fsPrecompile ?? SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	});

	// MSP info/value prop
	const info = await mspClient.info.getInfo();
	const mspId = info.mspId as `0x${string}`;
	const valueProps = await mspClient.info.getValuePropositions();
	if (valueProps.length === 0) throw new Error("No value propositions");
	const valuePropId = valueProps[0].id as `0x${string}`;

	// Create bucket
	const bucketName = `demo-bucket-${Date.now()}`;
	const bucketId = (await storageHubClient.deriveBucketId(
		account.address,
		bucketName,
	)) as `0x${string}`;
	const createTx = await storageHubClient.createBucket(
		mspId,
		bucketName,
		false,
		valuePropId,
	);
	const createRcpt = await publicClient.waitForTransactionReceipt({
		hash: createTx,
	});
	if (createRcpt.status !== "success") throw new Error("createBucket failed");

	console.log(`✓ Bucket created: ${bucketId}`);

	// Prepare file (use bundled adolphus image)
	const FILE_PATH = "./resources/adolphus.jpg";
	const LOCATION = "adolphus.jpg";
	if (!existsSync(FILE_PATH)) throw new Error(`File not found: ${FILE_PATH}`);
	const fileSize = statSync(FILE_PATH).size;
	if (fileSize <= 0) throw new Error("File is empty");

	// Compute fingerprint/fileKey
	await initWasm();
	const fm = new FM({
		size: fileSize,
		stream: () =>
			Readable.toWeb(createReadStream(FILE_PATH)) as ReadableStream<Uint8Array>,
	});
	const fingerprint = await fm.getFingerprint();
	const registry = new TypeRegistry();
	type FMOwner = Parameters<FileManager["computeFileKey"]>[0];
	type FMBucket = Parameters<FileManager["computeFileKey"]>[1];
	const owner = registry.createType(
		"AccountId20",
		account.address,
	) as unknown as FMOwner;
	const bucketIdH256 = registry.createType(
		"H256",
		bucketId,
	) as unknown as FMBucket;

	// Precompute once (optional)
	await fm.computeFileKey(owner, bucketIdH256, LOCATION);

	// Issue storage request
	const peerId = extractPeerId(info.multiaddresses);
	const srTx = await storageHubClient.issueStorageRequest(
		bucketId as `0x${string}`,
		LOCATION,
		fingerprint.toHex() as `0x${string}`,
		BigInt(fileSize),
		mspId,
		peerId ? [peerId] : [],
		ReplicationLevel.Basic,
		0,
	);
	const srRcpt = await publicClient.waitForTransactionReceipt({ hash: srTx });
	if (srRcpt.status !== "success")
		throw new Error("issueStorageRequest failed");

	console.log("✓ Storage request issued");
	await sleep(STAGENET.delays.postStorageRequestMs);

	// Final file key + upload
	const finalFileKey = await fm.computeFileKey(owner, bucketIdH256, LOCATION);
	await sleep(STAGENET.delays.beforeUploadMs);
	const blob = await fm.getFileBlob();
	const uploadReceipt = await mspClient.files.uploadFile(
		bucketId,
		finalFileKey.toHex(),
		blob,
		account.address,
		LOCATION,
	);
	console.log("✓ Uploaded:", uploadReceipt);

	// Download
	const download = await mspClient.files.downloadFile(finalFileKey.toHex());
	if (download.status !== 200)
		throw new Error(`Download failed with status ${download.status}`);

	const out = createWriteStream("./downloaded-adolphus.jpg");
	const nodeReadable = Readable.fromWeb(
		download.stream as unknown as ReadableStream,
	);
	await new Promise<void>((resolve, reject) => {
		nodeReadable
			.pipe(out)
			.on("finish", () => resolve())
			.on("error", (e) => reject(e));
	});
	console.log("✓ Downloaded to ./downloaded-adolphus.jpg");

	// Delete file
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

	// Wait for file to disappear
	const isFilePresent = async (
		bid: string,
		key: `0x${string}`,
	): Promise<boolean> => {
		const resp = await mspClient.buckets.getFiles(bid, { path: "/" });
		const stack: FileTree[] = [...resp.files];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.type === "file" && node.fileKey === key) return true;
			if (node.type === "folder" && Array.isArray(node.children)) {
				stack.push(...node.children);
			}
		}
		return false;
	};

	const maxWaitMs = 30_000;
	const stepMs = 1_000;
	let waited = 0;
	while (await isFilePresent(bucketId, finalFileKey.toHex())) {
		if (waited >= maxWaitMs)
			throw new Error("File not removed from bucket in time");
		await sleep(stepMs);
		waited += stepMs;
	}
	console.log("✓ File removed from bucket");

	// Delete bucket
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

	console.log("✓ Bucket deleted");
	console.log("\n🎉 End-to-end flow completed successfully!");
}

main().catch((err) => {
	console.error("❌ End-to-end flow failed:", err);
	process.exitCode = 1;
});

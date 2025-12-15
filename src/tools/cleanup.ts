// Cleanup tool: list buckets/files and optionally trigger on-chain deletions.
//
// Usage examples:
//   bun run cleanup --mode=list
//   bun run cleanup --mode=delete-files --execute
//   bun run cleanup --mode=delete-buckets --execute
//   bun run cleanup --mode=delete-buckets --execute --with-files
//
// Env:
//   ACCOUNT_PRIVATE_KEY=0x...
//   DATAHAVEN_NETWORK=stagenet|testnet

import { TypeRegistry } from "@polkadot/types";
import {
	SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	StorageHubClient,
	type FileInfo as CoreFileInfo,
} from "@storagehub-sdk/core";
import { MspClient } from "@storagehub-sdk/msp-client";
import type { FileTree, Session } from "@storagehub-sdk/msp-client";
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getNetworkConfig, getPrivateKey } from "../monitor/config";
import { sleep, to0x } from "../util/helpers";

type Mode = "list" | "delete-files" | "delete-buckets";

type Args = {
	mode: Mode;
	execute: boolean;
	withFiles: boolean;
	bucketName?: string;
	bucketId?: `0x${string}`;
	limitBuckets?: number;
	limitFiles?: number;
	help?: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		mode: "list",
		execute: false,
		withFiles: false,
	};

	for (const raw of argv) {
		if (raw === "--help" || raw === "-h") args.help = true;
		else if (raw.startsWith("--mode="))
			args.mode = raw.slice("--mode=".length) as Mode;
		else if (raw === "--execute") args.execute = true;
		else if (raw === "--with-files") args.withFiles = true;
		else if (raw.startsWith("--bucket-name="))
			args.bucketName = raw.slice("--bucket-name=".length);
		else if (raw.startsWith("--bucket-id="))
			args.bucketId = to0x(raw.slice("--bucket-id=".length)) as `0x${string}`;
		else if (raw.startsWith("--limit-buckets="))
			args.limitBuckets = Number(raw.slice("--limit-buckets=".length));
		else if (raw.startsWith("--limit-files="))
			args.limitFiles = Number(raw.slice("--limit-files=".length));
	}

	if (!["list", "delete-files", "delete-buckets"].includes(args.mode)) {
		throw new Error(
			`Invalid --mode. Expected list|delete-files|delete-buckets, got: ${args.mode}`,
		);
	}
	if (args.limitBuckets !== undefined && !Number.isFinite(args.limitBuckets)) {
		throw new Error("Invalid --limit-buckets");
	}
	if (args.limitFiles !== undefined && !Number.isFinite(args.limitFiles)) {
		throw new Error("Invalid --limit-files");
	}

	return args;
}

function printHelp(): void {
	console.log(`
Cleanup tool

Flags:
  --mode=list|delete-files|delete-buckets   (default: list)
  --execute                                Actually submit on-chain tx (default: dry-run)
  --with-files                             For delete-buckets: try deleting bucket files first
  --bucket-name=NAME                       Only operate on bucket name (exact match)
  --bucket-id=0x...                        Only operate on this bucketId
  --limit-buckets=N                        Limit number of buckets processed
  --limit-files=N                          Limit number of files processed per bucket (for delete-files)
  -h, --help                               Show help

Env:
  ACCOUNT_PRIVATE_KEY=0x...
  DATAHAVEN_NETWORK=stagenet|testnet
`);
}

function flattenFileTree(
	files: FileTree[],
): Array<{ name: string; fileKey: `0x${string}` }> {
	const out: Array<{ name: string; fileKey: `0x${string}` }> = [];
	const stack: FileTree[] = [...files];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === "file") {
			out.push({ name: node.name, fileKey: node.fileKey });
		} else {
			stack.push(...node.children);
		}
	}
	return out;
}

export async function runCleanup(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const network = getNetworkConfig();
	const privateKey = getPrivateKey();
	const account = privateKeyToAccount(privateKey);

	console.log("=".repeat(80));
	console.log("[cleanup] DataHaven Cleanup Tool");
	console.log(`[cleanup] Network: ${network.name}`);
	console.log(`[cleanup] Mode: ${args.mode}`);
	console.log(`[cleanup] Execute: ${args.execute ? "YES" : "NO (dry-run)"}`);
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
	console.log("[cleanup] Authenticating with MSP via SIWE...");
	currentSession = Object.freeze(
		await mspClient.auth.SIWE(
			walletClient,
			network.msp.siweDomain,
			network.msp.siweUri,
		),
	);
	console.log("[cleanup] ✓ Authenticated");

	const allBuckets = await mspClient.buckets.listBuckets();
	let buckets = allBuckets;
	if (args.bucketId)
		buckets = buckets.filter((b) => b.bucketId === args.bucketId);
	if (args.bucketName)
		buckets = buckets.filter((b) => b.name === args.bucketName);
	if (args.limitBuckets !== undefined)
		buckets = buckets.slice(0, args.limitBuckets);

	console.log(
		`[cleanup] Buckets matched: ${buckets.length}/${allBuckets.length}`,
	);
	if (buckets.length === 0) return;

	// For fileKey computation we never really need it here, but keep registry init nearby in case
	// we want to extend this tool.
	void new TypeRegistry();

	if (args.mode === "list") {
		for (const b of buckets) {
			console.log(`\n[cleanup] Bucket: ${b.name} (${b.bucketId})`);
			const resp = await mspClient.buckets.getFiles(
				b.bucketId as `0x${string}`,
			);
			const files = flattenFileTree(resp.files);
			console.log(`[cleanup] Files: ${files.length}`);
			for (const f of files.slice(0, args.limitFiles ?? files.length)) {
				console.log(`  - ${f.name} (${f.fileKey})`);
			}
		}
		return;
	}

	async function deleteFileOnChain(
		bucketId: `0x${string}`,
		fileKey: `0x${string}`,
	) {
		// Load file info from MSP to construct CoreFileInfo
		const fi = await mspClient.files.getFileInfo(bucketId, fileKey);
		const core: CoreFileInfo = {
			fileKey: to0x(fi.fileKey),
			fingerprint: to0x(fi.fingerprint),
			bucketId: to0x(fi.bucketId),
			location: fi.location,
			size: BigInt(fi.size),
			blockHash: to0x(fi.blockHash),
			...(fi.txHash ? { txHash: to0x(fi.txHash) } : {}),
		};

		if (!args.execute) {
			console.log(
				`[cleanup] DRY-RUN requestDeleteFile ${core.fileKey} (${core.location})`,
			);
			return;
		}

		const tx = await storageHubClient.requestDeleteFile(core);
		if (!tx) throw new Error("requestDeleteFile returned no tx hash");
		const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
		if (rcpt.status !== "success") throw new Error("requestDeleteFile failed");
		await sleep(500);
	}

	async function deleteBucketOnChain(bucketId: `0x${string}`) {
		if (!args.execute) {
			console.log(`[cleanup] DRY-RUN deleteBucket ${bucketId}`);
			return;
		}
		const tx = await storageHubClient.deleteBucket(bucketId);
		if (!tx) throw new Error("deleteBucket returned no tx hash");
		const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
		if (rcpt.status !== "success") throw new Error("deleteBucket failed");
		await sleep(500);
	}

	if (args.mode === "delete-files") {
		for (const b of buckets) {
			console.log(`\n[cleanup] Bucket: ${b.name} (${b.bucketId})`);
			const resp = await mspClient.buckets.getFiles(
				b.bucketId as `0x${string}`,
			);
			let files = flattenFileTree(resp.files);
			if (args.limitFiles !== undefined)
				files = files.slice(0, args.limitFiles);
			console.log(`[cleanup] Deleting files: ${files.length}`);

			// Sequential on-chain tx to avoid nonce issues
			for (const f of files) {
				try {
					await deleteFileOnChain(b.bucketId as `0x${string}`, f.fileKey);
					console.log(`[cleanup] ✓ delete-file attempted: ${f.name}`);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.log(`[cleanup] ✗ delete-file failed: ${f.name} (${msg})`);
					if (msg.includes("NotEnoughBalance")) {
						throw new Error("NotEnoughBalance: fund the account and retry");
					}
				}
			}
		}
		return;
	}

	// delete-buckets
	for (const b of buckets) {
		console.log(`\n[cleanup] Bucket: ${b.name} (${b.bucketId})`);

		if (args.withFiles) {
			console.log("[cleanup] --with-files set: deleting bucket files first...");
			const resp = await mspClient.buckets.getFiles(
				b.bucketId as `0x${string}`,
			);
			let files = flattenFileTree(resp.files);
			if (args.limitFiles !== undefined)
				files = files.slice(0, args.limitFiles);
			console.log(`[cleanup] Deleting files: ${files.length}`);
			for (const f of files) {
				try {
					await deleteFileOnChain(b.bucketId as `0x${string}`, f.fileKey);
					console.log(`[cleanup] ✓ delete-file attempted: ${f.name}`);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.log(`[cleanup] ✗ delete-file failed: ${f.name} (${msg})`);
				}
			}
		}

		console.log("[cleanup] Deleting bucket...");
		try {
			await deleteBucketOnChain(b.bucketId as `0x${string}`);
			console.log("[cleanup] ✓ delete-bucket attempted");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.log(`[cleanup] ✗ delete-bucket failed: ${msg}`);
			if (msg.includes("NotEnoughBalance")) {
				throw new Error("NotEnoughBalance: fund the account and retry");
			}
		}
	}
}

if (import.meta.main) {
	runCleanup().catch((err) => {
		console.error("[cleanup] ❌ Crashed:", err);
		process.exit(1);
	});
}



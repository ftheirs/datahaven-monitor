// Stage 1: Connection verification

import {
	SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	StorageHubClient,
} from "@storagehub-sdk/core";
import { MspClient } from "@storagehub-sdk/msp-client";
import { defineChain } from "viem";
import { createUserApi } from "../../userApi";
import type { MonitorContext } from "../types";

/**
 * Verify SDK clients can connect to StorageHub chain and MSP backend
 */
export async function connectionStage(ctx: MonitorContext): Promise<void> {
	// Define chain for viem
	const chain = defineChain({
		id: ctx.network.chain.id,
		name: ctx.network.chain.name,
		network: ctx.network.name.toLowerCase().replace(/\s/g, "-"),
		nativeCurrency: { name: "Token", symbol: "TOKEN", decimals: 18 },
		rpcUrls: {
			default: { http: [ctx.network.chain.evmRpcUrl] },
			public: { http: [ctx.network.chain.evmRpcUrl] },
		},
	});

	// Initialize StorageHub client
	console.log("[connection] Creating StorageHub client...");
	ctx.storageHubClient = new StorageHubClient({
		rpcUrl: ctx.network.chain.evmRpcUrl,
		chain,
		walletClient: ctx.walletClient,
		filesystemContractAddress:
			ctx.network.chain.filesystemPrecompileAddress ??
			SH_FILE_SYSTEM_PRECOMPILE_ADDRESS,
	});

	// Initialize MSP client (without session for now)
	console.log("[connection] Creating MSP client...");
	const sessionProvider = async () => ctx.session;
	ctx.mspClient = await MspClient.connect(
		{
			baseUrl: ctx.network.msp.baseUrl,
			timeoutMs: ctx.network.msp.timeoutMs,
		},
		sessionProvider,
	);

	// Initialize Substrate userApi
	console.log("[connection] Creating Substrate userApi...");
	ctx.userApi = await createUserApi(ctx.network.chain.substrateWsUrl);

	// Verify connectivity with simple queries
	console.log("[connection] Verifying chain connectivity...");
	const blockNumber = await ctx.publicClient.getBlockNumber();
	console.log(`[connection] Current block number: ${blockNumber}`);

	const chainHeader = await ctx.userApi.rpc.chain.getHeader();
	console.log(`[connection] Substrate block: ${chainHeader.number.toString()}`);

	console.log("[connection] ✓ All clients connected successfully");
}

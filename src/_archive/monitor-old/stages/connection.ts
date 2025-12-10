// Stage 1: Connection check

import { StorageHubClient } from "@storagehub-sdk/core";
import { MspClient } from "@storagehub-sdk/msp-client";
import { createUserApi } from "../../userApi";
import type { MonitorContext } from "../types";

/**
 * Verify SDK clients can connect to StorageHub chain and MSP backend
 */
export async function connectionStage(ctx: MonitorContext): Promise<void> {
	console.log("[connection] Creating StorageHubClient...");
	ctx.storageHubClient = new StorageHubClient({
		rpcUrl: ctx.network.chain.evmRpcUrl,
		chain: {
			id: ctx.network.chain.id,
			name: ctx.network.chain.name,
			nativeCurrency: { name: "Mock", symbol: "MOCK", decimals: 18 },
			rpcUrls: {
				default: { http: [ctx.network.chain.evmRpcUrl] },
			},
		},
		walletClient: ctx.walletClient,
		filesystemContractAddress: ctx.network.chain.filesystemPrecompileAddress,
	});

	console.log("[connection] Creating MspClient...");
	const sessionProvider = async () =>
		ctx.sessionToken
			? ({ token: ctx.sessionToken, user: { address: "" } } as const)
			: undefined;

	ctx.mspClient = await MspClient.connect(
		{
			baseUrl: ctx.network.msp.baseUrl,
			timeoutMs: ctx.network.msp.timeoutMs,
		},
		sessionProvider,
	);

	console.log("[connection] Creating userApi (Substrate RPC)...");
	ctx.userApi = await createUserApi(
		ctx.network.chain.substrateWsUrl as `wss://${string}`,
	);

	// Verify basic connectivity
	console.log("[connection] Verifying chain connectivity...");
	const peerId = await ctx.userApi.reads.localPeerId();
	console.log(`[connection] Chain peer ID: ${peerId}`);

	console.log("[connection] Verifying MSP backend connectivity...");
	const health = await ctx.mspClient.info.getHealth();
	if (health.status !== "healthy") {
		throw new Error(`MSP health check failed: ${health.status}`);
	}

	console.log("[connection] ✓ All clients connected successfully");
}

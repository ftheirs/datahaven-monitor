// Context initialization for monitor execution

import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkConfig, getPrivateKey } from "./config";
import type { MonitorContext } from "./types";

/**
 * Initialize the monitor context with network config and viem clients
 */
export async function initializeContext(): Promise<MonitorContext> {
	const network = getNetworkConfig();
	const privateKey = getPrivateKey();

	// Create viem clients
	const chain = defineChain({
		id: network.chain.id,
		name: network.chain.name,
		nativeCurrency: { name: "Mock", symbol: "MOCK", decimals: 18 },
		rpcUrls: {
			default: { http: [network.chain.evmRpcUrl] },
		},
	});

	const account = privateKeyToAccount(privateKey);
	const walletClient = createWalletClient({
		chain,
		account,
		transport: http(network.chain.evmRpcUrl),
	});
	const publicClient = createPublicClient({
		chain,
		transport: http(network.chain.evmRpcUrl),
	});

	console.log(`[monitor] Initialized context for ${network.name}`);
	console.log(`[monitor] Account: ${account.address}`);
	console.log(`[monitor] EVM RPC: ${network.chain.evmRpcUrl}`);
	console.log(`[monitor] MSP Backend: ${network.msp.baseUrl}`);

	return {
		network,
		walletClient,
		publicClient,
		account,
	};
}

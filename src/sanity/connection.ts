// Sanity test: verify that we can construct StorageHub and MSP clients and talk to the network.
// This is the first and most critical check: if it fails, the sanity suite should be considered failed.

import { StorageHubClient } from "@storagehub-sdk/core";
import { MspClient, type SessionProvider } from "@storagehub-sdk/msp-client";
import { logCheckResult } from "../util/logger";
import type { ViemClients } from "../util/viemClient";
import type { NetworkConfig } from "./config";

const NAMESPACE = "sanity/connection";

// Result of the connection check – we just return a tuple with the two clients.
export async function runConnectionCheck(
	network: Readonly<NetworkConfig>,
	viem: Readonly<ViemClients>,
	sessionProvider: SessionProvider,
): Promise<[StorageHubClient, MspClient]> {
	// eslint-disable-next-line no-console
	console.log(
		`[${NAMESPACE}] Checking connections for ${network.chain.name} (id=${network.chain.id})`,
	);

	let storageHubClient: StorageHubClient;

	try {
		// Construct StorageHubClient using the configured RPC URL, chain and wallet client.
		storageHubClient = new StorageHubClient({
			rpcUrl: network.chain.evmRpcHttpUrl,
			chain: viem.chain,
			walletClient: viem.walletClient,
			filesystemContractAddress: network.chain
				.filesystemPrecompileAddress as `0x${string}`,
		});

		// Confirm that the RPC endpoint is reachable and reports the expected chain id.
		const chainId = await viem.publicClient.getChainId();
		if (chainId !== network.chain.id) {
			throw new Error(
				`Unexpected chain id from RPC. Expected ${network.chain.id}, got ${chainId}.`,
			);
		}

		logCheckResult(NAMESPACE, "StorageHub connection", true);
	} catch (error) {
		logCheckResult(NAMESPACE, "StorageHub connection", false, error);
		throw error;
	}

	let mspClient: MspClient;

	try {
		// Set up the MSP client using the backend information from the network config.
		const mspBackendHttpConfig = {
			baseUrl: network.msp.baseUrl,
			timeoutMs: network.msp.timeoutMs,
			headers: network.msp.headers,
		};

		// Use the caller-provided sessionProvider so this logic stays agnostic of how
		// sessions are persisted or reused.
		mspClient = await MspClient.connect(mspBackendHttpConfig, sessionProvider);

		logCheckResult(NAMESPACE, "MSP connection", true);
	} catch (error) {
		logCheckResult(NAMESPACE, "MSP connection", false, error);
		throw error;
	}

	return [storageHubClient, mspClient];
}

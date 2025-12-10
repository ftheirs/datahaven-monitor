// Stage 3: SIWE authentication

import { getAddress } from "viem";
import type { MonitorContext } from "../types";

/**
 * Authenticate with MSP backend using Sign-In with Ethereum
 */
export async function authStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient) {
		throw new Error("MspClient not initialized");
	}

	console.log("[auth] Authenticating with MSP backend using SIWE...");
	const domain = new URL(ctx.network.msp.baseUrl).hostname;
	const uri = ctx.network.msp.baseUrl;
	const siweSession = await ctx.mspClient.auth.SIWE(
		ctx.walletClient,
		domain,
		uri,
	);
	ctx.sessionToken = siweSession.token;

	console.log("[auth] Verifying authentication...");
	const profile = await ctx.mspClient.auth.getProfile();

	// Compare using EIP-55 checksum-normalized addresses
	if (profile.address !== getAddress(ctx.account.address)) {
		throw new Error(
			`Profile address mismatch: ${profile.address} !== ${getAddress(ctx.account.address)}`,
		);
	}

	console.log(`[auth] ✓ Authenticated as ${profile.address}`);
}

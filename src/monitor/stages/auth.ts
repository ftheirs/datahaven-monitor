// Stage 3: SIWE authentication

import type { MonitorContext } from "../types";

/**
 * Authenticate with MSP backend using Sign-In with Ethereum
 */
export async function authStage(ctx: MonitorContext): Promise<void> {
	if (!ctx.mspClient) {
		throw new Error("MSP client not initialized");
	}

	console.log("[auth] Authenticating with SIWE...");
	const siweSession = await ctx.mspClient.auth.SIWE(
		ctx.walletClient,
		ctx.network.msp.siweDomain,
		ctx.network.msp.siweUri,
	);

	ctx.session = Object.freeze(siweSession);

	// Verify authentication by calling getProfile
	console.log("[auth] Verifying authentication...");
	const profile = await ctx.mspClient.auth.getProfile();

	if (profile.address.toLowerCase() !== ctx.account.address.toLowerCase()) {
		throw new Error(
			`Profile address mismatch: ${profile.address} !== ${ctx.account.address}`,
		);
	}

	console.log(`[auth] ✓ Authenticated as ${profile.address}`);
}

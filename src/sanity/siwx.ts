// Sanity test: SIWE-style authentication against the MSP backend.
// Uses the shared viem wallet client created in the sanity index.

import { logCheckResult } from "../util/logger";
import type { ViemClients } from "../util/viemClient";
import type { MspClient, Session } from "@storagehub-sdk/msp-client";

const NAMESPACE = "sanity/siwe";
const SIWE_DOMAIN = "localhost:8080";
const SIWE_URI = "http://localhost:8080";

export async function runSiweAuthCheck(
	mspClient: MspClient,
	viem: ViemClients,
): Promise<Session> {
	const session: Session = await mspClient.auth.SIWE(
		viem.walletClient,
		SIWE_DOMAIN,
		SIWE_URI,
	);
	const token = session?.token;
	if (!token || typeof token !== "string" || token.length === 0) {
		logCheckResult(NAMESPACE, "MSP SIWE auth", false, "Missing or empty token");
		throw new Error("MSP SIWE auth did not return a usable token.");
	}

	logCheckResult(NAMESPACE, "MSP SIWE auth", true);
	return session;
}

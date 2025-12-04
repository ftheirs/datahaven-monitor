// Entry point for the sanity test suite.
// Flow:
//   1. Create network config + viem clients
//   2. Connection check (StorageHub + MSP + RPC chain id)
//   3. MSP backend health check
//   4. MSP SIWE auth check
//   5. Hello-world SDK import check

import { getNetworkConfigFromEnv } from "./config";
import { runConnectionCheck } from "./connection";
import { runBackendHealthCheck } from "./healthcheck";
import { runSiweAuthCheck } from "./siwx";
import { runBucketCreationCheck } from "./bucket";
import { runHelloWorld } from "./helloWorld";
import { createViemClients } from "../util/viemClient";
import { logSectionSeparator } from "../util/logger";
import type { SessionProvider, Session } from "@storagehub-sdk/msp-client";

async function main(): Promise<void> {
  try {
    // Step 1: create network config + viem clients.
    const network = getNetworkConfigFromEnv();
    const viem = createViemClients(network);

    // Session provider is passed in so that connection/auth tests do not own how
    // sessions are persisted. We use a simple in-memory implementation for now.
    let currentSession: Session | undefined;
    const sessionProvider: SessionProvider = async () => currentSession;

    // Step 2: ensure we can connect to StorageHub and MSP backends.
    // eslint-disable-next-line no-console
    console.log("[sanity] Running connection check…");
    const [storageHubClient, mspClient] = await runConnectionCheck(network, viem, sessionProvider);
    logSectionSeparator("Connection");

    // Step 3: check MSP backend health.
    // eslint-disable-next-line no-console
    console.log("[sanity] Running MSP backend health check…");
    await runBackendHealthCheck(mspClient);
    logSectionSeparator("MSP Health");

    // Step 4: perform SIWE-style authentication against the MSP backend.
    // eslint-disable-next-line no-console
    console.log("[sanity] Running MSP SIWE auth check…");
    const siweSession = await runSiweAuthCheck(mspClient, viem);
    // Make the authenticated session available through the SessionProvider so
    // subsequent calls can use authenticated methods.
    currentSession = siweSession;
    logSectionSeparator("MSP SIWE");

    // Step 5: create a bucket via the SDK and verify via MSP.
    // eslint-disable-next-line no-console
    console.log("[sanity] Running bucket creation check…");
    const [bucketName, bucketId] = await runBucketCreationCheck(storageHubClient, mspClient, viem);
    // bucketName and bucketId can be reused by subsequent sanity steps when needed.
    logSectionSeparator("Bucket");

    // Step 6: verify SDK imports / basic behavior.
    // eslint-disable-next-line no-console
    console.log("[sanity] Starting hello-world sanity check…");
    await runHelloWorld();
    // eslint-disable-next-line no-console
    console.log("[sanity] Hello-world sanity check completed successfully.");
    logSectionSeparator("Hello World");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[sanity] Sanity suite failed:", error);
    process.exitCode = 1;
  }
}

void main();


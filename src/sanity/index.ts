// Entry point for the sanity test suite.
// Phase 1: run a simple hello-world sanity check that verifies SDK imports.

import { runHelloWorld } from "./helloWorld";

async function main(): Promise<void> {
  try {
    // eslint-disable-next-line no-console
    console.log("[sanity] Starting hello-world sanity check…");
    await runHelloWorld();
    // eslint-disable-next-line no-console
    console.log("[sanity] Hello-world sanity check completed successfully.");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[sanity] Hello-world sanity check failed:", error);
    process.exitCode = 1;
  }
}

void main();



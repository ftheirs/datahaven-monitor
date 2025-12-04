// Sanity hello-world test.
// Goal: verify that we can import StorageHub SDK modules and print something.

// NOTE: We deliberately import the modules in a generic way to avoid
// depending on specific export names at this stage.
import * as StorageHubCore from "@storagehub-sdk/core";
import * as StorageHubMspClient from "@storagehub-sdk/msp-client";

export async function runHelloWorld(): Promise<void> {
  // In a later phase, this will become a real sanity test that talks to Testnet.
  // For now, we just confirm that the modules load and log their available keys.
  // This doubles as a smoke test that the packages are installed correctly.
  // eslint-disable-next-line no-console
  console.log("[sanity/helloWorld] StorageHub Core module keys:", Object.keys(StorageHubCore));
  // eslint-disable-next-line no-console
  console.log("[sanity/helloWorld] StorageHub MSP Client module keys:", Object.keys(StorageHubMspClient));
}



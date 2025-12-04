// Central StorageHub SDK client wrapper (stub).
// Phase 1: only describes intent; real wiring will be added once SDK usage patterns are clear.

import type { StorageHubClient } from "@storagehub-sdk/core";
import type { MspClient } from "@storagehub-sdk/msp-client";

export interface SdkClient {
  // Placeholder references to concrete clients; extend when implementing real tests.
  readonly rawCore: StorageHubClient | null;
  readonly rawMspClient: MspClient | null;
}

export function createSdkClient(): SdkClient {
  // TODO: import and configure concrete clients from @storagehub-sdk/core and @storagehub-sdk/msp-client.
  // For now this returns a very thin placeholder.
  // eslint-disable-next-line no-console
  console.log("[util/sdkClient] createSdkClient is a stub and should be extended.");
  return {
    rawCore: null,
    rawMspClient: null,
  };
}



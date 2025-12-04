// Central StorageHub SDK client wrapper (stub).
// Phase 1: only describes intent; real wiring will be added once SDK usage patterns are clear.

export interface SdkClient {
  // Placeholder methods; extend when implementing real tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly rawCore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly rawMspClient: any;
}

export function createSdkClient(): SdkClient {
  // TODO: import and configure concrete clients from storagehub-sdk/core and msp-client.
  // For now this returns a very thin placeholder.
  // eslint-disable-next-line no-console
  console.log("[util/sdkClient] createSdkClient is a stub and should be extended.");
  return {
    rawCore: null,
    rawMspClient: null,
  };
}



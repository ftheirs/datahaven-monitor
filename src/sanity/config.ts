// Configuration for the sanity test suite.
// Phase 1: includes static chain/MSP/default settings for DataHaven Testnet and Stagenet,
// plus a thin wrapper around process.env that can evolve over time.

export interface ChainConfig {
  readonly id: number;
  readonly name: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly evmRpcHttpUrl: string;
  readonly substrateRpcWsUrl: string;
  readonly filesystemPrecompileAddress: string;
}

export interface MspConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly headers: Record<string, string>;
}

export interface DefaultConfig {
  readonly replicationLevel: string;
  readonly replicas: number;
  readonly gas: string;
  readonly gasPriceWei: string;
  readonly delays: {
    readonly postStorageRequestMs: number;
    readonly beforeUploadMs: number;
  };
}

export interface NetworkConfig {
  readonly chain: ChainConfig;
  readonly msp: MspConfig;
  readonly defaults: DefaultConfig;
}

export const DATAHAVEN_TESTNET_CONFIG: NetworkConfig = {
  chain: {
    id: 55931,
    name: "DataHaven Testnet",
    nativeCurrency: { name: "Mock", symbol: "MOCK", decimals: 18 },
    evmRpcHttpUrl: "https://services.datahaven-testnet.network/testnet",
    substrateRpcWsUrl: "wss://services.datahaven-testnet.network/testnet",
    filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
  },
  msp: {
    baseUrl: "https://deo-dh-backend.testnet.datahaven-infra.network",
    timeoutMs: 30000,
    headers: {},
  },
  defaults: {
    replicationLevel: "Basic",
    replicas: 0,
    gas: "600000",
    gasPriceWei: "2000000000",
    delays: { postStorageRequestMs: 2000, beforeUploadMs: 3000 },
  },
};

export const DATAHAVEN_STAGENET_CONFIG: NetworkConfig = {
  chain: {
    id: 55932,
    name: "DataHaven Stagenet",
    nativeCurrency: { name: "Stage", symbol: "STAGE", decimals: 18 },
    evmRpcHttpUrl: "https://services.datahaven-dev.network/stagenet",
    substrateRpcWsUrl: "wss://services.datahaven-dev.network/stagenet",
    filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
  },
  msp: {
    baseUrl: "https://deo-dh-backend.stagenet.datahaven-infra.network",
    timeoutMs: 30000,
    headers: {},
  },
  defaults: {
    replicationLevel: "Basic",
    replicas: 0,
    gas: "600000",
    gasPriceWei: "2000000000",
    delays: { postStorageRequestMs: 2000, beforeUploadMs: 3000 },
  },
};

export type NetworkKind = "testnet" | "stagenet";

/**
 * Selects which DataHaven network configuration to use based on the DATAHAVEN_NETWORK
 * environment variable.
 *
 * - If DATAHAVEN_NETWORK is "stagenet" (case-insensitive), returns the stagenet config.
 * - Otherwise, defaults to the testnet config.
 */
export function getNetworkConfigFromEnv(): NetworkConfig {
  const raw = process.env.DATAHAVEN_NETWORK ?? "testnet";
  const normalized = raw.toLowerCase() as NetworkKind | string;

  if (normalized === "stagenet") {
    return DATAHAVEN_STAGENET_CONFIG;
  }

  return DATAHAVEN_TESTNET_CONFIG;
}

export interface SanityConfig {
  // Example placeholder fields; extend as needed in later phases.
  readonly storageHubTestnetUrl?: string;
}

export function loadSanityConfig(): SanityConfig {
  // In the first phase, we do not require any specific env vars for hello world.
  // This function exists to establish a pattern and a single place to evolve config.
  return {
    storageHubTestnetUrl: process.env.STORAGEHUB_TESTNET_URL,
  };
}


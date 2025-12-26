// Network configuration for DataHaven monitoring

export type NetworkConfig = {
	name: string;
	chain: {
		id: number;
		name: string;
		evmRpcUrl: string;
		substrateWsUrl: `wss://${string}`;
		filesystemPrecompileAddress: `0x${string}`;
	};
	msp: {
		baseUrl: string;
		timeoutMs: number;
		siweDomain: string;
		siweUri: string;
	};
	test: {
		testFilePath: string;
	};
	delays: {
		postStorageRequestMs: number;
		beforeUploadMs: number;
		postFileDeletionMs: number;
		postBucketDeletionMs: number;
	};
};

export const STAGENET_CONFIG: NetworkConfig = {
	name: "DataHaven Stagenet",
	chain: {
		id: 55932,
		name: "DataHaven Stagenet",
		evmRpcUrl: "https://services.datahaven-dev.network/stagenet",
		substrateWsUrl: "wss://services.datahaven-dev.network/stagenet",
		filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
	},
	msp: {
		baseUrl: "https://deo-dh-backend.stagenet.datahaven-infra.network",
		timeoutMs: 60_000, // 60s for file uploads (stagenet can be slow)
		siweDomain: "deo-dh-backend.stagenet.datahaven-infra.network",
		siweUri: "https://deo-dh-backend.stagenet.datahaven-infra.network",
	},
	test: {
		testFilePath: "./resources/adolphus.jpg",
	},
	delays: {
		postStorageRequestMs: 10_000,
		beforeUploadMs: 15_000,
		postFileDeletionMs: 300_000,
		postBucketDeletionMs: 5_000,
	},
};

export const TESTNET_CONFIG: NetworkConfig = {
	name: "DataHaven Testnet",
	chain: {
		id: 55931,
		name: "DataHaven Testnet",
		evmRpcUrl: "https://services.datahaven-testnet.network/testnet",
		substrateWsUrl: "wss://services.datahaven-testnet.network/testnet",
		filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
	},
	msp: {
		baseUrl: "https://deo-dh-backend.testnet.datahaven-infra.network",
		timeoutMs: 30_000,
		siweDomain: "deo-dh-backend.testnet.datahaven-infra.network",
		siweUri: "https://deo-dh-backend.testnet.datahaven-infra.network",
	},
	test: {
		testFilePath: "./resources/adolphus.jpg",
	},
	delays: {
		postStorageRequestMs: 10_000,
		beforeUploadMs: 15_000,
		postFileDeletionMs: 300_000,
		postBucketDeletionMs: 5_000,
	},
};

export function getNetworkConfig(): NetworkConfig {
	const network = (process.env.DATAHAVEN_NETWORK ?? "stagenet").toLowerCase();
	switch (network) {
		case "testnet":
			return TESTNET_CONFIG;
		case "stagenet":
		default:
			return STAGENET_CONFIG;
	}
}

export function getPrivateKey(): `0x${string}` {
	const key = process.env.ACCOUNT_PRIVATE_KEY;
	if (!key) {
		throw new Error("ACCOUNT_PRIVATE_KEY environment variable is required");
	}
	return key.startsWith("0x")
		? (key as `0x${string}`)
		: (`0x${key}` as `0x${string}`);
}

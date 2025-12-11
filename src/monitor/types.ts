// Core types for monitor

import type { StorageHubClient } from "@storagehub-sdk/core";
import type { MspClient, Session } from "@storagehub-sdk/msp-client";
import type { PublicClient, WalletClient } from "viem";
import type { EnrichedUserApi } from "../userApi";
import type { NetworkConfig } from "./config";

/**
 * Stage execution result
 */
export type StageStatus = "passed" | "failed" | "skipped";

export type StageResult = {
	stage: string;
	status: StageStatus;
	error?: string;
	duration: number;
};

/**
 * Shared context passed between stages
 */
export type MonitorContext = {
	// Network configuration
	network: NetworkConfig;

	// Account/wallet
	account: ReturnType<typeof import("viem/accounts").privateKeyToAccount>;
	walletClient: WalletClient;
	publicClient: PublicClient;

	// SDK clients (initialized in connection stage)
	storageHubClient?: StorageHubClient;
	mspClient?: MspClient;
	userApi?: EnrichedUserApi;

	// Session management (initialized in auth stage)
	session?: Readonly<Session>;

	// MSP info (discovered in bucket-create stage)
	mspId?: string;

	// Test artifacts (created during execution)
	bucketId?: string;
	bucketName?: string;
	fileKey?: string;
	fileLocation?: string;
	fileBlob?: Blob;
	fingerprint?: string;
	fileSize?: bigint;
};

/**
 * Stage function signature
 */
export type StageFunction = (ctx: MonitorContext) => Promise<void>;

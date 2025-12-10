// Core types for the DataHaven monitoring suite

import type { StorageHubClient } from "@storagehub-sdk/core";
import type { MspClient } from "@storagehub-sdk/msp-client";
import type { createPublicClient, createWalletClient } from "viem";
import type { privateKeyToAccount } from "viem/accounts";
import type { EnrichedUserApi } from "../userApi";
import type { NetworkConfig } from "./config";

/**
 * Stage execution result
 */
export type StageResult = {
	stage: string;
	status: "passed" | "failed" | "skipped";
	error?: string;
	duration?: number;
};

/**
 * Shared context passed between stages
 */
export type MonitorContext = {
	// Network config
	network: NetworkConfig;

	// SDK clients
	storageHubClient?: StorageHubClient;
	mspClient?: MspClient;
	userApi?: EnrichedUserApi;

	// Viem clients
	walletClient: ReturnType<typeof createWalletClient>;
	publicClient: ReturnType<typeof createPublicClient>;
	account: ReturnType<typeof privateKeyToAccount>;

	// Session management
	sessionToken?: string;

	// Test artifacts (created during execution)
	bucketId?: string;
	bucketName?: string;
	fileKey?: string;
	fileLocation?: string;
	fileBlob?: Blob;
	fingerprint?: string;
	fileSize?: bigint;

	// MSP info
	mspId?: string;
};

/**
 * Stage function signature
 */
export type StageFunction = (ctx: MonitorContext) => Promise<void>;

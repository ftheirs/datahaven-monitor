// Common helper functions used across the codebase

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure a hex string starts with 0x prefix
 */
export function to0x(val: string): `0x${string}` {
	return val.startsWith("0x")
		? (val as `0x${string}`)
		: (`0x${val}` as `0x${string}`);
}

/**
 * Generate random bytes of specified size
 * Useful for creating test files with random content
 */
export function generateRandomBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
	return bytes;
}

/**
 * Extract peer ID from MSP multiaddress array
 * Format: /ip4/127.0.0.1/tcp/30333/p2p/12D3KooW...
 */
export function extractPeerId(multiaddrs: string[]): string {
	if (multiaddrs.length === 0) {
		throw new Error("No multiaddresses available");
	}
	const parts = multiaddrs[0].split("/");
	const peerIdIndex = parts.findIndex((p) => p === "p2p");
	if (peerIdIndex === -1 || peerIdIndex === parts.length - 1) {
		throw new Error("Could not extract peer ID from multiaddress");
	}
	return parts[peerIdIndex + 1];
}

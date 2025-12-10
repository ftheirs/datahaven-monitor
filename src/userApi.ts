// Optional: side-effect import to register runtime/RPC augmentations (if published in your registry).
// If unavailable, you can remove this line; the typesBundle is still applied below.
// import "@storagehub/api-augment";

import { ApiPromise, WsProvider } from "@polkadot/api";
import type { EventRecord } from "@polkadot/types/interfaces";
import type { HexString } from "@polkadot/util/types";
import { types as BundledTypes } from "@storagehub/types-bundle";

export type RuntimeType = "parachain" | "solochain";

export interface CreateUserApiOptions {
	runtimeType?: RuntimeType;
	skipAugment?: boolean;
}

export interface UserApiHelpers {
	assert: {
		eventPresent: (module: string, method: string) => Promise<EventRecord>;
	};
	wait: {
		finalizedAtLeast: (target: bigint) => Promise<void>;
		forFinalizedEvent: (
			module: string,
			method: string,
			timeoutMs?: number,
		) => Promise<{ blockHash: HexString; event: EventRecord }>;
	};
	reads: {
		localPeerId: () => Promise<string>;
	};
}

export type EnrichedUserApi = ApiPromise & UserApiHelpers;

/**
 * Create a connected ApiPromise with StorageHub types bundle and minimal helpers.
 */
export async function createUserApi(
	endpoint: `ws://${string}` | `wss://${string}`,
	_options?: CreateUserApiOptions,
): Promise<EnrichedUserApi> {
	const provider = new WsProvider(endpoint);
	const api = await ApiPromise.create({
		provider,
		noInitWarn: true,
		throwOnConnect: false,
		throwOnUnknown: false,
		typesBundle: BundledTypes as unknown as any,
	});
	await api.isReady;

	async function eventPresent(
		module: string,
		method: string,
	): Promise<EventRecord> {
		const events =
			(await api.query.system.events()) as unknown as EventRecord[];
		const match = events.find(
			(e) => e.event.section === module && e.event.method === method,
		);
		if (!match) {
			throw new Error(`Event not found: ${module}.${method}`);
		}
		return match;
	}

	async function finalizedAtLeast(target: bigint): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const unsubPromise = api.rpc.chain.subscribeFinalizedHeads(
				async (hdr) => {
					try {
						if (hdr.number.toBigInt() >= target) {
							const unsub = await unsubPromise;
							unsub();
							resolve();
						}
					} catch (e) {
						const unsub = await unsubPromise;
						unsub();
						reject(e);
					}
				},
			);
		});
	}

	async function forFinalizedEvent(
		module: string,
		method: string,
		timeoutMs = 60_000,
	): Promise<{ blockHash: HexString; event: EventRecord }> {
		let timer: NodeJS.Timeout | undefined;
		return new Promise(async (resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error("Timeout waiting for finalized event")),
				timeoutMs,
			);
			const unsub = await api.rpc.chain.subscribeFinalizedHeads(async (hdr) => {
				try {
					const blockHash = hdr.hash.toHex() as HexString;
					const eventsAt = (await api.query.system.events.at(
						blockHash,
					)) as unknown as EventRecord[];
					const found = eventsAt.find(
						(e) => e.event.section === module && e.event.method === method,
					);
					if (found) {
						clearTimeout(timer);
						(await unsub)();
						resolve({ blockHash, event: found });
					}
				} catch (e) {
					clearTimeout(timer);
					(await unsub)();
					reject(e);
				}
			});
		});
	}

	async function localPeerId(): Promise<string> {
		const peerId = await api.rpc.system.localPeerId();
		return peerId.toString();
	}

	const enriched: EnrichedUserApi = Object.assign(api, {
		assert: { eventPresent },
		wait: { finalizedAtLeast, forFinalizedEvent },
		reads: { localPeerId },
	});

	return enriched;
}

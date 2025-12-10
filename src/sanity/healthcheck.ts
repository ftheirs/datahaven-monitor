// Sanity test: MSP backend health check.
// Goal: call the backend health endpoint and log per-service status.

import type { MspClient } from "@storagehub-sdk/msp-client";
import { logCheckResult } from "../util/logger";

const NAMESPACE = "sanity/healthcheck";

// We treat the health response shape loosely here so we don't overfit to the SDK type.
// Shape based on the current backend response:
// {
//   "status": "healthy",
//   "version": "...",
//   "service": "...",
//   "components": {
//     "storage": { "status": "healthy" },
//     "postgres": { "status": "healthy" },
//     "rpc": { "status": "healthy" }
//   }
// }
export interface HealthComponent {
	readonly status?: string;
}

export interface HealthResponse {
	readonly status?: string;
	readonly components?: Record<string, HealthComponent>;
	// Kept for forward/backward compatibility if the shape ever uses "services".
	readonly services?: Record<string, unknown>;
}

export async function runBackendHealthCheck(
	mspClient: MspClient,
): Promise<void> {
	let overallOk = false;
	let overallError: unknown;

	try {
		const health: HealthResponse = await mspClient.info.getHealth();

		const status = health?.status ?? "unknown";

		// Overall status
		if (status !== "healthy") {
			throw new Error(`MSP health status is "${status}" (expected "healthy")`);
		}

		overallOk = true;

		// Optional: per-component/service breakdown.
		const components: Record<string, unknown> | undefined =
			health.components ?? health.services;

		if (components && typeof components === "object") {
			for (const [name, value] of Object.entries(components)) {
				let serviceStatus: string;
				if (
					value &&
					typeof value === "object" &&
					value !== null &&
					"status" in value
				) {
					const component = value as HealthComponent;
					serviceStatus = component.status ?? "unknown";
				} else {
					serviceStatus = String(value);
				}

				const serviceOk = serviceStatus === "healthy";
				logCheckResult(
					NAMESPACE,
					`Component ${name}`,
					serviceOk,
					serviceOk ? undefined : serviceStatus,
				);
			}
		}
	} catch (error) {
		overallError = error;
	}

	logCheckResult(NAMESPACE, "MSP overall health", overallOk, overallError);

	if (!overallOk) {
		throw new Error("MSP backend health check failed.");
	}
}

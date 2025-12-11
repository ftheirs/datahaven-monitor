// Badge generation for shields.io

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageResult, StageStatus } from "../types";

type BadgeEndpoint = {
	schemaVersion: 1;
	label: string;
	message: string;
	color: string;
	cacheSeconds: number;
};

const STAGE_LABELS: Record<string, string> = {
	connection: "Connection",
	health: "Health",
	auth: "Auth (SIWE)",
	"bucket-create": "Bucket Create",
	"storage-request": "Storage Request",
	"file-upload": "File Upload",
	"file-download": "File Download",
	"file-delete": "File Delete",
	"bucket-delete": "Bucket Delete",
};

const STATUS_COLORS: Record<StageStatus, string> = {
	passed: "brightgreen",
	failed: "red",
	skipped: "lightgrey",
};

/**
 * Generate badge JSON files for all stages
 */
export async function generateBadges(
	results: StageResult[],
	outputDir = "badges",
): Promise<void> {
	await mkdir(outputDir, { recursive: true });

	// Generate individual stage badges
	for (const result of results) {
		const badge: BadgeEndpoint = {
			schemaVersion: 1,
			label: STAGE_LABELS[result.stage] || result.stage,
			message: result.status,
			color: STATUS_COLORS[result.status],
			cacheSeconds: 300,
		};

		const filename = `${result.stage}.json`;
		const filepath = join(outputDir, filename);
		await writeFile(filepath, JSON.stringify(badge, null, 2) + "\n");
	}

	// Generate summary status badge
	const passed = results.filter((r) => r.status === "passed").length;
	const failed = results.filter((r) => r.status === "failed").length;
	const total = results.length;

	const summaryBadge: BadgeEndpoint = {
		schemaVersion: 1,
		label: "Monitor Status",
		message:
			failed > 0 ? `${failed}/${total} failed` : `${passed}/${total} passed`,
		color: failed > 0 ? "red" : "brightgreen",
		cacheSeconds: 300,
	};

	await writeFile(
		join(outputDir, "status.json"),
		JSON.stringify(summaryBadge, null, 2) + "\n",
	);
}

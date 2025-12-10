// Badge generation for Shields.io endpoint badges

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StageResult } from "../types";

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
	auth: "SIWE",
	"bucket-create": "Create Bucket",
	"storage-request": "Issue Storage Request",
	"file-upload": "Upload File",
	"file-download": "Download File",
	"file-delete": "Delete File",
	"bucket-delete": "Delete Bucket",
};

const COLOR_MAP: Record<string, string> = {
	passed: "brightgreen",
	failed: "red",
	skipped: "lightgrey",
};

export async function generateBadges(
	results: StageResult[],
	outputDir = "badges",
): Promise<void> {
	await mkdir(outputDir, { recursive: true });

	for (const result of results) {
		const badge: BadgeEndpoint = {
			schemaVersion: 1,
			label: `Sanity – ${STAGE_LABELS[result.stage] ?? result.stage}`,
			message: result.status,
			color: COLOR_MAP[result.status] ?? "lightgrey",
			cacheSeconds: 300,
		};

		const filePath = `${outputDir}/${result.stage}.json`;
		await writeFile(filePath, `${JSON.stringify(badge, null, 2)}\n`, "utf8");
		console.log(`[monitor] Generated badge: ${filePath}`);
	}

	// Also write a summary status file
	const summary = {
		generatedAt: new Date().toISOString(),
		stages: Object.fromEntries(results.map((r) => [r.stage, r.status])),
	};
	const summaryPath = `${outputDir}/status.json`;
	await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	console.log(`[monitor] Generated summary: ${summaryPath}`);
}

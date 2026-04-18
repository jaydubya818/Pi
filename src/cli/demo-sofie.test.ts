#!/usr/bin/env tsx

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

async function main(): Promise<void> {
	const cwd = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const result = await execa(
		"./node_modules/.bin/tsx",
		["src/cli/main.tsx", "demo"],
		{
			cwd,
			reject: false,
			env: {
				...process.env,
				PI_MOCK: "1",
				PI_EXPERTISE_DRY_RUN: "1",
				PI_MULTI_CONFIG: "config/multi-team.external-target.yaml",
			},
		},
	);
	if (result.exitCode !== 0) {
		console.error(
			`demo-sofie: expected exit 0, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
		);
		process.exit(1);
	}
	if (!result.stdout.includes("demo OK")) {
		console.error("demo-sofie: missing demo OK marker");
		process.exit(1);
	}
	console.log("demo-sofie: ok");
}

void main().catch((error) => {
	console.error(`demo-sofie: ${String(error)}`);
	process.exit(1);
});

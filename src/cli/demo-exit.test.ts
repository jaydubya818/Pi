#!/usr/bin/env tsx

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

async function main(): Promise<void> {
	const cwd = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	try {
		const result = await execa(
			"./node_modules/.bin/tsx",
			["src/cli/main.tsx", "demo"],
			{
				cwd,
				timeout: 8000,
				reject: false,
				env: {
					...process.env,
					PI_MOCK: "1",
					PI_EXPERTISE_DRY_RUN: "1",
				},
			},
		);
		if (result.exitCode !== 0) {
			process.stderr.write(
				`demo-exit: expected exit code 0, got ${result.exitCode}\n${result.stdout}\n${result.stderr}\n`,
			);
			process.exit(1);
		}
		if (!result.stdout.includes("demo OK")) {
			process.stderr.write(
				`demo-exit: missing demo OK marker\n${result.stdout}\n`,
			);
			process.exit(1);
		}
		process.stdout.write("demo-exit: ok\n");
	} catch (error) {
		process.stderr.write(`demo-exit: ${String(error)}\n`);
		process.exit(1);
	}
}

void main();

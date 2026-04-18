#!/usr/bin/env tsx

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "fs-extra";
import type { Multi_teamConfig } from "../models/config-schema.js";
import { SessionContext } from "../sessions/session-context.js";
import { maybeRunSofie } from "./runtime.js";

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "sofie-disabled-"));
	try {
		const cfg = {
			app: {
				name: "test",
				sessions_dir: ".runtime/sessions",
				session_mode: "per_request",
				repo_root: ".",
			},
			models: { strategist: "x", lead: "y", worker: "z" },
			orchestrator: {
				name: "orchestrator",
				model: "x",
				system_prompt: "p",
				skills: [],
				domain: { read: ["."], write: [] },
			},
			global_autonomy: "active",
			teams: [],
			features: { enable_sofie: false },
		} satisfies Multi_teamConfig;
		const session = new SessionContext(cfg, "s1", root, "c1");
		await session.init();
		await fs.writeJson(session.path("changed-files.json"), {
			files: [],
			repoRoot: "/repo/AI_CEO",
		});
		await fs.writeJson(session.path("policy-violations.json"), {
			violations: [],
		});
		await fs.writeJson(session.path("artifacts.json"), {
			missing_required_by_agent: [],
			validation_outcomes: [],
		});
		await fs.writeFile(session.path("events.jsonl"), "");
		const chat: string[] = [];
		await maybeRunSofie({
			cfg,
			session,
			userMessage: "safe to continue?",
			onChat: (_from, line) => chat.push(line),
			repoRoot: "/repo/AI_CEO",
		});
		if (chat.length !== 0) {
			console.error("sofie-runtime-disabled: expected no chat output");
			process.exit(1);
		}
		console.log("sofie-runtime-disabled: ok");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	console.error(`sofie-runtime-disabled: ${String(error)}`);
	process.exit(1);
});

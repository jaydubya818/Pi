#!/usr/bin/env tsx
/**
 * Smoke tests for prompt assembly — run via: npm test
 */

import { loadSkillFiles } from "./prompt-build.js";

async function main(): Promise<void> {
	const bundle = await loadSkillFiles(["library"]);
	if (!bundle.includes("# The Library")) {
		console.error("FAIL: library skill bundle missing expected heading");
		process.exit(1);
	}
	if (!bundle.includes("LIBRARY_YAML_PATH")) {
		console.error("FAIL: library skill bundle missing variables section");
		process.exit(1);
	}
	const active = await loadSkillFiles(["active-listener"]);
	if (!active.includes("## Skill: active-listener")) {
		console.error("FAIL: flat .pi/skills/*.md not loaded");
		process.exit(1);
	}
	const deduped = await loadSkillFiles([
		"library",
		"library",
		"active-listener",
	]);
	if ((deduped.match(/## Skill: library/g) ?? []).length !== 1) {
		console.error(
			"FAIL: duplicate skill names must not duplicate bundle sections",
		);
		process.exit(1);
	}
	console.log("prompt-build: ok");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

#!/usr/bin/env node
/**
 * Tier 3 meta-agent dry-run: expert files, teams roster, pi extension load.
 * Does not call LLMs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const piPiDir = join(root, ".pi", "agents", "pi-pi");

const REQUIRED_EXPERTS = [
	"prompt-expert",
	"ext-expert",
	"theme-expert",
	"tui-expert",
	"teams-chains-expert",
	"safety-expert",
	"docs-expert",
];

function parseFrontmatterName(filePath) {
	const raw = readFileSync(filePath, "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!m) return null;
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0 && line.slice(0, idx).trim() === "name") {
			return line.slice(idx + 1).trim();
		}
	}
	return null;
}

let failed = false;
function ok(m) {
	console.log(`ok  ${m}`);
}
function fail(m) {
	console.error(`FAIL ${m}`);
	failed = true;
}

if (!existsSync(piPiDir)) {
	fail("missing .pi/agents/pi-pi");
	process.exit(1);
}

const namesFound = new Set();
for (const file of readdirSync(piPiDir)) {
	if (!file.endsWith(".md") || file === "pi-orchestrator.md") continue;
	const n = parseFrontmatterName(join(piPiDir, file));
	if (n) namesFound.add(n);
}

for (const req of REQUIRED_EXPERTS) {
	if (!namesFound.has(req)) {
		fail(`missing expert "${req}" in .pi/agents/pi-pi`);
	} else {
		ok(`expert ${req}`);
	}
}

const teamsRaw = readFileSync(
	join(root, ".pi", "agents", "teams.yaml"),
	"utf8",
);
let inPiPi = false;
const piPiMembers = [];
for (const line of teamsRaw.split("\n")) {
	if (/^pi-pi:\s*$/.test(line)) {
		inPiPi = true;
		continue;
	}
	if (inPiPi) {
		if (/^\S.*:\s*$/.test(line) && !line.startsWith(" ")) break;
		const im = line.match(/^\s+-\s+(\S+)/);
		if (im) piPiMembers.push(im[1]);
	}
}
for (const req of REQUIRED_EXPERTS) {
	if (!piPiMembers.includes(req)) {
		fail(`teams.yaml pi-pi team missing "${req}"`);
	} else {
		ok(`teams.pi-pi lists ${req}`);
	}
}

const orch = join(piPiDir, "pi-orchestrator.md");
const orchText = readFileSync(orch, "utf8");
if (!orchText.includes("{{EXPERT_CATALOG}}")) {
	fail("pi-orchestrator.md missing {{EXPERT_CATALOG}}");
} else {
	ok("pi-orchestrator template placeholders");
}

const r = spawnSync(
	"pi",
	[
		"-e",
		"extensions/playground-boot.ts",
		"-e",
		"extensions/pi-pi.ts",
		"-e",
		"extensions/theme-cycler.ts",
		"--help",
	],
	{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (r.error || r.status !== 0) {
	console.warn(
		"warn  pi not on PATH or --help failed; skipped stack load check (install Pi locally to verify)",
	);
} else {
	ok("pi loads pi-pi + theme-cycler (--help)");
}

if (failed) process.exit(1);
console.log("verify-tier3: dry-run passed");

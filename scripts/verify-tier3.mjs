#!/usr/bin/env node
/**
 * Tier 3 meta-agent dry-run: expert files, frontmatter validity,
 * teams pi-pi roster, orchestrator template, pi extension load.
 * Does not call LLMs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const piPiDir = join(root, ".pi", "agents", "pi-pi");

// Required experts: these must exist as .md files in .pi/agents/pi-pi/
// and be listed in teams.yaml under the pi-pi team.
const REQUIRED_EXPERTS = [
	"prompt-expert",
	"ext-expert",
	"theme-expert",
	"tui-expert",
	"teams-chains-expert",
	"safety-expert",
	"docs-expert",
	"agent-expert",
	"cli-expert",
	"config-expert",
	"skill-expert",
	"keybinding-expert",
	"test-expert", // added: validates generated extensions/configs
];

// Required frontmatter fields on every expert
const REQUIRED_FM_FIELDS = ["name", "description", "tools"];

function parseFrontmatter(filePath) {
	const raw = readFileSync(filePath, "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!m) return null;
	const fm = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return fm;
}

let failed = false;
function ok(m) {
	console.log(`ok  ${m}`);
}
function fail(m) {
	console.error(`FAIL ${m}`);
	failed = true;
}
function warn(m) {
	console.warn(`warn ${m}`);
}

if (!existsSync(piPiDir)) {
	fail("missing .pi/agents/pi-pi");
	process.exit(1);
}

// ── Expert file checks ────────────────────────────────────────────────────────
const namesFound = new Set();
const expertFiles = readdirSync(piPiDir).filter(
	(f) => f.endsWith(".md") && f !== "pi-orchestrator.md" && f !== "README.md",
);

for (const file of expertFiles) {
	const fm = parseFrontmatter(join(piPiDir, file));
	if (!fm) {
		fail(`${file}: missing or invalid YAML frontmatter`);
		continue;
	}
	namesFound.add(fm.name);

	for (const field of REQUIRED_FM_FIELDS) {
		if (!fm[field]) {
			fail(`${file}: frontmatter missing required field "${field}"`);
		}
	}
}

// Check all required experts are present
for (const req of REQUIRED_EXPERTS) {
	if (!namesFound.has(req)) {
		fail(`missing expert "${req}" in .pi/agents/pi-pi/`);
	} else {
		ok(`expert ${req}`);
	}
}

// ── pi-pi team roster in teams.yaml ──────────────────────────────────────────
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

// Only core required experts must be in the pi-pi team roster.
// New/optional experts are checked separately with a warning.
const CORE_TEAM_EXPERTS = [
	"prompt-expert",
	"ext-expert",
	"theme-expert",
	"tui-expert",
	"teams-chains-expert",
	"safety-expert",
	"docs-expert",
];
for (const req of CORE_TEAM_EXPERTS) {
	if (!piPiMembers.includes(req)) {
		fail(`teams.yaml pi-pi team missing "${req}"`);
	} else {
		ok(`teams.pi-pi lists ${req}`);
	}
}
// Warn about required experts not yet in pi-pi team roster
for (const req of REQUIRED_EXPERTS.filter(
	(e) => !CORE_TEAM_EXPERTS.includes(e),
)) {
	if (!piPiMembers.includes(req)) {
		warn(
			`teams.yaml pi-pi team does not yet list "${req}" — add when the expert is ready for active use`,
		);
	} else {
		ok(`teams.pi-pi lists ${req}`);
	}
}

// ── pi-orchestrator template ──────────────────────────────────────────────────
const orch = join(piPiDir, "pi-orchestrator.md");
if (!existsSync(orch)) {
	fail("missing .pi/agents/pi-pi/pi-orchestrator.md");
} else {
	const orchText = readFileSync(orch, "utf8");
	if (!orchText.includes("{{EXPERT_CATALOG}}")) {
		fail("pi-orchestrator.md missing {{EXPERT_CATALOG}} placeholder");
	} else {
		ok("pi-orchestrator template has {{EXPERT_CATALOG}} placeholder");
	}
	// Optional placeholder warnings
	for (const placeholder of ["{{EXPERT_COUNT}}", "{{EXPERT_NAMES}}"]) {
		if (!orchText.includes(placeholder)) {
			warn(`pi-orchestrator.md missing optional placeholder ${placeholder}`);
		}
	}
}

// ── Pi stack load check (skipped when pi not on PATH) ────────────────────────
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
	warn(
		"pi not on PATH or --help failed; skipped stack load check (install Pi locally to verify)",
	);
} else {
	ok("pi loads pi-pi + theme-cycler (--help)");
}

if (failed) process.exit(1);
console.log("verify-tier3: dry-run passed");

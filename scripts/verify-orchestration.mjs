#!/usr/bin/env node
/**
 * Tier 2 playground verification (no Pi TUI):
 * - teams.yaml structure: required teams present, all members have agent files
 * - agent-chain.yaml structure: required chains, all step agents have files
 * - damage-control-rules.yaml: required top-level keys, all bash regexes compile
 *   and at least one non-ask pattern blocks a known-risky command
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadYaml(rel) {
	return yamlParse(readFileSync(join(root, rel), "utf8"));
}

function parseTeamsYaml(rawText) {
	const teams = {};
	let current = null;
	for (const line of rawText.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch && !line.startsWith("#")) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

let failed = false;
function ok(msg) {
	console.log(`ok  ${msg}`);
}
function fail(msg) {
	console.error(`FAIL ${msg}`);
	failed = true;
}
function warn(msg) {
	console.warn(`warn ${msg}`);
}

// ── Discover available agent .md files ───────────────────────────────────────
// Root agents: .pi/agents/*.md (basename without extension = agent name)
const agentsDir = join(root, ".pi", "agents");
const availableAgents = new Set(
	readdirSync(agentsDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.replace(/\.md$/, "")),
);

// Pi Pi experts: .pi/agents/pi-pi/*.md (identified by frontmatter `name:` field)
const piPiAgentsDir = join(agentsDir, "pi-pi");
const availablePiPiExperts = new Set();
if (existsSync(piPiAgentsDir)) {
	for (const f of readdirSync(piPiAgentsDir)) {
		if (!f.endsWith(".md") || f === "pi-orchestrator.md" || f === "README.md")
			continue;
		const raw = readFileSync(join(piPiAgentsDir, f), "utf8");
		const m = raw.match(/^---\n([\s\S]*?)\n---/);
		if (m) {
			for (const line of m[1].split("\n")) {
				const idx = line.indexOf(":");
				if (idx > 0 && line.slice(0, idx).trim() === "name") {
					availablePiPiExperts.add(line.slice(idx + 1).trim());
				}
			}
		}
	}
}

// ── Teams YAML ───────────────────────────────────────────────────────────────
const teamsRaw = readFileSync(
	join(root, ".pi", "agents", "teams.yaml"),
	"utf8",
);
const teams = parseTeamsYaml(teamsRaw);

if (!teams.default?.length) {
	fail("teams.yaml missing non-empty `default` team");
} else {
	ok(`teams.default → ${teams.default.join(", ")}`);
}
if (!teams.full?.length) {
	fail("teams.yaml missing non-empty `full` team (alternate roster)");
} else {
	ok(`teams.full → ${teams.full.join(", ")}`);
}

// Every member referenced in every team must resolve to an agent file.
// The pi-pi team is special: its members are experts in .pi/agents/pi-pi/ (identified
// by frontmatter name:), not root-level .pi/agents/*.md files.
let missingCount = 0;
for (const [teamName, members] of Object.entries(teams)) {
	const isPiPiTeam = teamName === "pi-pi";
	for (const member of members) {
		const found = isPiPiTeam
			? availablePiPiExperts.has(member)
			: availableAgents.has(member);
		if (!found) {
			const location = isPiPiTeam
				? `.pi/agents/pi-pi/ (name: ${member})`
				: `.pi/agents/${member}.md`;
			fail(
				`teams.yaml team "${teamName}" references unknown agent "${member}" (not found in ${location})`,
			);
			missingCount++;
		}
	}
}
if (missingCount === 0) {
	ok(
		`teams.yaml: all ${Object.values(teams).flat().length} member references resolve to agent files`,
	);
}

// ── Agent chain YAML ──────────────────────────────────────────────────────────
const chainDoc = loadYaml(".pi/agents/agent-chain.yaml");
if (typeof chainDoc !== "object" || chainDoc === null) {
	fail("agent-chain.yaml: top-level must be a YAML mapping");
} else {
	ok("agent-chain.yaml: valid YAML mapping");
}

// Structural check: every chain entry must have a non-empty steps array,
// each step must have an `agent` field, and that agent must resolve.
let totalChains = 0;
let totalSteps = 0;
for (const [chainName, chain] of Object.entries(chainDoc ?? {})) {
	totalChains++;
	if (!Array.isArray(chain?.steps) || chain.steps.length === 0) {
		fail(`agent-chain.yaml "${chainName}": missing or empty steps array`);
		continue;
	}
	for (const step of chain.steps) {
		totalSteps++;
		if (typeof step.agent !== "string") {
			fail(
				`agent-chain.yaml "${chainName}": step missing string "agent" field`,
			);
		} else if (!availableAgents.has(step.agent)) {
			fail(
				`agent-chain.yaml "${chainName}": step agent "${step.agent}" has no .pi/agents/${step.agent}.md`,
			);
		}
		if (step.prompt !== undefined && typeof step.prompt !== "string") {
			fail(
				`agent-chain.yaml "${chainName}": step "prompt" field must be a string`,
			);
		}
	}
}
ok(
	`agent-chain.yaml: ${totalChains} chains, ${totalSteps} steps, all agent refs valid`,
);

// full-review chain: assert canonical scout→planner→builder→reviewer ordering
const fullReview = chainDoc?.["full-review"];
if (!fullReview?.steps?.length) {
	fail("agent-chain.yaml missing full-review chain");
} else {
	const agents = fullReview.steps.map((s) => s.agent);
	const want = ["scout", "planner", "builder", "reviewer"];
	const match =
		agents.length === want.length && want.every((a, i) => agents[i] === a);
	if (!match) {
		fail(
			`full-review agents expected ${want.join("→")}, got ${agents.join("→")}`,
		);
	} else {
		ok(`chain full-review → ${agents.join(" → ")}`);
	}
}

// ── Damage-control rules YAML ─────────────────────────────────────────────────
const rules = loadYaml(".pi/damage-control-rules.yaml");
const REQUIRED_RULE_KEYS = [
	"bashToolPatterns",
	"zeroAccessPaths",
	"readOnlyPaths",
	"noDeletePaths",
];
for (const key of REQUIRED_RULE_KEYS) {
	if (!Array.isArray(rules[key])) {
		fail(`damage-control-rules.yaml missing array key "${key}"`);
	}
}
ok("damage-control-rules.yaml: required keys present");

// All bash patterns must compile as valid regexes
const bashRules = rules.bashToolPatterns || [];
let badRegexCount = 0;
for (const rule of bashRules) {
	if (typeof rule.pattern !== "string") {
		fail(
			`damage-control-rules.yaml: bashToolPatterns entry missing string "pattern"`,
		);
		badRegexCount++;
		continue;
	}
	try {
		new RegExp(rule.pattern);
	} catch (e) {
		fail(
			`damage-control-rules.yaml: invalid regex "${rule.pattern}": ${e.message}`,
		);
		badRegexCount++;
	}
}
if (badRegexCount === 0) {
	ok(
		`damage-control-rules.yaml: all ${bashRules.length} bash patterns compile`,
	);
}

// At least one non-ask pattern must block a known-risky command
const risky = "git reset --hard";
let blocked = false;
let matchedReason = "";
for (const rule of bashRules) {
	if (rule.ask) continue;
	try {
		if (new RegExp(rule.pattern).test(risky)) {
			blocked = true;
			matchedReason = rule.reason;
			break;
		}
	} catch {}
}
if (!blocked) {
	fail(`damage-control: no non-ask pattern blocked "${risky}"`);
} else {
	ok(`damage-control blocks \`${risky}\` (${matchedReason})`);
}

// Warn about any ask:true rules (informational, not failure)
const askRules = bashRules.filter((r) => r.ask === true);
if (askRules.length > 0) {
	warn(
		`damage-control: ${askRules.length} rule(s) use ask:true (confirmation dialog, not hard block)`,
	);
}

// dryRun rules check (informational)
const dryRunRules = bashRules.filter((r) => r.dryRun === true);
if (dryRunRules.length > 0) {
	ok(
		`damage-control: ${dryRunRules.length} rule(s) use dryRun:true (audit only)`,
	);
}

if (failed) process.exit(1);
console.log("verify:orchestration: all checks passed");

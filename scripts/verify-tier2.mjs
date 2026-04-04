#!/usr/bin/env node
/**
 * Tier 2 playground verification (no Pi TUI):
 * - teams.yaml has default + full rosters
 * - agent-chain.yaml has full-review scout→planner→builder→reviewer
 * - damage-control: at least one bash pattern blocks a known-risk command
 */
import { readFileSync } from "node:fs";
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

// --- Teams (same line-oriented parser as agent-team.ts) ---
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

// --- Agent chain ---
const chainDoc = loadYaml(".pi/agents/agent-chain.yaml");
const fullReview = chainDoc["full-review"];
if (!fullReview?.steps?.length) {
	fail("agent-chain.yaml missing full-review.steps");
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

// --- Damage control: block git reset --hard (no ask) ---
const rules = loadYaml(".pi/damage-control-rules.yaml");
const bashRules = rules.bashToolPatterns || [];
const risky = "git reset --hard";
let blocked = false;
let matchedReason = "";
for (const rule of bashRules) {
	if (rule.ask) continue;
	try {
		const re = new RegExp(rule.pattern);
		if (re.test(risky)) {
			blocked = true;
			matchedReason = rule.reason;
			break;
		}
	} catch {
		fail(`invalid regex in damage-control-rules: ${rule.pattern}`);
	}
}
if (!blocked) {
	fail(`damage-control: no non-ask pattern blocked "${risky}"`);
} else {
	ok(`damage-control blocks \`${risky}\` (${matchedReason})`);
}

if (failed) process.exit(1);
console.log("verify-tier2: all checks passed");

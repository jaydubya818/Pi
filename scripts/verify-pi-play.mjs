#!/usr/bin/env node
/**
 * Smoke-test that `pi` loads each playground extension stack without crashing.
 * Does not open the TUI — uses `pi --help` after registering extensions.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Same load order as npm `pi-play:*` / `pi-tier:v*` (boot is a no-op without PI_PLAYGROUND_LABEL). */
const PLAYGROUND_BOOT = ["-e", "extensions/playground-boot.ts"];
function withPlaygroundBoot(args) {
	if (args.length === 0) return args;
	return [...PLAYGROUND_BOOT, ...args];
}

const stacks = [
	{ name: "tier-v0-default", args: [] },
	{ name: "pure-focus", args: ["-e", "extensions/pure-focus.ts"] },
	{
		name: "minimal+theme-cycler",
		args: ["-e", "extensions/minimal.ts", "-e", "extensions/theme-cycler.ts"],
	},
	{
		name: "cross-agent+minimal",
		args: ["-e", "extensions/cross-agent.ts", "-e", "extensions/minimal.ts"],
	},
	{
		name: "purpose-gate+minimal",
		args: ["-e", "extensions/purpose-gate.ts", "-e", "extensions/minimal.ts"],
	},
	{ name: "tool-counter", args: ["-e", "extensions/tool-counter.ts"] },
	{
		name: "tool-counter-widget+minimal+theme-cycler",
		args: [
			"-e",
			"extensions/tool-counter-widget.ts",
			"-e",
			"extensions/minimal.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "subagent+pure-focus+theme-cycler",
		args: [
			"-e",
			"extensions/subagent-widget.ts",
			"-e",
			"extensions/pure-focus.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "tilldone+theme-cycler",
		args: ["-e", "extensions/tilldone.ts", "-e", "extensions/theme-cycler.ts"],
	},
	{
		name: "agent-team+theme-cycler",
		args: [
			"-e",
			"extensions/agent-team.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "system-select+minimal+theme-cycler",
		args: [
			"-e",
			"extensions/system-select.ts",
			"-e",
			"extensions/minimal.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "damage-control+minimal+theme-cycler",
		args: [
			"-e",
			"extensions/damage-control.ts",
			"-e",
			"extensions/minimal.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "agent-chain+theme-cycler",
		args: [
			"-e",
			"extensions/agent-chain.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "pi-pi+theme-cycler",
		args: ["-e", "extensions/pi-pi.ts", "-e", "extensions/theme-cycler.ts"],
	},
	{
		name: "pathfinder+minimal+theme-cycler",
		args: [
			"--system",
			".pi/agents/pathfinder.md",
			"-e",
			"extensions/minimal.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "mirrorline+minimal+theme-cycler",
		args: [
			"--system",
			".pi/agents/mirrorline.md",
			"-e",
			"extensions/minimal.ts",
			"-e",
			"extensions/theme-cycler.ts",
		],
	},
	{
		name: "session-replay+minimal",
		args: ["-e", "extensions/session-replay.ts", "-e", "extensions/minimal.ts"],
	},
];

let failed = false;
for (const { name, args } of stacks) {
	const r = spawnSync("pi", [...withPlaygroundBoot(args), "--help"], {
		cwd: root,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.status !== 0) {
		failed = true;
		console.error(`FAIL ${name}: exit ${r.status}`);
		if (r.stderr) console.error(r.stderr.slice(0, 2000));
	} else {
		console.log(`ok  ${name}`);
	}
}

if (failed) {
	process.exit(1);
}
console.log("verify-pi-play: all stacks loaded");

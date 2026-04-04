import { resolve } from "node:path";
import fs from "fs-extra";
import { PROJECT_ROOT } from "../app/config-loader.js";
import type { Multi_teamConfig } from "../models/config-schema.js";

export async function loadPromptFile(rel: string): Promise<string> {
	const p = resolve(PROJECT_ROOT, rel.replace(/^\.\//, ""));
	return fs.readFile(p, "utf8");
}

export async function loadSkillFiles(names: string[]): Promise<string> {
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const n of names) {
		if (seen.has(n)) continue;
		seen.add(n);
		const candidates = [
			resolve(PROJECT_ROOT, ".pi/skills", `${n}.md`),
			resolve(PROJECT_ROOT, ".pi/skills", n, "SKILL.md"),
			resolve(PROJECT_ROOT, "vendor", n, "SKILL.md"),
		];
		let loaded: string | null = null;
		for (const p of candidates) {
			if (await fs.pathExists(p)) {
				loaded = await fs.readFile(p, "utf8");
				break;
			}
		}
		if (loaded) parts.push(`## Skill: ${n}\n\n${loaded}`);
	}
	return parts.join("\n\n");
}

export async function loadExpertise(paths: string[]): Promise<string> {
	const parts: string[] = [];
	for (const rel of paths) {
		const p = resolve(PROJECT_ROOT, rel.replace(/^\.\//, ""));
		if (await fs.pathExists(p)) parts.push(await fs.readFile(p, "utf8"));
	}
	return parts.join("\n\n---\n\n");
}

export async function buildSystemPrompt(opts: {
	role: string;
	team: string | null;
	cfg: Multi_teamConfig;
	agentName: string;
	promptPath: string;
	skillNames: string[];
	expertiseWritable: string[];
	expertiseReadonly: string[];
	sessionRoot: string;
	contractInstructions: boolean;
}): Promise<string> {
	const base = await loadPromptFile(opts.promptPath);
	const skills = await loadSkillFiles(opts.skillNames);
	const exW = await loadExpertise(opts.expertiseWritable);
	const exR = await loadExpertise(opts.expertiseReadonly);
	const contract = opts.contractInstructions
		? `

## Delegation contract (mandatory)
When you finish your assigned task, your FINAL assistant message must consist of ONLY a single JSON object (no markdown fences) with keys:
objective, status (success|partial|blocked|failed), summary, files_touched (array), artifacts (array of paths), blockers (array), next_step (string).

Prefer writing artifacts to disk under your team's directories (plans/, validation/, artifacts/) before returning JSON.
`
		: "";
	return `${base}

## Context
- Role: ${opts.role}
- Agent name: ${opts.agentName}
- Team: ${opts.team ?? "orchestration"}
- Session directory: ${opts.sessionRoot}

## Skills bundle
${skills}

## Writable expertise sources
${exW}

## Read-only expertise
${exR}
${contract}`;
}

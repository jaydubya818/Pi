import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import fs from "fs-extra";
import type { Multi_teamConfig } from "../models/config-schema.js";
import type { SessionContext } from "../sessions/session-context.js";

const GIT_BASELINE_FILE = ".git-baseline.json";
const DELETED_HASH = "__deleted__";

type GitBaseline = {
	repoRoot: string;
	captured_at: string;
	files: Record<string, string>;
};

async function readViolationsFromEvents(
	eventsPath: string,
): Promise<unknown[]> {
	const violations: unknown[] = [];
	if (!(await fs.pathExists(eventsPath))) return violations;
	const rl = createInterface({
		input: createReadStream(eventsPath),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		try {
			const o = JSON.parse(line) as {
				event_type?: string;
				payload?: Record<string, unknown>;
			};
			if (o.event_type === "policy_blocked") violations.push(o);
			if (o.event_type === "approval_resolved") {
				const out = o.payload?.outcome;
				if (out === "denied" || out === "cancel_turn")
					violations.push({
						event_type: o.event_type,
						payload: o.payload,
					});
			}
		} catch {
			/* skip */
		}
	}
	return violations;
}

async function readArtifactRefsFromEvents(
	eventsPath: string,
): Promise<string[]> {
	const refs = new Set<string>();
	if (!(await fs.pathExists(eventsPath))) return [];
	const rl = createInterface({
		input: createReadStream(eventsPath),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		try {
			const o = JSON.parse(line) as {
				event_type?: string;
				payload?: { envelope?: { artifacts?: string[] } };
			};
			if (o.event_type !== "delegation_received") continue;
			for (const a of o.payload?.envelope?.artifacts ?? []) refs.add(a);
		} catch {
			/* skip */
		}
	}
	return [...refs];
}

type ArtifactAudit = {
	required_expected: Array<{
		agent: string;
		team: string | null;
		task_id?: string;
		expected_artifact_kinds?: string[];
	}>;
	produced_by_agent: Array<{
		agent: string;
		team: string | null;
		artifacts: string[];
	}>;
	missing_required_by_agent: Array<{
		agent: string;
		team: string | null;
		reason: string;
	}>;
	validation_outcomes: Array<{
		agent: string;
		team: string | null;
		validation_status: string;
		requires_approval_for_further_mutation: boolean;
	}>;
};

async function readArtifactAuditFromEvents(
	eventsPath: string,
): Promise<ArtifactAudit> {
	const required_expected: ArtifactAudit["required_expected"] = [];
	const produced_by_agent: ArtifactAudit["produced_by_agent"] = [];
	const missing_required_by_agent: ArtifactAudit["missing_required_by_agent"] =
		[];
	const validation_outcomes: ArtifactAudit["validation_outcomes"] = [];
	if (!(await fs.pathExists(eventsPath))) {
		return {
			required_expected,
			produced_by_agent,
			missing_required_by_agent,
			validation_outcomes,
		};
	}
	const rl = createInterface({
		input: createReadStream(eventsPath),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		try {
			const o = JSON.parse(line) as {
				event_type?: string;
				agent?: string;
				team?: string | null;
				payload?: {
					task_contract?: {
						task_id?: string;
						artifact_policy?: string;
						expected_artifact_kinds?: string[];
					};
					envelope?: { artifacts?: string[] };
					contract_error?: boolean;
					validation_result?: {
						validation_status?: string;
						requires_approval_for_further_mutation?: boolean;
					};
				};
			};
			if (
				o.event_type === "delegation_sent" &&
				o.payload?.task_contract?.artifact_policy === "required"
			) {
				required_expected.push({
					agent: o.agent ?? "unknown",
					team: o.team ?? null,
					task_id: o.payload.task_contract.task_id,
					expected_artifact_kinds:
						o.payload.task_contract.expected_artifact_kinds,
				});
			}
			if (o.event_type === "delegation_received") {
				const artifacts = o.payload?.envelope?.artifacts ?? [];
				produced_by_agent.push({
					agent: o.agent ?? "unknown",
					team: o.team ?? null,
					artifacts,
				});
				if (
					o.payload?.task_contract?.artifact_policy === "required" &&
					(o.payload?.contract_error === true || artifacts.length === 0)
				) {
					missing_required_by_agent.push({
						agent: o.agent ?? "unknown",
						team: o.team ?? null,
						reason: o.payload?.contract_error
							? "contract_error"
							: "empty_artifacts",
					});
				}
			}
			if (
				o.event_type === "validation_outcome" &&
				o.payload?.validation_result
			) {
				validation_outcomes.push({
					agent: o.agent ?? "unknown",
					team: o.team ?? null,
					validation_status:
						o.payload.validation_result.validation_status ?? "warn",
					requires_approval_for_further_mutation:
						o.payload.validation_result
							.requires_approval_for_further_mutation === true,
				});
			}
		} catch {
			/* skip */
		}
	}
	return {
		required_expected,
		produced_by_agent,
		missing_required_by_agent,
		validation_outcomes,
	};
}

async function listDirtyTrackedFiles(repoRoot: string): Promise<string[]> {
	const result = await execa("git", ["diff", "--name-only", "HEAD"], {
		cwd: repoRoot,
		reject: false,
	});
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function listUntrackedFiles(repoRoot: string): Promise<string[]> {
	const result = await execa(
		"git",
		["ls-files", "--others", "--exclude-standard"],
		{
			cwd: repoRoot,
			reject: false,
		},
	);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function hashRepoFile(
	repoRoot: string,
	relPath: string,
): Promise<string> {
	const absPath = resolve(repoRoot, relPath);
	if (!(await fs.pathExists(absPath))) return DELETED_HASH;
	const stat = await fs.stat(absPath);
	if (!stat.isFile()) return `__nonfile__:${stat.mode}`;
	const data = await fs.readFile(absPath);
	return createHash("sha256").update(data).digest("hex");
}

async function snapshotDirtyState(
	repoRoot: string,
): Promise<Record<string, string>> {
	const files = new Set<string>([
		...(await listDirtyTrackedFiles(repoRoot)),
		...(await listUntrackedFiles(repoRoot)),
	]);
	const out: Record<string, string> = {};
	for (const relPath of [...files].sort()) {
		out[relPath] = await hashRepoFile(repoRoot, relPath);
	}
	return out;
}

async function readGitBaseline(
	session: SessionContext,
): Promise<GitBaseline | null> {
	const path = session.path(GIT_BASELINE_FILE);
	if (!(await fs.pathExists(path))) return null;
	return (await fs.readJson(path)) as GitBaseline;
}

export async function ensureSessionGitBaseline(opts: {
	repoRoot: string;
	session: SessionContext;
}): Promise<void> {
	if (await fs.pathExists(opts.session.path(GIT_BASELINE_FILE))) return;
	const baseline: GitBaseline = {
		repoRoot: opts.repoRoot,
		captured_at: new Date().toISOString(),
		files: await snapshotDirtyState(opts.repoRoot),
	};
	await fs.writeJson(opts.session.path(GIT_BASELINE_FILE), baseline, {
		spaces: 2,
	});
}

async function computeSessionScopedDiff(opts: {
	repoRoot: string;
	session: SessionContext;
}): Promise<{
	files: string[];
	patch: string;
	preexisting_files: string[];
	current_dirty_files: string[];
}> {
	const baseline = await readGitBaseline(opts.session);
	const current = await snapshotDirtyState(opts.repoRoot);
	const baselineFiles = baseline?.files ?? {};
	const files = Object.keys(current)
		.filter((relPath) => baselineFiles[relPath] !== current[relPath])
		.sort();

	let patch = "# no diff\n";
	if (files.length > 0) {
		const diff = await execa("git", ["diff", "HEAD", "--", ...files], {
			cwd: opts.repoRoot,
			reject: false,
		});
		patch = diff.stdout || "# no diff\n";
		const currentUntracked = new Set(await listUntrackedFiles(opts.repoRoot));
		const untrackedFiles = files.filter((relPath) =>
			currentUntracked.has(relPath),
		);
		if (untrackedFiles.length > 0) {
			patch = `${patch}\n\n# Untracked session files\n${untrackedFiles.map((file) => `- ${file}`).join("\n")}`;
		}
	}

	return {
		files,
		patch,
		preexisting_files: Object.keys(baselineFiles).sort(),
		current_dirty_files: Object.keys(current).sort(),
	};
}

export async function writeSessionArtifacts(opts: {
	session: SessionContext;
	repoRoot: string;
}): Promise<void> {
	const { session, repoRoot } = opts;
	let files: string[] = [];
	let patch = "# no diff\n";
	let preexisting_files: string[] = [];
	let current_dirty_files: string[] = [];
	try {
		const diff = await computeSessionScopedDiff({ repoRoot, session });
		files = diff.files;
		patch = diff.patch;
		preexisting_files = diff.preexisting_files;
		current_dirty_files = diff.current_dirty_files;
	} catch {
		files = [];
	}

	await fs.writeJson(
		session.path("changed-files.json"),
		{
			files,
			repoRoot,
			generated_at: new Date().toISOString(),
			preexisting_files,
			current_dirty_files,
		},
		{ spaces: 2 },
	);
	await fs.writeFile(session.path("git-diff.patch"), patch || "# no diff\n");

	const violations = await readViolationsFromEvents(
		session.path("events.jsonl"),
	);
	await fs.writeJson(
		session.path("policy-violations.json"),
		{ violations },
		{ spaces: 2 },
	);

	const artifactsDir = session.path("artifacts");
	const list = (await fs.pathExists(artifactsDir))
		? (await fs.readdir(artifactsDir)).map((f) =>
				session.path(`artifacts/${f}`),
			)
		: [];
	const refs = await readArtifactRefsFromEvents(session.path("events.jsonl"));
	const artifactAudit = await readArtifactAuditFromEvents(
		session.path("events.jsonl"),
	);
	const missing_refs: string[] = [];
	for (const r of refs) {
		if (!(await fs.pathExists(r))) missing_refs.push(r);
	}
	await fs.writeJson(
		session.path("artifacts.json"),
		{
			artifacts: list,
			referenced_artifacts: refs,
			missing_references: missing_refs,
			required_expected: artifactAudit.required_expected,
			produced_by_agent: artifactAudit.produced_by_agent,
			missing_required_by_agent: artifactAudit.missing_required_by_agent,
			validation_outcomes: artifactAudit.validation_outcomes,
		},
		{ spaces: 2 },
	);

	const timings = session.getTurnTimings();
	await fs.writeJson(
		session.path("timing.json"),
		{
			ended_at: new Date().toISOString(),
			per_agent: timings.map((t) => ({
				agent: t.agent,
				team: t.team,
				role: t.role,
				elapsed_ms: t.elapsed_ms,
			})),
			totals_ms: timings.reduce((s, t) => s + t.elapsed_ms, 0),
		},
		{ spaces: 2 },
	);

	const summary = `# Session ${session.sessionId}

## Changed files
${files.map((f) => `- ${f}`).join("\n") || "- (none detected)"}

## Patch
See \`git-diff.patch\`.

## Artifacts
See \`artifacts.json\`.
`;
	await fs.writeFile(session.path("summary.md"), summary);

	await session.emit({
		correlation_id: session.correlationBase,
		event_type: "session_summary_written",
		agent: "system",
		parent_agent: null,
		team: null,
		payload: { summary: "summary.md" },
	});
}

export async function ensureSessionGitBranch(opts: {
	cfg: Multi_teamConfig;
	repoRoot: string;
	session: SessionContext;
}): Promise<void> {
	const g = opts.cfg.git;
	if (!g?.create_session_branch) return;
	const prefix = g.session_branch_prefix ?? "pi-multi";
	const short = opts.session.sessionId
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.slice(0, 28);
	const branch = `${prefix}/session-${short}`;
	const r = await execa("git", ["checkout", "-b", branch], {
		cwd: opts.repoRoot,
		reject: false,
	});
	await opts.session.emit({
		correlation_id: opts.session.correlationBase,
		event_type: "git_branch_created",
		agent: "system",
		parent_agent: null,
		team: null,
		payload: {
			branch,
			ok: r.exitCode === 0,
			stderr: (r.stderr || "").slice(0, 400),
		},
	});
}

#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	type ApprovalDecision,
	getActiveApproval,
	setApprovalUiNotifier,
	submitApprovalDecision,
} from "../agents/approval-queue.js";
import { PROJECT_ROOT, loadConfig } from "../app/config-loader.js";
import { runUserMessage } from "../control-plane/pipeline.js";
import type { Multi_teamConfig } from "../models/config-schema.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { SessionContext } from "../sessions/session-context.js";
import { newCorrelationId, newSessionId } from "../utils/ids.js";
import {
	type ReplayRow,
	filterReplayRows,
	formatReplayRow,
	loadReplayTimeline,
	writeTimelineMarkdownFile,
} from "./replay.js";

async function cmdCheckEnv(): Promise<void> {
	const issues: string[] = [];
	const v = process.version;
	if (!v.startsWith("v20") && !v.startsWith("v21") && !v.startsWith("v22"))
		issues.push(`Node ${v} — recommend >=20.6`);
	try {
		await execa("npm", ["-v"]);
	} catch {
		issues.push("npm not found");
	}
	for (const bin of ["pi", "tmux"]) {
		try {
			await execa("which", [bin]);
		} catch {
			issues.push(`${bin} not on PATH (optional for some flows)`);
		}
	}
	const mono = "/Users/jaywest/Pi/pi-mono";
	if (!(await fs.pathExists(mono)))
		issues.push(`Reference pi-mono missing: ${mono}`);
	await fs.ensureDir(join(PROJECT_ROOT, ".runtime"));
	try {
		await fs.access(join(PROJECT_ROOT, ".runtime"), fsConstants.W_OK);
	} catch {
		issues.push(".runtime not writable");
	}
	const keyWarn = !process.env.ANTHROPIC_API_KEY && process.env.PI_MOCK !== "1";
	if (keyWarn)
		console.warn(
			"WARN: ANTHROPIC_API_KEY unset — export it for live LLM or PI_MOCK=1 for demos",
		);
	if (issues.length) console.log(issues.join("\n"));
	else console.log("check-env: OK");
	const fatal =
		issues.some((i) => i.includes("npm not found")) ||
		issues.some((i) => i.includes(".runtime not writable"));
	process.exitCode = fatal ? 1 : 0;
}

async function cmdInspectSession(sessionPath: string): Promise<void> {
	const ev = join(sessionPath, "events.jsonl");
	if (!(await fs.pathExists(ev))) {
		console.error("No events.jsonl");
		process.exit(1);
	}
	const lines = (await fs.readFile(ev, "utf8")).trim().split("\n").slice(-20);
	for (const l of lines) console.log(l);
}

type ApprovalUiState = NonNullable<ReturnType<typeof getActiveApproval>>;

function ChatApp(props: {
	cfg: Awaited<ReturnType<typeof loadConfig>>;
	sessionsBase: string;
	initialShowWorkers: boolean;
	approvalAuto: boolean;
}) {
	const { exit } = useApp();
	const [lines, setLines] = useState<string[]>([
		"pi-multi-team-local — Ctrl+C to exit. Type message + Enter. Supervised: 1–4 when approving.",
	]);
	const [buf, setBuf] = useState("");
	const [busy, setBusy] = useState(false);
	const [showWorkers, setShowWorkers] = useState(props.initialShowWorkers);
	const [status, setStatus] = useState<Record<string, string>>({});
	const [approval, setApproval] = useState<ApprovalUiState | null>(null);
	const [cfg, setCfg] = useState(props.cfg);
	const [activeSession, setActiveSession] = useState<SessionContext | null>(
		null,
	);
	const [sessionLabel, setSessionLabel] = useState("—");
	const [usage, setUsage] = useState({
		total: 0,
		byAgent: {} as Record<string, number>,
	});
	const [lastArtifactCount, setLastArtifactCount] = useState<number | null>(
		null,
	);
	const topologyLine = useMemo(
		() =>
			cfg.teams
				.filter((t) => t.enabled)
				.map((t) => t.id)
				.join(","),
		[cfg.teams],
	);

	const createSession = useCallback(
		async (nextCfg: Multi_teamConfig): Promise<SessionContext> => {
			const sid = newSessionId();
			const corr = newCorrelationId();
			const s = new SessionContext(nextCfg, sid, props.sessionsBase, corr);
			await s.init();
			await fs.writeJson(
				s.path("topology.json"),
				{
					session_id: sid,
					teams: nextCfg.teams.filter((t) => t.enabled).map((t) => t.id),
				},
				{ spaces: 2 },
			);
			setSessionLabel(s.sessionId);
			return s;
		},
		[props.sessionsBase],
	);

	useEffect(() => {
		if ((cfg.app.session_mode ?? "per_request") !== "interactive") return;
		void (async () => {
			const s = await createSession(cfg);
			setActiveSession(s);
		})();
	}, [cfg, createSession]);

	useEffect(() => {
		setApprovalUiNotifier(() => {
			setApproval(getActiveApproval());
		});
		return () => setApprovalUiNotifier(null);
	}, []);

	useInput(
		useCallback(
			(input, key) => {
				if (key.ctrl && input === "c") exit();

				const active = getActiveApproval();
				if (active) {
					const decide: Record<string, ApprovalDecision> = {
						"1": "approve_once",
						"2": "deny",
						"3": "approve_session",
						"4": "cancel_turn",
					};
					const d = decide[input];
					if (d) void submitApprovalDecision(d);
					return;
				}

				if (key.return) {
					const msg = buf.trim();
					if (!msg || busy) return;
					setBuf("");
					void (async () => {
						setBusy(true);
						setLines((L) => [...L, `[user] ${msg}`]);
						try {
							if (msg === "/reload") {
								const nextCfg = await loadConfig();
								setCfg(nextCfg);
								if (
									(nextCfg.app.session_mode ?? "per_request") !== "interactive"
								) {
									setActiveSession(null);
									setSessionLabel("—");
								}
								setLines((L) => [
									...L,
									"[system] config reloaded (multi-team.yaml)",
								]);
								return;
							}
							const mode = cfg.app.session_mode ?? "per_request";
							const sessionForTurn =
								mode === "interactive"
									? (activeSession ?? (await createSession(cfg)))
									: await createSession(cfg);
							if (mode === "interactive" && activeSession == null) {
								setActiveSession(sessionForTurn);
							}
							await runUserMessage({
								cfg,
								session: sessionForTurn,
								userMessage: msg,
								approvalAutoAccept: props.approvalAuto,
								onAgentStatus: (agent, s) =>
									setStatus((S) => ({ ...S, [agent]: s })),
								onUsageDelta: (agent, n) =>
									setUsage((u) => ({
										total: u.total + n,
										byAgent: {
											...u.byAgent,
											[agent]: (u.byAgent[agent] ?? 0) + n,
										},
									})),
								onChat: (from, line) => {
									const worker =
										from.includes("dev") ||
										from.includes("engineer") ||
										from.includes("pragmatist") ||
										from.includes("spec") ||
										from.includes("qa") ||
										from.includes("security");
									if (!showWorkers && worker && !from.includes("lead")) return;
									setLines((L) => [...L, `[${from}] ${line.slice(0, 2000)}`]);
								},
							});
							try {
								const j = (await fs.readJson(
									join(sessionForTurn.root, "artifacts.json"),
								)) as { artifacts?: unknown[] };
								setLastArtifactCount(
									Array.isArray(j.artifacts) ? j.artifacts.length : 0,
								);
							} catch {
								setLastArtifactCount(null);
							}
							setLines((L) => [
								...L,
								`[system] session dir: ${sessionForTurn.root}`,
							]);
						} catch (e) {
							setLines((L) => [...L, `[error] ${String(e)}`]);
						} finally {
							setBusy(false);
						}
					})();
					return;
				}
				if (key.backspace || key.delete) {
					setBuf((b) => b.slice(0, -1));
					return;
				}
				if (input === "\t") {
					setShowWorkers((w) => !w);
					setLines((L) => [
						...L,
						`[ui] worker chatter ${!showWorkers ? "on" : "off"}`,
					]);
					return;
				}
				if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
			},
			[buf, busy, cfg, props, exit, showWorkers, activeSession, createSession],
		),
	);

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={1}>
				{lines.slice(-25).map((l, i) => (
					<Text key={`${i}-${l.slice(0, 48)}`}>{l}</Text>
				))}
			</Box>
			{approval ? (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor="yellow"
					paddingX={1}
					marginBottom={1}
				>
					<Text bold color="yellow">
						APPROVAL REQUIRED — press 1–4
					</Text>
					<Text>
						agent={approval.agent} team={approval.team ?? "—"} tool=
						{approval.tool}
					</Text>
					<Text dimColor>action: {approval.action}</Text>
					<Text dimColor>reason: {approval.reason}</Text>
					{approval.paths.length ? (
						<Text dimColor>paths: {approval.paths.join(", ")}</Text>
					) : null}
					{approval.command ? (
						<Text dimColor>cmd: {approval.command}</Text>
					) : null}
					<Text dimColor>
						1=approve once | 2=deny | 3=approve session | 4=cancel turn
					</Text>
				</Box>
			) : null}
			<Text color="cyan">
				{busy ? "… running (or awaiting approval — use 1–4) …" : "> "}
				{buf}
			</Text>
			<Text dimColor>
				session={sessionLabel} mode={cfg.app.session_mode ?? "per_request"} |
				teams={topologyLine || "—"} | last artifacts={lastArtifactCount ?? "—"}{" "}
				| Tab=workers {showWorkers ? "on" : "off"}
			</Text>
			<Text dimColor>
				{Object.entries(status)
					.slice(0, 8)
					.map(([a, s]) => `${a}:${s}`)
					.join(" | ")}
			</Text>
			<Text dimColor>
				tokens≈{usage.total} (best-effort
				{process.env.PI_MOCK === "1"
					? "; PI_MOCK est. 140/turn"
					: "; live SDK: n/a"}
				) |{" "}
				{Object.entries(usage.byAgent)
					.slice(0, 6)
					.map(([a, n]) => `${a}:${n}`)
					.join(" ")}
			</Text>
		</Box>
	);
}

function ReplayApp(props: { rows: ReplayRow[] }) {
	const { exit } = useApp();
	const [i, setI] = useState(0);
	const rows = props.rows;
	useInput(
		useCallback(
			(input, key) => {
				if (key.ctrl && input === "c") exit();
				if (input === "n" || key.downArrow)
					setI((x) => Math.min(rows.length - 1, x + 1));
				if (input === "p" || key.upArrow) setI((x) => Math.max(0, x - 1));
				if (input === "q") exit();
			},
			[rows.length, exit],
		),
	);
	const r = rows[i];
	return (
		<Box flexDirection="column">
			<Text bold>
				Session replay — n/p arrows step, q quit ({i + 1}/{rows.length})
			</Text>
			{r ? <Text>{formatReplayRow(i, r)}</Text> : <Text>(no rows)</Text>}
			{r?.source === "events" && r.payload != null ? (
				<Text dimColor>{JSON.stringify(r.payload).slice(0, 2000)}</Text>
			) : null}
		</Box>
	);
}

async function cmdExportTimeline(
	sessionDir: string,
	opts: {
		outPath?: string;
		agent?: string;
		team?: string;
		types?: string[];
	},
): Promise<void> {
	const path = await writeTimelineMarkdownFile({
		sessionDir: resolve(sessionDir),
		outPath: opts.outPath ? resolve(opts.outPath) : undefined,
		filter: {
			agent: opts.agent,
			team: opts.team,
			types: opts.types,
		},
	});
	console.log(path);
}

async function cmdReplay(
	sessionDir: string,
	opts: { dump?: boolean; agent?: string; team?: string; types?: string[] },
): Promise<void> {
	const all = await loadReplayTimeline(sessionDir);
	const rows = filterReplayRows(all, {
		agent: opts.agent,
		team: opts.team,
		types: opts.types,
	});
	if (opts.dump) {
		for (let i = 0; i < rows.length; i++)
			console.log(formatReplayRow(i, rows[i]));
		return;
	}
	const { waitUntilExit } = render(<ReplayApp rows={rows} />);
	await waitUntilExit();
}

async function cmdStart(): Promise<void> {
	const cfg = await loadConfig();
	const base = resolve(PROJECT_ROOT, cfg.app.sessions_dir.replace(/^\.\//, ""));

	const approvalAuto = process.env.PI_APPROVAL_AUTO === "1";
	const { waitUntilExit } = render(
		<ChatApp
			cfg={cfg}
			sessionsBase={base}
			initialShowWorkers={cfg.app.default_show_workers ?? true}
			approvalAuto={approvalAuto}
		/>,
	);
	await waitUntilExit();
}

async function cmdDemo(): Promise<void> {
	process.env.PI_MOCK = "1";
	process.env.PI_EXPERTISE_DRY_RUN = "1";
	const cfg = await loadConfig();
	const base = resolve(PROJECT_ROOT, cfg.app.sessions_dir.replace(/^\.\//, ""));
	const session = new SessionContext(
		cfg,
		newSessionId(),
		base,
		newCorrelationId(),
	);
	await session.init();
	const prompts = [
		"show the most important files in this repo",
		"ask all teams for 2 improvements to this project",
		"plan -> engineer -> validate a small enhancement: add README section",
		"@engineering inspect the backend and propose one safe refactor",
		"@validation review the recent changes and report risks",
	];
	const chat: string[] = [];
	for (const p of prompts) {
		await runUserMessage({
			cfg,
			session,
			userMessage: p,
			approvalAutoAccept: true,
			onAgentStatus: () => {},
			onChat: (from, line) => chat.push(`${from}: ${line.slice(0, 200)}`),
		});
	}
	const need = [
		"summary.md",
		"events.jsonl",
		"changed-files.json",
		"artifacts.json",
		"policy-violations.json",
		"timing.json",
	];
	for (const f of need) {
		if (!(await fs.pathExists(session.path(f)))) {
			console.error("demo failed: missing", f);
			process.exit(1);
		}
	}
	console.log("demo OK", session.root);
}

async function cmdPolicyCheck(): Promise<void> {
	const cfg = await loadConfig();
	const repoRoot = resolve(PROJECT_ROOT, cfg.app.repo_root);
	const tmp = join(PROJECT_ROOT, ".runtime", "policy-check");
	await fs.remove(tmp);
	await fs.ensureDir(tmp);
	const allowDir = join(tmp, "allow");
	const denyDir = join(tmp, "deny");
	await fs.ensureDir(allowDir);
	await fs.ensureDir(denyDir);
	const secret = join(tmp, ".env");
	await fs.writeFile(secret, "x=1\n");
	const symlink = join(allowDir, "escape-link");
	try {
		await fs.symlink(denyDir, symlink);
	} catch {
		/* symlink may fail on some hosts */
	}
	const p = new PolicyEngine(
		cfg,
		repoRoot,
		[".runtime/policy-check/allow"],
		[".runtime/policy-check/allow"],
		"active",
		"worker",
		{ filesTouched: new Set<string>(), approxLinesChanged: 0 },
	);
	const checks = [
		["allow_write", p.checkWrite(join(allowDir, "ok.txt")) === null],
		["deny_delete_outside", p.checkDelete(join(denyDir, "nope.txt")) !== null],
		["deny_secret_delete", p.checkDelete(secret) !== null],
		[
			"deny_symlink_escape",
			p.checkWrite(join(symlink, "should-block.txt")) !== null,
		],
	];
	const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
	if (failed.length) {
		console.error(`policy-check failed: ${failed.join(", ")}`);
		process.exit(1);
	}
	console.log("policy-check OK");
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv[1];
const dump = argv.includes("--dump");
const typesArg = argv.find((a) => a.startsWith("--types="));
const types = typesArg?.split("=", 2)[1]?.split(",").filter(Boolean);
const agentArg = argv.find((a) => a.startsWith("--agent="))?.split("=", 2)[1];
const teamArg = argv.find((a) => a.startsWith("--team="))?.split("=", 2)[1];
const outArg = argv.find((a) => a.startsWith("--out="))?.split("=", 2)[1];

if (cmd === "check-env") void cmdCheckEnv();
else if (cmd === "inspect-session") void cmdInspectSession(resolve(arg ?? "."));
else if (cmd === "demo") void cmdDemo();
else if (cmd === "policy-check") void cmdPolicyCheck();
else if (cmd === "export")
	void cmdExportTimeline(resolve(arg ?? "."), {
		outPath: outArg,
		types: types?.length ? types : undefined,
		agent: agentArg,
		team: teamArg,
	});
else if (cmd === "replay")
	void cmdReplay(resolve(arg ?? "."), {
		dump,
		types: types?.length ? types : undefined,
		agent: agentArg,
		team: teamArg,
	});
else if (cmd === "start" || !cmd) void cmdStart();
else {
	console.error(
		"Usage: main.ts start|demo|check-env|policy-check|inspect-session|replay|export [dir] [--dump|--out=file.md] [--types=a,b] [--agent=x] [--team=y]",
	);
	process.exit(1);
}

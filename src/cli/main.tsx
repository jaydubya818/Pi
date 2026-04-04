#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
import { isShellLike } from "../utils/shell-guard.js";
import {
	type ChatMessage,
	Composer,
	HELP_LINES,
	Header,
	MessageRow,
	StatusBar,
	classifyAgent,
	makeMessage,
} from "./chat-ui.js";
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
			if (bin === "pi") {
				issues.push(
					`pi not on PATH — fix: export PATH="$PWD/node_modules/.bin:$PATH"  or use ./node_modules/.bin/pi directly`,
				);
			} else {
				issues.push(`${bin} not on PATH (optional for some flows)`);
			}
		}
	}
	const mono =
		process.env.PI_MONO_PATH?.trim() || resolve(PROJECT_ROOT, "..", "pi-mono");
	if (!(await fs.pathExists(mono)))
		issues.push(
			`Reference pi-mono missing: ${mono} (set PI_MONO_PATH or clone as sibling ../pi-mono)`,
		);
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

// ── Approval box (needs approval-queue types, kept local) ─────────────────

function ApprovalBox({ approval }: { approval: ApprovalUiState }) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="yellow"
			paddingX={1}
			marginBottom={1}
		>
			<Text bold color="yellow">
				{"⚡ APPROVAL REQUIRED — press 1–4"}
			</Text>
			<Text>
				{"  agent="}
				{approval.agent}
				{"  team="}
				{approval.team ?? "—"}
				{"  tool="}
				{approval.tool}
			</Text>
			<Text dimColor>
				{"  action: "}
				{approval.action}
			</Text>
			<Text dimColor>
				{"  reason: "}
				{approval.reason}
			</Text>
			{approval.paths.length > 0 ? (
				<Text dimColor>
					{"  paths: "}
					{approval.paths.join(", ")}
				</Text>
			) : null}
			{approval.command ? (
				<Text dimColor>
					{"  cmd: "}
					{approval.command}
				</Text>
			) : null}
			<Text dimColor>
				{"  1=approve once  2=deny  3=approve session  4=cancel turn"}
			</Text>
		</Box>
	);
}

// ── ChatApp ───────────────────────────────────────────────────────────────

function ChatApp(props: {
	cfg: Awaited<ReturnType<typeof loadConfig>>;
	sessionsBase: string;
	initialShowWorkers: boolean;
	approvalAuto: boolean;
}) {
	const { exit } = useApp();

	// ── State ──────────────────────────────────────────────────────────
	const [messages, setMessages] = useState<ChatMessage[]>(() => [
		makeMessage(
			"system",
			"system",
			"Type agent requests  ·  /help  ·  Tab toggles worker lines (hidden by default)  ·  d = debug  ·  Ctrl+C exit",
		),
		makeMessage(
			"system",
			"system",
			"After each turn: session → .runtime/sessions/<id>  ·  npm run replay -- <path> --dump  (human-readable)  ·  npm run inspect-session -- <path>  (raw last-20 events)  ·  Smoke: PI_MOCK=1 npm run demo",
		),
	]);
	const [buf, setBuf] = useState("");
	const [busy, setBusy] = useState(false);
	const [showWorkers, setShowWorkers] = useState(props.initialShowWorkers);
	const [debugMode, setDebugMode] = useState(false);
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
	const startTimeRef = useRef(Date.now());
	const [elapsed, setElapsed] = useState(0);

	// Elapsed timer
	useEffect(() => {
		const t = setInterval(
			() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)),
			1000,
		);
		return () => clearInterval(t);
	}, []);

	const topologyLine = useMemo(
		() =>
			cfg.teams
				.filter((t) => t.enabled)
				.map((t) => t.id)
				.join(","),
		[cfg.teams],
	);

	/** agent-name → resolved model string (alias → full name via cfg.models) */
	const modelByAgent = useMemo(() => {
		// cfg.models maps alias → full-model-id; fall back to raw field value
		const resolve = (m: string) => cfg.models[m] ?? m;
		const map: Record<string, string> = {};
		map[cfg.orchestrator.name] = resolve(cfg.orchestrator.model);
		for (const team of cfg.teams) {
			map[team.lead.name] = resolve(team.lead.model);
			for (const member of team.members) {
				map[member.name] = resolve(member.model);
			}
		}
		return map;
	}, [cfg]);

	/** Append a structured message to the chat pane. */
	const addMsg = useCallback(
		(kind: ChatMessage["kind"], from: string, text: string) => {
			setMessages((ms) => [...ms, makeMessage(kind, from, text)]);
		},
		[],
	);

	// ── Session management ─────────────────────────────────────────────
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

	// ── Input handler ──────────────────────────────────────────────────
	useInput(
		useCallback(
			(input, key) => {
				// Real Ctrl+C always exits immediately
				if (key.ctrl && input === "c") exit();

				// Approval mode intercepts 1–4
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

				// Enter submits
				if (key.return) {
					const msg = buf.trim();
					if (!msg || busy) return;
					setBuf("");
					void (async () => {
						setBusy(true);
						addMsg("user", "user", msg);
						try {
							// ── Exit phrases ────────────────────────────────────────
							const msgLower = msg.toLowerCase().trim();
							if (msgLower === "exit" || msgLower === "quit") {
								addMsg("system", "system", "Exiting pi-multi-team-local…");
								setBusy(false);
								await new Promise((r) => setTimeout(r, 80));
								exit();
								return;
							}
							if (
								msgLower === "ctrl+c" ||
								msgLower === "ctrl + c" ||
								msgLower === "^c"
							) {
								addMsg(
									"system",
									"system",
									"Press the actual Ctrl+C keyboard shortcut to exit.",
								);
								setBusy(false);
								return;
							}
							// ── Shell command guard ──────────────────────────────────
							if (isShellLike(msg)) {
								const firstWord = msg.trim().split(/\s+/)[0];
								addMsg(
									"system",
									"system",
									`"${firstWord}" looks like a shell command. Run it in your terminal after exiting with Ctrl+C.`,
								);
								setBusy(false);
								return;
							}
							// ── Slash commands ───────────────────────────────────────
							if (msg === "/help") {
								for (const line of HELP_LINES) {
									addMsg("help", "help", line);
								}
								setBusy(false);
								return;
							}
							if (msg === "/debug") {
								setDebugMode((d) => {
									const next = !d;
									addMsg(
										"system",
										"system",
										`Debug mode ${next ? "on" : "off"} — JSON shown ${next ? "raw" : "summarized"}`,
									);
									return next;
								});
								setBusy(false);
								return;
							}
							if (msg === "/reload") {
								const nextCfg = await loadConfig();
								setCfg(nextCfg);
								if (
									(nextCfg.app.session_mode ?? "per_request") !== "interactive"
								) {
									setActiveSession(null);
									setSessionLabel("—");
								}
								addMsg("system", "system", "Config reloaded (multi-team.yaml)");
								setBusy(false);
								return;
							}
							// ── Agent dispatch ───────────────────────────────────────
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
									const kind = classifyAgent(from);
									if (!showWorkers && kind === "worker") return;
									addMsg(kind, from, line.slice(0, 2000));
								},
							});
							// Artifact count
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
							addMsg("system", "system", `session → ${sessionForTurn.root}`);
						} catch (e) {
							addMsg("error", "error", String(e));
						} finally {
							setBusy(false);
						}
					})();
					return;
				}

				// Backspace
				if (key.backspace || key.delete) {
					setBuf((b) => b.slice(0, -1));
					return;
				}

				// 'd' with empty buffer toggles debug mode
				if (input === "d" && buf === "") {
					setDebugMode((dm) => {
						const next = !dm;
						addMsg("system", "system", `Debug ${next ? "on" : "off"}`);
						return next;
					});
					return;
				}

				// Tab toggles worker chatter
				if (input === "\t") {
					setShowWorkers((w) => {
						const next = !w;
						addMsg("system", "system", `Worker chatter ${next ? "on" : "off"}`);
						return next;
					});
					return;
				}

				// Regular character input
				if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
			},
			[
				buf,
				busy,
				cfg,
				props,
				exit,
				showWorkers,
				activeSession,
				createSession,
				addMsg,
			],
		),
	);

	// ── Render ─────────────────────────────────────────────────────────
	return (
		<Box flexDirection="column">
			{/* Persistent header strip */}
			<Header
				topologyLine={topologyLine}
				showWorkers={showWorkers}
				debugMode={debugMode}
			/>

			{/* Scrolling chat pane — last N messages */}
			<Box flexDirection="column" marginTop={1}>
				{messages.slice(-20).map((m) => (
					<MessageRow key={m.id} msg={m} debug={debugMode} />
				))}
			</Box>

			{/* Approval gate (only when active) */}
			{approval ? <ApprovalBox approval={approval} /> : null}

			{/* Composer */}
			<Composer buf={buf} busy={busy} />

			{/* Status bar */}
			<StatusBar
				sessionLabel={sessionLabel}
				elapsed={elapsed}
				usage={usage}
				status={status}
				lastArtifactCount={lastArtifactCount}
				sessionMode={cfg.app.session_mode ?? "per_request"}
				mock={process.env.PI_MOCK === "1"}
				modelByAgent={modelByAgent}
			/>
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
			initialShowWorkers={cfg.app.default_show_workers ?? false}
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
	// Clean up stale artifacts from a previous run.  On some sandboxed or
	// network-mounted filesystems the rmdir/unlink inside fs.remove() can
	// fail with EPERM even though the subsequent writes succeed.  Treat that
	// as a non-fatal warning and continue — the test itself is authoritative.
	try {
		await fs.remove(tmp);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(
			`policy-check: could not clean previous run (${msg}) — continuing`,
		);
	}
	await fs.ensureDir(tmp);
	const allowDir = join(tmp, "allow");
	const denyDir = join(tmp, "deny");
	await fs.ensureDir(allowDir);
	await fs.ensureDir(denyDir);
	const secret = join(tmp, ".env");
	await fs.writeFile(secret, "x=1\n");
	const symlink = join(allowDir, "escape-link");
	let symlinkSupported = false;
	try {
		await fs.symlink(denyDir, symlink);
		symlinkSupported = true;
	} catch {
		/* symlinks unsupported on this host — deny_symlink_escape will be skipped */
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
	const checks: Array<[string, boolean]> = [
		["allow_write", p.checkWrite(join(allowDir, "ok.txt")) === null],
		["deny_delete_outside", p.checkDelete(join(denyDir, "nope.txt")) !== null],
		["deny_secret_delete", p.checkDelete(secret) !== null],
	];
	if (symlinkSupported) {
		checks.push([
			"deny_symlink_escape",
			p.checkWrite(join(symlink, "should-block.txt")) !== null,
		]);
	} else {
		console.warn(
			"policy-check: symlinks not supported on this host — deny_symlink_escape skipped",
		);
	}
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

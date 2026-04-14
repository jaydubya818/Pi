/**
 * Executor — Context-window-efficient external API access via Executor sidecar
 *
 * Wraps Executor (https://executor.sh) to give Pi agents access to MCP, OpenAPI,
 * and GraphQL tools without burning context window on verbose tool definitions.
 * Agents discover APIs at runtime inside execute() using tools.search() —
 * only pulling in schema for the tools they actually use.
 *
 * Tools:
 *   execute   — run JS/TS code in the Executor runtime
 *   resume    — resume a paused execution (headless/no-UI sessions only)
 *
 * Commands:
 *   /executor-web       Open Executor Web UI (manage sources, auth)
 *   /executor-start     Start the local Executor sidecar
 *   /executor-stop      Stop the Pi-managed local sidecar
 *   /executor-settings  Show current settings
 *
 * Settings (.pi/settings.json or ~/.pi/settings.json):
 *   piExecutor.mode              "local" | "remote"   (default: "local")
 *   piExecutor.autoStart         boolean              (default: true)
 *   piExecutor.remoteUrl         string               (required for remote mode)
 *   piExecutor.port              number               (default: 7777)
 *   piExecutor.showFooterStatus  boolean              (default: true)
 *   piExecutor.stopLocalOnShutdown boolean            (default: true)
 *
 * Pi v0.67.1 — PI_CODING_AGENT detection:
 *   When PI_CODING_AGENT=true, this extension is running as a Pi subagent.
 *   UI-heavy startup notifications are skipped; sidecar auto-start is suppressed
 *   unless explicitly configured. Execution results are still logged to
 *   .pi/logs/executor-costs.jsonl for parent inspection.
 *
 * Enhancement — cost log:
 *   Every execute() call appends to .pi/logs/executor-costs.jsonl.
 *   Fields: ts, executionId, elapsed, codeLength, status.
 *
 * Usage:
 *   pi -e extensions/executor.ts
 *   pi -e extensions/executor.ts -e extensions/agent-team.ts -e extensions/theme-cycler.ts
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ─────────────────────────────────────────────────────────────────

interface ExecutorSettings {
	mode: "local" | "remote";
	autoStart: boolean;
	remoteUrl: string;
	port: number;
	showFooterStatus: boolean;
	stopLocalOnShutdown: boolean;
}

type SidecarStatus = "stopped" | "starting" | "ready" | "error" | "remote";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ExecutorSettings = {
	mode: "local",
	autoStart: true,
	remoteUrl: "",
	port: 7777,
	showFooterStatus: true,
	stopLocalOnShutdown: true,
};

// ── Settings loader ───────────────────────────────────────────────────────

function loadSettings(cwd: string): ExecutorSettings {
	const candidates = [
		join(cwd, ".pi", "settings.json"),
		join(process.env.HOME ?? "", ".pi", "settings.json"),
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			if (raw.piExecutor && typeof raw.piExecutor === "object") {
				return { ...DEFAULT_SETTINGS, ...raw.piExecutor };
			}
		} catch {}
	}
	return { ...DEFAULT_SETTINGS };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function httpPost(baseUrl: string, path: string, body: unknown): Promise<unknown> {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
	return res.json();
}

async function httpGet(baseUrl: string, path: string): Promise<unknown> {
	const res = await fetch(`${baseUrl}${path}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

// ── Binary check ──────────────────────────────────────────────────────────

function executorAvailable(): boolean {
	try {
		return spawnSync("which", ["executor"], { stdio: "pipe" }).status === 0;
	} catch {
		return false;
	}
}

// ── Cost log ──────────────────────────────────────────────────────────────

function appendCostLog(cwd: string, entry: Record<string, unknown>): void {
	try {
		const dir = join(cwd, ".pi", "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "executor-costs.jsonl"), JSON.stringify(entry) + "\n");
	} catch {}
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let settings: ExecutorSettings = { ...DEFAULT_SETTINGS };
	let sidecarProc: ChildProcess | null = null;
	let sidecarStatus: SidecarStatus = "stopped";
	let baseUrl = "";
	let sessionCwd = "";

	// Pi v0.67.1: PI_CODING_AGENT=true when running as a Pi subagent subprocess.
	// Skip UI-heavy startup and suppress auto-start in subagent context.
	const isSubagent = process.env.PI_CODING_AGENT === "true";

	// ── Sidecar helpers ───────────────────────────────────────────────────

	function updateStatus(ctx: any) {
		if (!settings.showFooterStatus || !ctx?.hasUI) return;
		const dot =
			sidecarStatus === "ready" ? "●" :
			sidecarStatus === "starting" ? "◐" :
			sidecarStatus === "remote" ? "◈" : "○";
		ctx.ui.setStatus("executor", `${dot} executor`);
	}

	async function checkHealth(): Promise<boolean> {
		try {
			await httpGet(baseUrl, "/api/scope");
			return true;
		} catch {
			return false;
		}
	}

	async function startSidecar(ctx: any): Promise<void> {
		if (settings.mode === "remote") {
			if (!settings.remoteUrl) {
				sidecarStatus = "error";
				updateStatus(ctx);
				if (ctx?.hasUI) ctx.ui.notify("piExecutor.remoteUrl is not set in .pi/settings.json", "error");
				return;
			}
			baseUrl = settings.remoteUrl;
			sidecarStatus = "remote";
			updateStatus(ctx);
			return;
		}

		if (!executorAvailable()) {
			sidecarStatus = "error";
			updateStatus(ctx);
			if (!isSubagent && ctx?.hasUI) {
				ctx.ui.notify(
					"executor binary not found.\n" +
					"Install: npm install -g executor  (or see executor.sh)\n" +
					"Or set piExecutor.mode: remote in .pi/settings.json",
					"warning",
				);
			}
			return;
		}

		baseUrl = `http://localhost:${settings.port}`;

		// Reuse a same-cwd sidecar that's already running
		if (await checkHealth()) {
			sidecarStatus = "ready";
			updateStatus(ctx);
			return;
		}

		sidecarStatus = "starting";
		updateStatus(ctx);

		sidecarProc = spawn("executor", ["--port", String(settings.port), "--cwd", sessionCwd], {
			stdio: "ignore",
			detached: false,
			env: { ...process.env },
		});
		sidecarProc.on("error", () => {
			sidecarStatus = "error";
			updateStatus(ctx);
		});

		// Poll readiness (max 5 s)
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 500));
			if (await checkHealth()) {
				sidecarStatus = "ready";
				updateStatus(ctx);
				return;
			}
		}

		sidecarStatus = "error";
		updateStatus(ctx);
	}

	function stopSidecar(ctx?: any) {
		if (sidecarProc && settings.stopLocalOnShutdown) {
			try { sidecarProc.kill("SIGTERM"); } catch {}
			sidecarProc = null;
		}
		sidecarStatus = "stopped";
		updateStatus(ctx);
	}

	// ── execute tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "execute",
		label: "Executor",
		description:
			"Run JavaScript/TypeScript code inside the Executor runtime. " +
			"Use tools.search(keyword) to discover available API tools without consuming context. " +
			"Use tools.describe.tool(name) to inspect a tool's schema. " +
			"Use tools.call(name, params) or plain fetch() to call external services. " +
			"Pattern: search → describe → call. " +
			"Example: const hits = await tools.search('linear issues'); " +
			"const result = await tools.call(hits[0].name, { teamId: 'ENG' }); return result;",
		parameters: Type.Object({
			code: Type.String({
				description:
					"JS/TS code to run in Executor. " +
					"Available globals: tools.search(kw), tools.describe.tool(name), " +
					"tools.call(name, params), tools.executor.sources.list(), fetch().",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { code } = params as { code: string };

			if (sidecarStatus !== "ready" && sidecarStatus !== "remote") {
				await startSidecar(ctx);
				if (sidecarStatus !== "ready" && sidecarStatus !== "remote") {
					return {
						content: [{
							type: "text",
							text: "Executor is not running. Use /executor-start or check /executor-settings.",
						}],
					};
				}
			}

			const start = Date.now();
			try {
				const res = await httpPost(baseUrl, "/api/executions", { code }) as any;
				const elapsed = Date.now() - start;

				appendCostLog(sessionCwd, {
					ts: new Date().toISOString(),
					executionId: res?.id ?? res?.executionId,
					elapsed,
					codeLength: code.length,
					status: res?.status ?? "unknown",
				});

				// Paused execution — needs user interaction
				if (res?.status === "waiting_for_interaction") {
					const msg = res?.text || `Execution paused. executionId: ${res?.executionId ?? res?.id}`;
					return {
						content: [{ type: "text", text: msg }],
						details: ctx.hasUI ? undefined : {
							paused: true,
							executionId: res?.executionId ?? res?.id,
							interaction: res?.structured?.interaction,
						},
					};
				}

				const text = typeof res?.text === "string" ? res.text : JSON.stringify(res, null, 2);
				return { content: [{ type: "text", text }] };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Executor error: ${err?.message ?? err}` }] };
			}
		},

		renderCall(args, theme) {
			const code = ((args as any).code ?? "").replace(/\s+/g, " ").slice(0, 70);
			return new Text(
				theme.fg("toolTitle", theme.bold("execute ")) + theme.fg("dim", code),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const raw = result.content[0]?.type === "text" ? result.content[0].text : "";
			const preview = raw.split("\n").filter((l: string) => l.trim()).slice(0, 2).join(" · ");
			return new Text(theme.fg("muted", preview.slice(0, 100)), 0, 0);
		},
	});

	// ── resume tool (headless only) ───────────────────────────────────────

	pi.registerTool({
		name: "resume",
		label: "Resume Execution",
		description:
			"Resume a paused Executor execution. " +
			"Only use this in headless/no-UI sessions. " +
			"In UI sessions, Executor handles elicitation inline — do not call resume.",
		parameters: Type.Object({
			executionId: Type.String({ description: "executionId returned by execute when status was waiting_for_interaction" }),
			action: Type.Union([Type.Literal("accept"), Type.Literal("reject")], {
				description: "Accept or reject the interaction",
			}),
			content: Type.Record(Type.String(), Type.Unknown(), {
				description: "Interaction response payload",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.hasUI) {
				return {
					content: [{
						type: "text",
						text: "resume is only for headless sessions. In UI mode, Executor handles interactions inline automatically.",
					}],
				};
			}

			const { executionId, action, content } = params as {
				executionId: string;
				action: "accept" | "reject";
				content: Record<string, unknown>;
			};

			if (sidecarStatus !== "ready" && sidecarStatus !== "remote") {
				return { content: [{ type: "text", text: "Executor is not running." }] };
			}

			try {
				const res = await httpPost(
					baseUrl,
					`/api/executions/${encodeURIComponent(executionId)}/resume`,
					{ action, content },
				) as any;
				const text = typeof res?.text === "string" ? res.text : JSON.stringify(res, null, 2);
				return { content: [{ type: "text", text }] };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Resume error: ${err?.message ?? err}` }] };
			}
		},

		renderCall(args, theme) {
			const id = ((args as any).executionId ?? "").slice(0, 12);
			const action = (args as any).action ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("resume ")) +
				theme.fg("accent", id) +
				theme.fg("dim", ` (${action})`),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const raw = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("muted", raw.slice(0, 80)), 0, 0);
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("executor-web", {
		description: "Open Executor Web UI in browser (manage sources and auth)",
		handler: async (_args, ctx) => {
			if (sidecarStatus !== "ready") {
				ctx.ui.notify("Executor is not running — use /executor-start first.", "warning");
				return;
			}
			spawn("open", [`http://localhost:${settings.port}`]);
			ctx.ui.notify(`Opening http://localhost:${settings.port}`, "info");
		},
	});

	pi.registerCommand("executor-start", {
		description: "Start the local Executor sidecar",
		handler: async (_args, ctx) => {
			await startSidecar(ctx);
			ctx.ui.notify(`Executor: ${sidecarStatus}`, sidecarStatus === "ready" ? "success" : "error");
		},
	});

	pi.registerCommand("executor-stop", {
		description: "Stop the Pi-managed local Executor sidecar",
		handler: async (_args, ctx) => {
			stopSidecar(ctx);
			ctx.ui.notify("Executor stopped.", "info");
		},
	});

	pi.registerCommand("executor-settings", {
		description: "Show current Executor settings",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Executor Settings\n` +
				`  mode:             ${settings.mode}\n` +
				`  port:             ${settings.port}\n` +
				`  autoStart:        ${settings.autoStart}\n` +
				`  remoteUrl:        ${settings.remoteUrl || "(none)"}\n` +
				`  showFooterStatus: ${settings.showFooterStatus}\n` +
				`  stopOnShutdown:   ${settings.stopLocalOnShutdown}\n\n` +
				`Status: ${sidecarStatus}\n` +
				`isSubagent (PI_CODING_AGENT): ${isSubagent}\n\n` +
				`Edit: .pi/settings.json → piExecutor: { ... }`,
				"info",
			);
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		sessionCwd = ctx.cwd;
		settings = loadSettings(ctx.cwd);

		// Auto-start: skip in subagent context (PI_CODING_AGENT=true) unless
		// explicitly overridden — subagents should inherit parent's sidecar.
		if (settings.autoStart && !isSubagent) {
			await startSidecar(ctx);
		}

		if (!isSubagent && ctx.hasUI) {
			const msg =
				sidecarStatus === "ready" ? "● Executor ready — use execute() to access external APIs" :
				sidecarStatus === "remote" ? `◈ Executor remote: ${settings.remoteUrl}` :
				sidecarStatus === "error" ? "○ Executor not started — /executor-start or install executor binary" :
				`Executor: ${sidecarStatus}`;
			ctx.ui.notify(msg, sidecarStatus === "ready" || sidecarStatus === "remote" ? "success" : "warning");
		}
	});

	pi.on("session_end", async (_event, _ctx) => {
		stopSidecar();
	});
}

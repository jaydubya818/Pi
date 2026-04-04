/**
 * Damage-Control — Tool-call interception with rule-based blocking
 *
 * Hooks `tool_call` and blocks or confirms risky operations using rules from
 * .pi/damage-control-rules.yaml (fallback: ~/.pi/damage-control-rules.yaml).
 *
 * Rule categories:
 *   bashToolPatterns   — regex on bash command text
 *   zeroAccessPaths    — any file path access blocked
 *   readOnlyPaths      — writes/edits blocked
 *   noDeletePaths      — deletes blocked
 *
 * Rule options (per bashToolPatterns entry):
 *   ask: true          — show confirmation dialog instead of hard blocking
 *   dryRun: true       — log the match without blocking (tuning mode)
 *
 * Global options (top-level YAML keys):
 *   dryRun: true       — override ALL rules to dry-run mode for the session
 *
 * Audit log:
 *   Every decision (blocked, ask, approved, denied, dry-run) is appended to
 *   .pi/logs/damage-control-<ISO-timestamp>.jsonl  (one line per event).
 *   Format: { ts, sessionId, tool, input, rule, action }
 *   The log is append-only; one file is created per Pi session.
 *   Log location: <project>/.pi/logs/  (created automatically).
 *
 * Usage: pi -e extensions/damage-control.ts
 */
import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { applyExtensionDefaults } from "./themeMap.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
	/** When true: log the match without blocking. Useful for rule tuning. */
	dryRun?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
	/** Global dry-run override: set true to run ALL rules in observe-only mode. */
	dryRun?: boolean;
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = {
		bashToolPatterns: [],
		zeroAccessPaths: [],
		readOnlyPaths: [],
		noDeletePaths: [],
		dryRun: false,
	};

	// ── Audit log (per session) ────────────────────────────────────────────────
	// One JSONL file per Pi session, created on first write.
	// Location: <cwd>/.pi/logs/damage-control-<timestamp>.jsonl
	let auditLogPath: string | null = null;
	let sessionId: string = Date.now().toString(36);

	function openAuditLog(cwd: string): string {
		const logsDir = path.join(cwd, ".pi", "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		return path.join(logsDir, `damage-control-${ts}.jsonl`);
	}

	function auditLog(
		tool: string,
		input: unknown,
		rule: string,
		action: "blocked" | "blocked_by_user" | "confirmed_by_user" | "dry_run" | "ask",
	) {
		const entry = {
			ts: new Date().toISOString(),
			sessionId,
			tool,
			rule,
			action,
			input,
		};
		// Write to external JSONL audit file
		if (auditLogPath) {
			try {
				fs.appendFileSync(auditLogPath, JSON.stringify(entry) + "\n");
			} catch {
				// Non-fatal: don't surface log write errors to user
			}
		}
		// Also record in Pi's session log (shows in session-replay, inspect-session)
		pi.appendEntry("damage-control-log", entry);
	}

	// ── Path helpers ───────────────────────────────────────────────────────────
	function resolvePath(p: string, cwd: string): string {
		if (p.startsWith("~")) {
			p = path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(cwd, p);
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
		const resolvedPattern = pattern.startsWith("~")
			? path.join(os.homedir(), pattern.slice(1))
			: pattern;

		if (resolvedPattern.endsWith("/")) {
			const absolutePattern = path.isAbsolute(resolvedPattern)
				? resolvedPattern
				: path.resolve(cwd, resolvedPattern);
			return targetPath.startsWith(absolutePattern);
		}

		const regexPattern = resolvedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*");

		const regex = new RegExp(
			`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`,
		);

		const relativePath = path.relative(cwd, targetPath);
		return (
			regex.test(targetPath) ||
			regex.test(relativePath) ||
			targetPath.includes(resolvedPattern) ||
			relativePath.includes(resolvedPattern)
		);
	}

	// ── session_start ──────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);

		const projectRulesPath = path.join(ctx.cwd, ".pi", "damage-control-rules.yaml");
		const globalRulesPath = path.join(os.homedir(), ".pi", "damage-control-rules.yaml");
		const rulesPath = fs.existsSync(projectRulesPath)
			? projectRulesPath
			: fs.existsSync(globalRulesPath)
			? globalRulesPath
			: null;

		// Reset session state
		sessionId = Date.now().toString(36);
		auditLogPath = openAuditLog(ctx.cwd);

		try {
			if (rulesPath) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = yamlParse(content) as Partial<Rules>;
				rules = {
					bashToolPatterns: loaded.bashToolPatterns || [],
					zeroAccessPaths: loaded.zeroAccessPaths || [],
					readOnlyPaths: loaded.readOnlyPaths || [],
					noDeletePaths: loaded.noDeletePaths || [],
					dryRun: !!loaded.dryRun,
				};
				const totalRules =
					rules.bashToolPatterns.length +
					rules.zeroAccessPaths.length +
					rules.readOnlyPaths.length +
					rules.noDeletePaths.length;
				const source = rulesPath === projectRulesPath ? "project" : "global";
				const dryRunNote = rules.dryRun ? " [DRY-RUN mode — observing only]" : "";
				ctx.ui.notify(
					`🛡️ Damage-Control: Loaded ${totalRules} rules (${source}).${dryRunNote}\n` +
					`Audit log: .pi/logs/${path.basename(auditLogPath)}`,
				);
			} else {
				ctx.ui.notify(
					"🛡️ Damage-Control: No rules found at .pi/damage-control-rules.yaml (project or global)",
				);
			}
		} catch (err) {
			ctx.ui.notify(
				`🛡️ Damage-Control: Failed to load rules: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		const totalRules =
			rules.bashToolPatterns.length +
			rules.zeroAccessPaths.length +
			rules.readOnlyPaths.length +
			rules.noDeletePaths.length;
		const modeTag = rules.dryRun ? " DRY-RUN" : "";
		ctx.ui.setStatus(
			"damage-control",
			`🛡️${modeTag} Active: ${totalRules} rules`,
		);
	});

	// ── tool_call ──────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;
		let ruleDryRun = false;

		// 1. Check Zero Access Paths for all tools that use path or glob
		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		// Extract paths from tool input
		const inputPaths: string[] = [];
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			inputPaths.push(event.input.path);
		} else if (
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			for (const zap of rules.zeroAccessPaths) {
				if (
					event.input.glob.includes(zap) ||
					isPathMatch(event.input.glob, zap, ctx.cwd)
				) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		// 2. Tool-specific logic
		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				for (const rule of rules.bashToolPatterns) {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						ruleDryRun = !!rule.dryRun;
						break;
					}
				}

				if (!violationReason) {
					for (const zap of rules.zeroAccessPaths) {
						if (command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						if (
							command.includes(rop) &&
							(/[\s>|]/.test(command) ||
								command.includes("rm") ||
								command.includes("mv") ||
								command.includes("sed"))
						) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const ndp of rules.noDeletePaths) {
						if (
							command.includes(ndp) &&
							(command.includes("rm") || command.includes("mv"))
						) {
							violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
							break;
						}
					}
				}
			} else if (
				isToolCallEventType("write", event) ||
				isToolCallEventType("edit", event)
			) {
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							break;
						}
					}
				}
			}
		}

		if (!violationReason) {
			return { block: false };
		}

		// 3. Apply global or per-rule dryRun — observe without blocking
		if (rules.dryRun || ruleDryRun) {
			ctx.ui.notify(
				`🔍 Damage-Control [DRY-RUN]: Would have matched ${event.toolName} — ${violationReason}`,
			);
			ctx.ui.setStatus(
				"damage-control-alert",
				`🔍 DRY-RUN: ${violationReason.slice(0, 40)}…`,
			);
			auditLog(event.toolName, event.input, violationReason, "dry_run");
			return { block: false };
		}

		// 4. Ask-before-proceed
		if (shouldAsk) {
			auditLog(event.toolName, event.input, violationReason, "ask");
			const confirmed = await ctx.ui.confirm(
				"🛡️ Damage-Control Confirmation",
				`Dangerous command detected: ${violationReason}\n\nCommand: ${
					isToolCallEventType("bash", event)
						? event.input.command
						: JSON.stringify(event.input)
				}\n\nDo you want to proceed?`,
				{ timeout: 30000 },
			);

			if (!confirmed) {
				ctx.ui.setStatus(
					"damage-control-alert",
					`⚠️ Blocked: ${violationReason.slice(0, 40)}…`,
				);
				auditLog(event.toolName, event.input, violationReason, "blocked_by_user");
				ctx.abort();
				return {
					block: true,
					reason: `🛑 BLOCKED by Damage-Control: ${violationReason} (User denied)\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.`,
				};
			} else {
				auditLog(event.toolName, event.input, violationReason, "confirmed_by_user");
				return { block: false };
			}
		}

		// 5. Hard block
		ctx.ui.notify(
			`🛑 Damage-Control: Blocked ${event.toolName} due to ${violationReason}`,
		);
		ctx.ui.setStatus(
			"damage-control-alert",
			`⚠️ Violation: ${violationReason.slice(0, 40)}…`,
		);
		auditLog(event.toolName, event.input, violationReason, "blocked");
		ctx.abort();
		return {
			block: true,
			reason: `🛑 BLOCKED by Damage-Control: ${violationReason}\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.`,
		};
	});
}

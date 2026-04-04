import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { Multi_teamConfig } from "../models/config-schema.js";
import { normalizePath } from "../policy/path-policy.js";
import type { PolicyEngine, Violation } from "../policy/policy-engine.js";
import type { SessionContext } from "../sessions/session-context.js";
import { TurnCancelledError, askApprovalResolved } from "./approval-queue.js";
import {
	classifyShellCommandCapabilities,
	getToolDescriptor,
} from "./tool-capabilities.js";

function textResult(msg: string): {
	content: (TextContent | ImageContent)[];
	details: unknown;
} {
	return {
		content: [{ type: "text", text: msg }],
		details: {},
	};
}

function paramsRecord(p: unknown): Record<string, unknown> {
	return typeof p === "object" && p !== null
		? (p as Record<string, unknown>)
		: {};
}

function extractPaths(
	toolName: string,
	params: Record<string, unknown>,
	workdir: string,
): string[] {
	const out: string[] = [];
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"target",
		"targetPath",
		"from",
		"to",
		"source",
		"destination",
	]) {
		const v = params[key];
		if (typeof v === "string") out.push(normalizePath(workdir, v));
	}
	const rawPaths = params.paths;
	if (Array.isArray(rawPaths)) {
		for (const p of rawPaths) {
			if (typeof p === "string") out.push(normalizePath(workdir, p));
		}
	}
	if (toolName === "grep" || toolName === "find") {
		const pat = params.path ?? params.directory;
		if (typeof pat === "string") out.push(normalizePath(workdir, pat));
	}
	if (toolName === "ls" && typeof params.path === "string")
		out.push(normalizePath(workdir, params.path));
	return out.filter(Boolean);
}

function extractDeletePathsFromCommand(
	command: string,
	workdir: string,
): string[] {
	if (!/\b(rm|rmdir|unlink)\b/.test(command)) return [];
	const out: string[] = [];
	const chunks = command.split(/&&|;|\|\|/g);
	for (const chunkRaw of chunks) {
		const chunk = chunkRaw.trim();
		if (!/\b(rm|rmdir|unlink)\b/.test(chunk)) continue;
		const tokens = tokenizeShell(chunk);
		let seenDeleteCmd = false;
		for (const tk of tokens) {
			if (tk === "rm" || tk === "rmdir" || tk === "unlink") {
				seenDeleteCmd = true;
				continue;
			}
			if (!seenDeleteCmd || tk.startsWith("-")) continue;
			out.push(normalizePath(workdir, tk));
		}
	}
	return out;
}

type ShellIntent = { kind: "read" | "write" | "delete"; path: string };

function tokenizeShell(command: string): string[] {
	const tokens = command.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g);
	return (tokens ?? []).map((token) => {
		if (
			token.length >= 2 &&
			((token.startsWith('"') && token.endsWith('"')) ||
				(token.startsWith("'") && token.endsWith("'")))
		) {
			return token.slice(1, -1);
		}
		return token;
	});
}

function pushShellIntents(
	out: ShellIntent[],
	kind: ShellIntent["kind"],
	workdir: string,
	paths: string[],
): void {
	for (const path of paths) {
		if (!path || path.startsWith("~")) continue;
		out.push({ kind, path: normalizePath(workdir, path) });
	}
}

function nonOptionArgs(tokens: string[]): string[] {
	return tokens.filter((token) => token && !token.startsWith("-"));
}

export function collectShellIntents(
	command: string,
	workdir: string,
):
	| { ok: true; intents: ShellIntent[] }
	| { ok: false; code: string; message: string } {
	if (/\$\(|`/.test(command)) {
		return {
			ok: false,
			code: "shell_substitution",
			message: "Command substitution is blocked in mediated bash",
		};
	}

	const intents: ShellIntent[] = [];
	const chunks = command.split(/&&|;|\|\|/g);
	for (const chunkRaw of chunks) {
		const chunk = chunkRaw.trim();
		if (!chunk) continue;
		const tokens = tokenizeShell(chunk);
		if (tokens.some((token) => token.startsWith("~"))) {
			return {
				ok: false,
				code: "shell_home_path",
				message: "Home-directory shell paths are blocked in mediated bash",
			};
		}
		let i = 0;
		while (
			i < tokens.length &&
			/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[i] ?? "")
		) {
			i++;
		}
		const cmd = tokens[i]?.toLowerCase();
		if (!cmd) continue;
		const args = tokens.slice(i + 1);
		const argsNoOpts = nonOptionArgs(args);

		if (
			cmd === "cat" ||
			cmd === "head" ||
			cmd === "tail" ||
			cmd === "wc" ||
			cmd === "stat" ||
			cmd === "sort" ||
			cmd === "uniq" ||
			cmd === "cut"
		) {
			pushShellIntents(intents, "read", workdir, argsNoOpts);
			continue;
		}
		if (cmd === "ls") {
			pushShellIntents(intents, "read", workdir, argsNoOpts);
			continue;
		}
		if (cmd === "find") {
			pushShellIntents(intents, "read", workdir, argsNoOpts.slice(0, 1));
			continue;
		}
		if (cmd === "grep" || cmd === "rg") {
			pushShellIntents(intents, "read", workdir, argsNoOpts.slice(1));
			continue;
		}
		if (cmd === "touch" || cmd === "mkdir") {
			pushShellIntents(intents, "write", workdir, argsNoOpts);
			continue;
		}
		if (cmd === "tee") {
			pushShellIntents(intents, "write", workdir, argsNoOpts);
			continue;
		}
		if (cmd === "chmod" || cmd === "chown") {
			pushShellIntents(intents, "write", workdir, argsNoOpts.slice(1));
			continue;
		}
		if (cmd === "cp" || cmd === "mv" || cmd === "install" || cmd === "ln") {
			if (argsNoOpts.length >= 2) {
				pushShellIntents(intents, "read", workdir, argsNoOpts.slice(0, -1));
				pushShellIntents(intents, "write", workdir, argsNoOpts.slice(-1));
			}
			continue;
		}
		if (cmd === "sed") {
			const hasInlineEdit = args.some(
				(token) => token === "-i" || token.startsWith("-i"),
			);
			const fileArgs = argsNoOpts.slice(1);
			pushShellIntents(
				intents,
				hasInlineEdit ? "write" : "read",
				workdir,
				fileArgs,
			);
			continue;
		}
		if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
			pushShellIntents(
				intents,
				"delete",
				workdir,
				extractDeletePathsFromCommand(chunk, workdir).map((abs) => abs),
			);
			continue;
		}

		const explicitArgs = argsNoOpts.filter(
			(token) =>
				token === "." ||
				token === ".." ||
				token.startsWith("./") ||
				token.startsWith("../") ||
				token.startsWith("/") ||
				token.includes("/"),
		);
		if (explicitArgs.length > 0) {
			return {
				ok: false,
				code: "unmediated_shell_path",
				message: `Shell command ${cmd} uses explicit paths that are not policy-mediated`,
			};
		}
	}

	return { ok: true, intents };
}

async function gateSupervisedMutation(opts: {
	session: SessionContext;
	agentName: string;
	team: string | null;
	tool: string;
	action: string;
	paths: string[];
	command: string | null;
	reason: string;
	cbs: MediationCallbacks;
}): Promise<boolean> {
	opts.cbs.onAwaitingApproval?.(opts.agentName);
	const out = await askApprovalResolved(opts.session, {
		agent: opts.agentName,
		team: opts.team,
		tool: opts.tool,
		action: opts.action,
		paths: opts.paths,
		command: opts.command,
		reason: opts.reason,
	});
	if ("cancelTurn" in out && out.cancelTurn)
		throw new TurnCancelledError("cancel_turn");
	return out.allowed === true;
}

export type MediationCallbacks = {
	onToolStart: (tool: string, agent: string) => void;
	onToolEnd: (tool: string, agent: string, ok: boolean) => void;
	onBlocked: (v: Violation, tool: string, agent: string) => void;
	onAwaitingApproval?: (agent: string) => void;
};

export type ValidationGateState = {
	requiresApprovalForFurtherMutation: boolean;
};

export function wrapAgentTools(
	tools: AgentTool[],
	opts: {
		workdir: string;
		repoRoot: string;
		readableRel: string[];
		policy: PolicyEngine;
		agentName: string;
		team: string | null;
		session: SessionContext;
		cfg: Multi_teamConfig;
		autonomy: "advisory" | "supervised" | "active";
		cbs: MediationCallbacks;
		validationGate?: ValidationGateState;
	},
): AgentTool[] {
	const maxFiles = opts.cfg.approval?.max_files_touch ?? 12;
	const maxLines = opts.cfg.approval?.max_lines_changed ?? 500;

	return tools.map((tool) => ({
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const p = paramsRecord(params);
			opts.cbs.onToolStart(tool.name, opts.agentName);
			await opts.session.emit({
				correlation_id: opts.session.correlationBase,
				event_type: "tool_started",
				agent: opts.agentName,
				parent_agent: null,
				team: opts.team,
				payload: { tool: tool.name, params: p },
			});
			const descriptor = getToolDescriptor(tool.name);
			if (!descriptor) {
				const violation = {
					code: "unregistered_tool",
					message: `Tool ${tool.name} is not registered in capability registry`,
				} satisfies Violation;
				opts.cbs.onBlocked(violation, tool.name, opts.agentName);
				await opts.session.emit({
					correlation_id: opts.session.correlationBase,
					event_type: "policy_blocked",
					agent: opts.agentName,
					parent_agent: null,
					team: opts.team,
					payload: { tool: tool.name, violation },
				});
				opts.cbs.onToolEnd(tool.name, opts.agentName, false);
				return textResult(
					`POLICY_BLOCKED: ${violation.code} — ${violation.message}`,
				);
			}

			if (descriptor.capabilities.includes("read")) {
				for (const abs of extractPaths(tool.name, p, opts.workdir)) {
					const vr = opts.policy.checkRead(abs, opts.readableRel);
					if (vr) {
						opts.cbs.onBlocked(vr, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: vr },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(
							`POLICY_BLOCKED: ${vr.code} — ${vr.message}${vr.path ? ` (${vr.path})` : ""}`,
						);
					}
				}
			}

			if (descriptor.capabilities.includes("write")) {
				const paths = extractPaths(tool.name, p, opts.workdir);
				for (const abs of paths) {
					const vr = opts.policy.checkWrite(abs);
					if (vr) {
						opts.cbs.onBlocked(vr, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: vr },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(`POLICY_BLOCKED: ${vr.code} — ${vr.message}`);
					}
				}
				let needApproval = opts.autonomy === "supervised";
				if (needApproval) {
					needApproval =
						descriptor.capabilities.includes("write") ||
						opts.policy.exceedsFileBudget(maxFiles) ||
						opts.policy.exceedsLineBudget(maxLines);
				}
				if (opts.autonomy === "supervised" && needApproval) {
					const ok = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: tool.name,
						action: `${tool.name} (${paths.join(", ") || "paths from params"})`,
						paths,
						command: null,
						reason: opts.policy.exceedsFileBudget(maxFiles)
							? "supervised: exceeds max files threshold"
							: opts.policy.exceedsLineBudget(maxLines)
								? "supervised: exceeds max lines threshold"
								: `supervised: ${tool.name} requires approval`,
						cbs: opts.cbs,
					});
					if (!ok) {
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: {
								tool: tool.name,
								violation: {
									code: "approval_denied",
									message: "Operator denied",
								},
							},
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult("APPROVAL_DENIED: operator rejected action");
					}
				}
				if (
					opts.validationGate?.requiresApprovalForFurtherMutation === true &&
					(opts.autonomy === "supervised" || opts.autonomy === "active")
				) {
					const okAfterFail = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: tool.name,
						action: `${tool.name} after failing validation`,
						paths,
						command: null,
						reason: "write after validation failure requires approval",
						cbs: opts.cbs,
					});
					if (!okAfterFail) {
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult("APPROVAL_DENIED");
					}
				}
			}

			if (descriptor.capabilities.includes("delete")) {
				const paths = extractPaths(tool.name, p, opts.workdir);
				for (const abs of paths) {
					const vr = opts.policy.checkDelete(abs);
					if (vr) {
						opts.cbs.onBlocked(vr, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: vr },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(`POLICY_BLOCKED: ${vr.code} — ${vr.message}`);
					}
				}
			}

			if (descriptor.capabilities.includes("shell")) {
				const cmd = typeof p.command === "string" ? p.command : "";
				const shellCaps = classifyShellCommandCapabilities(cmd);
				const needPkgApproval = opts.autonomy === "supervised";
				const bv = opts.policy.checkBash(cmd, needPkgApproval);
				if (bv) {
					opts.cbs.onBlocked(bv, tool.name, opts.agentName);
					await opts.session.emit({
						correlation_id: opts.session.correlationBase,
						event_type: "policy_blocked",
						agent: opts.agentName,
						parent_agent: null,
						team: opts.team,
						payload: { tool: tool.name, violation: bv },
					});
					opts.cbs.onToolEnd(tool.name, opts.agentName, false);
					return textResult(`POLICY_BLOCKED: ${bv.code} — ${bv.message}`);
				}
				const shellIntentResult = collectShellIntents(cmd, opts.workdir);
				if (!shellIntentResult.ok) {
					const violation = {
						code: shellIntentResult.code,
						message: shellIntentResult.message,
					} satisfies Violation;
					opts.cbs.onBlocked(violation, tool.name, opts.agentName);
					await opts.session.emit({
						correlation_id: opts.session.correlationBase,
						event_type: "policy_blocked",
						agent: opts.agentName,
						parent_agent: null,
						team: opts.team,
						payload: { tool: tool.name, violation },
					});
					opts.cbs.onToolEnd(tool.name, opts.agentName, false);
					return textResult(
						`POLICY_BLOCKED: ${violation.code} — ${violation.message}`,
					);
				}
				const shellReadPaths = shellIntentResult.intents
					.filter((intent) => intent.kind === "read")
					.map((intent) => intent.path);
				const shellWritePaths = shellIntentResult.intents
					.filter((intent) => intent.kind === "write")
					.map((intent) => intent.path);
				const shellDeletePaths = shellIntentResult.intents
					.filter((intent) => intent.kind === "delete")
					.map((intent) => intent.path);
				for (const abs of shellReadPaths) {
					const rv = opts.policy.checkRead(abs, opts.readableRel);
					if (rv) {
						opts.cbs.onBlocked(rv, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: rv },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(`POLICY_BLOCKED: ${rv.code} — ${rv.message}`);
					}
				}
				for (const abs of shellWritePaths) {
					const wv = opts.policy.checkWrite(abs);
					if (wv) {
						opts.cbs.onBlocked(wv, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: wv },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(`POLICY_BLOCKED: ${wv.code} — ${wv.message}`);
					}
				}
				for (const abs of shellDeletePaths) {
					const dv = opts.policy.checkDelete(abs);
					if (dv) {
						opts.cbs.onBlocked(dv, tool.name, opts.agentName);
						await opts.session.emit({
							correlation_id: opts.session.correlationBase,
							event_type: "policy_blocked",
							agent: opts.agentName,
							parent_agent: null,
							team: opts.team,
							payload: { tool: tool.name, violation: dv },
						});
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult(`POLICY_BLOCKED: ${dv.code} — ${dv.message}`);
					}
				}
				if (
					opts.autonomy === "supervised" &&
					(shellCaps.has("package") || shellWritePaths.length > 0)
				) {
					const ok = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: "bash",
						action:
							shellWritePaths.length > 0
								? `shell write (${shellWritePaths.join(", ")})`
								: "package manager / install",
						paths: shellWritePaths,
						command: cmd,
						reason:
							shellWritePaths.length > 0
								? "supervised: shell write requires approval"
								: "supervised: package manager command",
						cbs: opts.cbs,
					});
					if (!ok) {
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult("APPROVAL_DENIED");
					}
				}
				const gitCommitNeedsApproval =
					opts.cfg.git?.commits_enabled === true &&
					opts.cfg.git?.require_approval_before_commit !== false;
				if (
					(opts.autonomy === "supervised" || opts.autonomy === "active") &&
					gitCommitNeedsApproval &&
					shellCaps.has("git") &&
					/\bgit\s+commit\b/.test(cmd)
				) {
					const okCommit = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: "bash",
						action: "git commit",
						paths: [],
						command: cmd,
						reason: "supervised: git commit requires explicit approval",
						cbs: opts.cbs,
					});
					if (!okCommit) {
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult("APPROVAL_DENIED");
					}
				}
				if (
					(opts.autonomy === "supervised" || opts.autonomy === "active") &&
					shellDeletePaths.length > 0
				) {
					const okRm = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: "bash",
						action: "delete / rm / unlink",
						paths: shellDeletePaths,
						command: cmd,
						reason: "delete or removal shell command requires approval",
						cbs: opts.cbs,
					});
					if (!okRm) {
						opts.cbs.onToolEnd(tool.name, opts.agentName, false);
						return textResult("APPROVAL_DENIED");
					}
				}
				if (
					opts.validationGate?.requiresApprovalForFurtherMutation === true &&
					(opts.autonomy === "supervised" || opts.autonomy === "active")
				) {
					const bashMutation =
						shellWritePaths.length > 0 ||
						shellDeletePaths.length > 0 ||
						shellCaps.has("git") ||
						shellCaps.has("package") ||
						shellCaps.has("config");
					if (bashMutation) {
						const okAfterValidationFail = await gateSupervisedMutation({
							session: opts.session,
							agentName: opts.agentName,
							team: opts.team,
							tool: "bash",
							action: "mutating bash after validation failure",
							paths: [...shellWritePaths, ...shellDeletePaths],
							command: cmd,
							reason: "validation failure occurred earlier in this turn",
							cbs: opts.cbs,
						});
						if (!okAfterValidationFail) {
							opts.cbs.onToolEnd(tool.name, opts.agentName, false);
							return textResult("APPROVAL_DENIED");
						}
					}
				}
			}

			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);
				if (tool.name === "write" || tool.name === "edit") {
					const paths = extractPaths(tool.name, p, opts.workdir);
					for (const abs of paths) opts.policy.noteFileTouch(abs, 10);
				}
				if (tool.name === "bash") {
					const cmd = typeof p.command === "string" ? p.command : "";
					const shellIntentResult = collectShellIntents(cmd, opts.workdir);
					if (shellIntentResult.ok) {
						for (const intent of shellIntentResult.intents) {
							if (intent.kind === "write" || intent.kind === "delete") {
								opts.policy.noteFileTouch(intent.path, 10);
							}
						}
					}
				}
				opts.cbs.onToolEnd(tool.name, opts.agentName, true);
				await opts.session.emit({
					correlation_id: opts.session.correlationBase,
					event_type: "tool_completed",
					agent: opts.agentName,
					parent_agent: null,
					team: opts.team,
					payload: { tool: tool.name, ok: true },
				});
				return result;
			} catch (e) {
				if (e instanceof TurnCancelledError) throw e;
				opts.cbs.onToolEnd(tool.name, opts.agentName, false);
				await opts.session.emit({
					correlation_id: opts.session.correlationBase,
					event_type: "agent_failed",
					agent: opts.agentName,
					parent_agent: null,
					team: opts.team,
					payload: { tool: tool.name, error: String(e) },
				});
				throw e;
			}
		},
	}));
}

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
		const tokens = chunk.split(/\s+/).filter(Boolean);
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
				for (const abs of extractDeletePathsFromCommand(cmd, opts.workdir)) {
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
				if (opts.autonomy === "supervised" && shellCaps.has("package")) {
					const ok = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: "bash",
						action: "package manager / install",
						paths: [],
						command: cmd,
						reason: "supervised: package manager command",
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
					shellCaps.has("delete")
				) {
					const okRm = await gateSupervisedMutation({
						session: opts.session,
						agentName: opts.agentName,
						team: opts.team,
						tool: "bash",
						action: "delete / rm / unlink",
						paths: [],
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
						shellCaps.has("git") ||
						shellCaps.has("package") ||
						shellCaps.has("delete") ||
						shellCaps.has("config");
					if (bashMutation) {
						const okAfterValidationFail = await gateSupervisedMutation({
							session: opts.session,
							agentName: opts.agentName,
							team: opts.team,
							tool: "bash",
							action: "mutating bash after validation failure",
							paths: [],
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

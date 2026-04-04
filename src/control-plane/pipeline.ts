import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "fs-extra";
import {
	TurnCancelledError,
	resetSessionApprovals,
	setSessionAutoApproveForTests,
} from "../agents/approval-queue.js";
import { applyExpertiseAfterTurn } from "../agents/expertise-writer.js";
import type { MediationCallbacks } from "../agents/mediated-tools.js";
import { runAgentTurn } from "../agents/run-agent.js";
import type { RunAgentParams } from "../agents/run-agent.js";
import { PROJECT_ROOT, resolveFromRoot } from "../app/config-loader.js";
import {
	ensureSessionGitBranch,
	writeSessionArtifacts,
} from "../git/session-git.js";
import type { Multi_teamConfig, TeamConfig } from "../models/config-schema.js";
import type { TaskContract } from "../models/task-contracts.js";
import type { SessionContext } from "../sessions/session-context.js";
import { parseRouting } from "./routing.js";

function autonomyFor(
	globalA: Multi_teamConfig["global_autonomy"],
	override: "advisory" | "supervised" | "active" | undefined,
): "advisory" | "supervised" | "active" {
	return override ?? globalA;
}

function mediationFactory(
	session: SessionContext,
	onStatus: (agent: string, status: string) => void,
): MediationCallbacks {
	return {
		onToolStart: (tool, agent) => onStatus(agent, `tool:${tool}`),
		onToolEnd: (_t, agent, ok) => onStatus(agent, ok ? "thinking" : "error"),
		onBlocked: (_v, _t, agent) => onStatus(agent, "blocked"),
		onAwaitingApproval: (agent) => onStatus(agent, "awaiting_approval"),
	};
}

async function runAgentTurnSafe(
	session: SessionContext,
	params: RunAgentParams,
): Promise<Awaited<ReturnType<typeof runAgentTurn>>> {
	const t0 = Date.now();
	try {
		return await runAgentTurn(params);
	} catch (e) {
		if (e instanceof TurnCancelledError) {
			await session.emit({
				correlation_id: session.correlationBase,
				event_type: "turn_cancelled",
				agent: params.agentName,
				parent_agent: params.parentAgent,
				team: params.team,
				payload: { reason: String((e as Error).message || "cancel_turn") },
			});
		}
		throw e;
	} finally {
		session.recordAgentTurnTime({
			agent: params.agentName,
			team: params.team,
			role: params.role,
			elapsed_ms: Date.now() - t0,
		});
	}
}

class AgentTimeoutError extends Error {
	override name = "AgentTimeoutError";
}

function isTransientError(err: unknown): boolean {
	const s = String(err).toLowerCase();
	return (
		s.includes("rate limit") ||
		s.includes("timed out") ||
		s.includes("timeout") ||
		s.includes("temporarily unavailable") ||
		s.includes("econnreset")
	);
}

async function runWithReliability(
	session: SessionContext,
	params: RunAgentParams,
	timeoutMs: number,
	maxRetries = 1,
	onStatus?: (status: string) => void,
): Promise<Awaited<ReturnType<typeof runAgentTurn>>> {
	let attempt = 0;
	for (;;) {
		const controller = new AbortController();
		const startedAt = Date.now();
		let timedOut = false;
		const runPromise = runAgentTurnSafe(session, {
			...params,
			abortSignal: controller.signal,
		});
		try {
			const result = await Promise.race([
				runPromise,
				(async () => {
					await sleep(timeoutMs);
					timedOut = true;
					controller.abort();
					onStatus?.("timeout");
					await session.emit({
						correlation_id: session.correlationBase,
						event_type: "agent_timeout",
						agent: params.agentName,
						parent_agent: params.parentAgent,
						team: params.team,
						payload: { timeout_ms: timeoutMs, attempt },
					});
					await session.emit({
						correlation_id: session.correlationBase,
						event_type: "agent_abandoned",
						agent: params.agentName,
						parent_agent: params.parentAgent,
						team: params.team,
						payload: { reason: "timeout", timeout_ms: timeoutMs, attempt },
					});
					onStatus?.("abandoned");
					throw new AgentTimeoutError(
						`Agent ${params.agentName} timed out after ${timeoutMs}ms`,
					);
				})(),
			]);
			return result;
		} catch (e) {
			if (timedOut) {
				void runPromise
					.then(async () => {
						await session.emit({
							correlation_id: session.correlationBase,
							event_type: "late_result_ignored",
							agent: params.agentName,
							parent_agent: params.parentAgent,
							team: params.team,
							payload: { attempt, elapsed_ms: Date.now() - startedAt },
						});
					})
					.catch(async (lateErr) => {
						await session.emit({
							correlation_id: session.correlationBase,
							event_type: "late_result_ignored",
							agent: params.agentName,
							parent_agent: params.parentAgent,
							team: params.team,
							payload: {
								attempt,
								elapsed_ms: Date.now() - startedAt,
								error: String(lateErr),
							},
						});
					});
			}
			const canRetry = attempt < maxRetries && isTransientError(e);
			onStatus?.(e instanceof TurnCancelledError ? "cancelled" : "error");
			await session.emit({
				correlation_id: session.correlationBase,
				event_type: "agent_failed",
				agent: params.agentName,
				parent_agent: params.parentAgent,
				team: params.team,
				payload: {
					error: String(e),
					attempt,
					retry: canRetry,
				},
			});
			if (!canRetry) throw e;
			attempt += 1;
			await sleep(400 * attempt);
		}
	}
}

async function validateEnvelopeArtifacts(opts: {
	session: SessionContext;
	agentName: string;
	team: string | null;
	parentAgent: string | null;
	taskContract: TaskContract;
	result: Awaited<ReturnType<typeof runAgentTurn>>;
}): Promise<Awaited<ReturnType<typeof runAgentTurn>>> {
	const { result } = opts;
	if (!result.envelope) return result;
	const wantsRequired = opts.taskContract.artifact_policy === "required";
	const wantsForbidden = opts.taskContract.artifact_policy === "forbidden";
	const artifacts = result.envelope.artifacts ?? [];
	const requiresValidationResult = opts.taskContract.task_type === "validate";
	const validationResult = result.envelope.validation_result;
	const exists = await Promise.all(
		artifacts.map(async (a) => ({ path: a, ok: await fs.pathExists(a) })),
	);
	const missing = exists.filter((x) => !x.ok).map((x) => x.path);
	const validationArtifacts = validationResult?.artifacts ?? [];
	const validationArtifactExistence = await Promise.all(
		validationArtifacts.map(async (a) => ({
			path: a,
			ok: await fs.pathExists(a),
		})),
	);
	const missingValidationArtifacts = validationArtifactExistence
		.filter((x) => !x.ok)
		.map((x) => x.path);
	const wrongTaskType =
		result.envelope.task_type !== opts.taskContract.task_type;
	const missingValidationResult = requiresValidationResult && !validationResult;
	const policyViolation =
		(wantsRequired && artifacts.length === 0) ||
		(wantsForbidden && artifacts.length > 0) ||
		missing.length > 0 ||
		wrongTaskType ||
		missingValidationResult ||
		missingValidationArtifacts.length > 0;
	if (policyViolation) {
		await opts.session.emit({
			correlation_id: opts.session.correlationBase,
			event_type: "contract_error",
			agent: opts.agentName,
			parent_agent: opts.parentAgent,
			team: opts.team,
			payload: {
				phase: "artifact_check",
				task_contract: opts.taskContract,
				error: wrongTaskType
					? `task_type_mismatch:${result.envelope.task_type}`
					: wantsForbidden
						? "artifacts_forbidden_but_present"
						: missingValidationResult
							? "missing_validation_result"
							: missingValidationArtifacts.length > 0
								? `missing_validation_artifacts:${missingValidationArtifacts.join(",")}`
								: artifacts.length === 0
									? "empty_artifacts_for_required_task"
									: `missing_artifacts:${missing.join(",")}`,
			},
		});
		return {
			...result,
			contract_error: true,
			envelope: {
				...result.envelope,
				status: "failed",
				blockers: [
					...result.envelope.blockers,
					wrongTaskType
						? `task_type mismatch expected=${opts.taskContract.task_type} actual=${result.envelope.task_type}`
						: wantsForbidden
							? "artifacts were produced but forbidden by policy"
							: missingValidationResult
								? "validation task must include structured validation_result"
								: missingValidationArtifacts.length > 0
									? `missing validation artifacts: ${missingValidationArtifacts.join(", ")}`
									: artifacts.length === 0
										? "required artifacts were empty"
										: `missing artifacts: ${missing.join(", ")}`,
				],
			},
		};
	}
	return result;
}

function taskForTeam(
	route: ReturnType<typeof parseRouting>,
	teamId: string,
): TaskContract {
	return (
		route.work_items.find((w) => w.task_id.includes(`task-${teamId}-`)) ??
		route.work_items.find((w) => w.task_id.includes(teamId)) ??
		route.work_items[0]
	);
}

export async function runUserMessage(opts: {
	cfg: Multi_teamConfig;
	session: SessionContext;
	userMessage: string;
	onAgentStatus: (agent: string, status: string) => void;
	onChat: (from: string, line: string) => void;
	approvalAutoAccept: boolean;
	onUsageDelta?: (agent: string, approxTokens: number) => void;
}): Promise<void> {
	const { cfg, session } = opts;
	const validationGate = { requiresApprovalForFurtherMutation: false };
	const repoRoot = resolveFromRoot(cfg, cfg.app.repo_root);
	const teamIds = cfg.teams.map((t) => t.id);
	const timeoutMs = cfg.app.default_timeout_ms ?? 900_000;

	await ensureSessionGitBranch({ cfg, repoRoot, session });

	resetSessionApprovals();
	if (opts.approvalAutoAccept) setSessionAutoApproveForTests(true);

	const route = parseRouting(opts.userMessage, teamIds);
	await session.emit({
		correlation_id: session.correlationBase,
		event_type: "user_message",
		agent: "user",
		parent_agent: null,
		team: null,
		payload: { text: opts.userMessage },
	});
	await session.appendConversation({
		role: "user",
		text: opts.userMessage,
		timestamp: new Date().toISOString(),
	});
	await session.emit({
		correlation_id: session.correlationBase,
		event_type: "routing_decision",
		agent: "orchestrator",
		parent_agent: null,
		team: null,
		payload: route,
	});
	await session.appendRouting(route);

	const orch = cfg.orchestrator;
	const orchAut = autonomyFor(cfg.global_autonomy, orch.autonomy);
	const orchWork = resolve(PROJECT_ROOT, orch.workdir ?? ".");
	const orchWritable = orch.domain.write.map((x) => x.replace(/^\.\//, ""));
	const orchDelete = orch.domain.delete?.map((x) => x.replace(/^\.\//, ""));

	const orchRes = await runWithReliability(
		session,
		{
			cfg,
			session,
			agentName: orch.name,
			team: null,
			role: "orchestrator",
			modelRef: orch.model,
			promptPath: orch.system_prompt,
			skillNames: orch.skills ?? [],
			writableRel: orchWritable,
			deleteRel: orchDelete,
			readableRel: orch.domain.read.map((x) => x.replace(/^\.\//, "")),
			expertiseWritable: orch.expertise?.writable ?? [],
			expertiseReadonly: orch.expertise?.readonly ?? [],
			workdir: orchWork,
			repoRoot,
			autonomy: orchAut,
			userPrompt: `Route: ${JSON.stringify(route)}.\nUser message:\n${opts.userMessage}\nGive a concise orchestration plan and which teams to activate. Do not emit JSON contract unless asked.`,
			requireEnvelope: false,
			parentAgent: null,
			cbs: mediationFactory(session, opts.onAgentStatus),
			validationGate,
		},
		timeoutMs,
		1,
		(status) => opts.onAgentStatus(orch.name, status),
	);

	opts.onChat("orchestrator", orchRes.text);
	await session.emit({
		correlation_id: session.correlationBase,
		event_type: "agent_completed",
		agent: orch.name,
		parent_agent: null,
		team: null,
		payload: { has_contract: Boolean(orchRes.envelope) },
	});

	await applyExpertiseAfterTurn({
		cfg,
		session,
		agentName: orch.name,
		team: null,
		expertiseWritable: orch.expertise?.writable ?? [],
		result: orchRes,
	});
	opts.onUsageDelta?.(orch.name, process.env.PI_MOCK === "1" ? 140 : 0);

	const enabledTeams = cfg.teams.filter(
		(t) => t.enabled && route.teams.includes(t.id),
	);
	const order = route.teams.filter((id) =>
		enabledTeams.some((t) => t.id === id),
	);

	const teamsOrdered = order
		.map((id) => enabledTeams.find((t) => t.id === id))
		.filter((t): t is TeamConfig => Boolean(t));

	const maxW = cfg.parallelism?.max_parallel_workers ?? 2;

	for (const team of teamsOrdered) {
		const lead = team.lead;
		const teamTask = taskForTeam(route, team.id);
		const leadAut = autonomyFor(cfg.global_autonomy, lead.autonomy);
		const leadWork = resolve(PROJECT_ROOT, lead.workdir ?? ".");
		const leadWritable = lead.domain.write.map((x) => x.replace(/^\.\//, ""));
		const leadDelete = lead.domain.delete?.map((x) => x.replace(/^\.\//, ""));

		await session.emit({
			correlation_id: session.correlationBase,
			event_type: "delegation_sent",
			agent: cfg.orchestrator.name,
			parent_agent: null,
			team: team.id,
			payload: { to: lead.name, task_contract: teamTask },
		});

		const leadResRaw = await runWithReliability(
			session,
			{
				cfg,
				session,
				agentName: lead.name,
				team: team.id,
				role: "lead",
				modelRef: lead.model,
				promptPath: lead.system_prompt,
				skillNames: lead.skills ?? [],
				writableRel: leadWritable,
				deleteRel: leadDelete,
				readableRel: lead.domain.read.map((x) => x.replace(/^\.\//, "")),
				expertiseWritable: lead.expertise?.writable ?? [],
				expertiseReadonly: lead.expertise?.readonly ?? [],
				workdir: leadWork,
				repoRoot,
				autonomy: leadAut,
				userPrompt: `Team ${team.id}. User message:\n${opts.userMessage}\nTask contract:\n${JSON.stringify(teamTask)}\nOrchestrator note:\n${orchRes.text.slice(0, 4000)}\nReturn ONLY the JSON contract as final message.`,
				requireEnvelope: true,
				parentAgent: cfg.orchestrator.name,
				cbs: mediationFactory(session, opts.onAgentStatus),
				taskContract: teamTask,
				validationGate,
			},
			timeoutMs,
			1,
			(status) => opts.onAgentStatus(lead.name, status),
		);
		const leadRes = await validateEnvelopeArtifacts({
			session,
			agentName: lead.name,
			team: team.id,
			parentAgent: cfg.orchestrator.name,
			taskContract: teamTask,
			result: leadResRaw,
		});

		await session.emit({
			correlation_id: session.correlationBase,
			event_type: "delegation_received",
			agent: lead.name,
			parent_agent: cfg.orchestrator.name,
			team: team.id,
			payload: {
				contract_error: leadRes.contract_error,
				envelope: leadRes.envelope,
				task_contract: teamTask,
			},
		});
		if (leadRes.envelope?.validation_result) {
			await session.emit({
				correlation_id: session.correlationBase,
				event_type: "validation_outcome",
				agent: lead.name,
				parent_agent: cfg.orchestrator.name,
				team: team.id,
				payload: {
					task_contract: teamTask,
					validation_result: leadRes.envelope.validation_result,
				},
			});
			if (
				leadRes.envelope.validation_result
					.requires_approval_for_further_mutation
			) {
				validationGate.requiresApprovalForFurtherMutation = true;
			}
		}
		opts.onChat(lead.name, leadRes.text);

		await applyExpertiseAfterTurn({
			cfg,
			session,
			agentName: lead.name,
			team: team.id,
			expertiseWritable: lead.expertise?.writable ?? [],
			result: leadRes,
		});
		opts.onUsageDelta?.(lead.name, process.env.PI_MOCK === "1" ? 140 : 0);

		const members = team.members;
		for (let i = 0; i < members.length; i += maxW) {
			const chunk = members.slice(i, i + maxW);
			const settled = await Promise.allSettled(
				chunk.map(async (member) => {
					const wAut = autonomyFor(cfg.global_autonomy, member.autonomy);
					const wWork = resolve(PROJECT_ROOT, member.workdir ?? ".");
					const wWritable = member.domain.write.map((x) =>
						x.replace(/^\.\//, ""),
					);
					const wDelete = member.domain.delete?.map((x) =>
						x.replace(/^\.\//, ""),
					);
					await session.emit({
						correlation_id: session.correlationBase,
						event_type: "delegation_sent",
						agent: lead.name,
						parent_agent: cfg.orchestrator.name,
						team: team.id,
						payload: { to: member.name, task_contract: teamTask },
					});
					const wrRaw = await runWithReliability(
						session,
						{
							cfg,
							session,
							agentName: member.name,
							team: team.id,
							role: "worker",
							modelRef: member.model,
							promptPath: member.system_prompt,
							skillNames: member.skills ?? [],
							writableRel: wWritable,
							deleteRel: wDelete,
							readableRel: member.domain.read.map((x) =>
								x.replace(/^\.\//, ""),
							),
							expertiseWritable: member.expertise?.writable ?? [],
							expertiseReadonly: member.expertise?.readonly ?? [],
							workdir: wWork,
							repoRoot,
							autonomy: wAut,
							userPrompt: `You are ${member.name} on team ${team.id}.\nTask contract:\n${JSON.stringify(teamTask)}\nParent lead output:\n${leadRes.text.slice(0, 6000)}\nOriginal user:\n${opts.userMessage}\nProduce artifact files under your allowed paths, then FINAL message ONLY JSON contract.`,
							requireEnvelope: true,
							parentAgent: lead.name,
							cbs: mediationFactory(session, opts.onAgentStatus),
							taskContract: teamTask,
							validationGate,
						},
						timeoutMs,
						1,
						(status) => opts.onAgentStatus(member.name, status),
					);
					const wr = await validateEnvelopeArtifacts({
						session,
						agentName: member.name,
						team: team.id,
						parentAgent: lead.name,
						taskContract: teamTask,
						result: wrRaw,
					});
					await session.emit({
						correlation_id: session.correlationBase,
						event_type: "delegation_received",
						agent: member.name,
						parent_agent: lead.name,
						team: team.id,
						payload: {
							contract_error: wr.contract_error,
							envelope: wr.envelope,
							task_contract: teamTask,
						},
					});
					if (wr.envelope?.validation_result) {
						await session.emit({
							correlation_id: session.correlationBase,
							event_type: "validation_outcome",
							agent: member.name,
							parent_agent: lead.name,
							team: team.id,
							payload: {
								task_contract: teamTask,
								validation_result: wr.envelope.validation_result,
							},
						});
						if (
							wr.envelope.validation_result
								.requires_approval_for_further_mutation
						) {
							validationGate.requiresApprovalForFurtherMutation = true;
						}
					}
					opts.onChat(member.name, wr.text);

					await applyExpertiseAfterTurn({
						cfg,
						session,
						agentName: member.name,
						team: team.id,
						expertiseWritable: member.expertise?.writable ?? [],
						result: wr,
					});
					opts.onUsageDelta?.(
						member.name,
						process.env.PI_MOCK === "1" ? 140 : 0,
					);
				}),
			);
			for (const r of settled) {
				if (r.status === "rejected") {
					opts.onChat(
						"system",
						`worker failure: ${String(r.reason).slice(0, 300)}`,
					);
				}
			}
		}
	}

	await writeSessionArtifacts({ session, repoRoot });
}

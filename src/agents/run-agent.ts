import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type AgentSession,
	AuthStorage,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createCodingTools,
	createExtensionRuntime,
	createReadOnlyTools,
} from "@mariozechner/pi-coding-agent";
import fs from "fs-extra";
import { PROJECT_ROOT } from "../app/config-loader.js";
import type { Multi_teamConfig } from "../models/config-schema.js";
import {
	REPAIR_PROMPT,
	parseDelegationEnvelope,
} from "../models/delegation.js";
import type { DelegationEnvelope } from "../models/delegation.js";
import type { TaskContract } from "../models/task-contracts.js";
import { PolicyEngine, type SessionMetrics } from "../policy/policy-engine.js";
import type { SessionContext } from "../sessions/session-context.js";
import {
	type MediationCallbacks,
	type ValidationGateState,
	wrapAgentTools,
} from "./mediated-tools.js";
import { resolveModel } from "./model-resolve.js";
import { buildSystemPrompt } from "./prompt-build.js";

function resourceLoaderFromPrompt(text: string): ResourceLoader {
	const rt = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: rt }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => text,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
		};
		if (m.role !== "assistant" || !m.content) continue;
		const chunks = m.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "");
		if (chunks.length) return chunks.join("");
	}
	return "";
}

export type RunAgentParams = {
	cfg: Multi_teamConfig;
	session: SessionContext;
	agentName: string;
	team: string | null;
	role: "orchestrator" | "lead" | "worker";
	modelRef: string;
	promptPath: string;
	skillNames: string[];
	writableRel: string[];
	deleteRel: string[] | undefined;
	readableRel: string[];
	expertiseWritable: string[];
	expertiseReadonly: string[];
	workdir: string;
	repoRoot: string;
	autonomy: "advisory" | "supervised" | "active";
	userPrompt: string;
	requireEnvelope: boolean;
	parentAgent: string | null;
	cbs: MediationCallbacks;
	taskContract?: TaskContract;
	abortSignal?: AbortSignal;
	validationGate?: ValidationGateState;
};

export async function runAgentTurn(p: RunAgentParams): Promise<{
	text: string;
	envelope?: DelegationEnvelope;
	contract_error?: boolean;
}> {
	const mock = process.env.PI_MOCK === "1";
	if (mock) {
		if (p.requireEnvelope && process.env.PI_MOCK_CONTRACT_ERROR === "1") {
			const bad = "mock-invalid-envelope";
			await p.session.emit({
				correlation_id: p.session.correlationBase,
				event_type: "contract_error",
				agent: p.agentName,
				parent_agent: p.parentAgent,
				team: p.team,
				payload: { phase: "first_parse", error: "mock_invalid_envelope" },
			});
			await p.session.emit({
				correlation_id: p.session.correlationBase,
				event_type: "contract_error",
				agent: p.agentName,
				parent_agent: p.parentAgent,
				team: p.team,
				payload: { phase: "after_repair", error: "mock_invalid_envelope" },
			});
			return { text: bad, contract_error: true };
		}
		const rel =
			p.role === "worker"
				? `artifacts/${p.agentName}.md`
				: "artifacts/mock.txt";
		const artifactPath = p.session.path(rel);
		const env: DelegationEnvelope = {
			task_type: p.taskContract?.task_type ?? "inspect",
			objective: "mock",
			status: "success",
			summary: "Mock run: no API call.",
			files_touched: [],
			artifacts: [artifactPath],
			blockers: [],
			next_step: "none",
			validation_result:
				p.taskContract?.task_type === "validate"
					? {
							validation_status: "pass",
							checks_run: ["mock-validation"],
							failed_checks: [],
							summary: "Mock validation passed",
							artifacts: [artifactPath],
							requires_approval_for_further_mutation: false,
						}
					: undefined,
		};
		await fs.ensureDir(join(p.session.root, "artifacts"));
		await fs.writeFile(
			artifactPath,
			`# Mock artifact\n\nagent: ${p.agentName}\nrole: ${p.role}\n`,
		);
		const text = JSON.stringify(env);
		return p.requireEnvelope
			? { text, envelope: env }
			: { text: "mock assistant" };
	}

	const model = resolveModel(p.modelRef) ?? resolveModel(p.cfg.models.worker);
	if (!model) throw new Error(`Unknown model ref: ${p.modelRef}`);

	const authStorage = AuthStorage.create(
		join(p.session.root, "agents", p.agentName, "auth.json"),
	);
	const modelRegistry = ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});

	const metrics: SessionMetrics = {
		filesTouched: new Set(),
		approxLinesChanged: 0,
	};
	const policy = new PolicyEngine(
		p.cfg,
		p.repoRoot,
		p.writableRel,
		p.deleteRel,
		p.autonomy,
		p.role,
		metrics,
	);

	const sys = await buildSystemPrompt({
		role: p.role,
		team: p.team,
		cfg: p.cfg,
		agentName: p.agentName,
		promptPath: p.promptPath,
		skillNames: p.skillNames,
		expertiseWritable: p.expertiseWritable,
		expertiseReadonly: p.expertiseReadonly,
		sessionRoot: p.session.root,
		contractInstructions: p.requireEnvelope,
	});

	const baseTools =
		p.autonomy === "advisory"
			? createReadOnlyTools(p.workdir)
			: createCodingTools(p.workdir);

	const tools = wrapAgentTools(baseTools, {
		workdir: p.workdir,
		repoRoot: p.repoRoot,
		readableRel: p.readableRel,
		policy,
		agentName: p.agentName,
		team: p.team,
		session: p.session,
		cfg: p.cfg,
		autonomy: p.autonomy,
		cbs: p.cbs,
		validationGate: p.validationGate,
	});

	const resourceLoader = resourceLoaderFromPrompt(sys);
	const smDir = join(p.session.root, "agents", p.agentName);
	await fs.ensureDir(smDir);

	const { session: pi } = await createAgentSession({
		cwd: p.workdir,
		agentDir: join(smDir, "agentdir"),
		model,
		thinkingLevel: "medium",
		authStorage,
		modelRegistry,
		tools,
		resourceLoader,
		sessionManager: SessionManager.create(smDir),
		settingsManager,
	});

	let textOut = "";
	pi.subscribe((ev) => {
		if (
			ev.type === "message_update" &&
			ev.assistantMessageEvent.type === "text_delta"
		) {
			textOut += ev.assistantMessageEvent.delta;
		}
	});

	if (p.abortSignal?.aborted) {
		await pi.abort();
		pi.dispose();
		throw new Error("aborted_before_prompt");
	}
	const onAbort = () => {
		void pi.abort();
	};
	p.abortSignal?.addEventListener("abort", onAbort, { once: true });
	try {
		await pi.prompt(p.userPrompt);
	} finally {
		p.abortSignal?.removeEventListener("abort", onAbort);
	}
	const finalText = textOut || lastAssistantText(pi.messages);

	if (!p.requireEnvelope) {
		pi.dispose();
		return { text: finalText };
	}

	const parsed = parseDelegationEnvelope(finalText);
	if (!parsed.ok) {
		await p.session.emit({
			correlation_id: p.session.correlationBase,
			event_type: "contract_error",
			agent: p.agentName,
			parent_agent: p.parentAgent,
			team: p.team,
			payload: {
				phase: "first_parse",
				error: parsed.error,
				sample: finalText.slice(0, 500),
			},
		});
	}
	pi.dispose();

	if (!parsed.ok) {
		const { session: pi2 } = await createAgentSession({
			cwd: p.workdir,
			agentDir: join(smDir, "agentdir-repair"),
			model,
			thinkingLevel: "low",
			authStorage,
			modelRegistry,
			tools,
			resourceLoader: resourceLoaderFromPrompt(
				`${sys}\n\n${REPAIR_PROMPT}\n\nPrevious invalid output:\n${finalText.slice(0, 8000)}`,
			),
			sessionManager: SessionManager.create(join(smDir, "repair")),
			settingsManager,
		});
		let repairOut = "";
		pi2.subscribe((ev) => {
			if (
				ev.type === "message_update" &&
				ev.assistantMessageEvent.type === "text_delta"
			) {
				repairOut += ev.assistantMessageEvent.delta;
			}
		});
		if (p.abortSignal?.aborted) {
			await pi2.abort();
			pi2.dispose();
			throw new Error("aborted_before_repair");
		}
		const onAbortRepair = () => {
			void pi2.abort();
		};
		p.abortSignal?.addEventListener("abort", onAbortRepair, { once: true });
		try {
			await pi2.prompt("Return only the JSON object.");
		} finally {
			p.abortSignal?.removeEventListener("abort", onAbortRepair);
		}
		const repairText = repairOut || lastAssistantText(pi2.messages);
		pi2.dispose();
		const parsed2 = parseDelegationEnvelope(repairText);
		if (!parsed2.ok) {
			await p.session.emit({
				correlation_id: p.session.correlationBase,
				event_type: "contract_error",
				agent: p.agentName,
				parent_agent: p.parentAgent,
				team: p.team,
				payload: { phase: "after_repair", error: parsed2.error },
			});
			return { text: repairText, contract_error: true };
		}
		return { text: repairText, envelope: parsed2.data };
	}
	return { text: finalText, envelope: parsed.data };
}

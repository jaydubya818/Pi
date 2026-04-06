import { z } from "zod";

const pathList = z.array(z.string());

const expertiseCfg = z.object({
	writable: z.array(z.string()).default([]),
	readonly: z.array(z.string()).default([]),
});

const domainCfg = z.object({
	read: pathList.default(["."]),
	write: pathList.default([]),
	delete: pathList.optional(),
});

const agentBase = z.object({
	name: z.string(),
	model: z.string(),
	system_prompt: z.string(),
	expertise: expertiseCfg.optional(),
	skills: z.array(z.string()).default([]),
	tools: z
		.union([z.array(z.string()), z.object({ delegate: z.boolean() })])
		.optional(),
	domain: domainCfg,
	autonomy: z.enum(["advisory", "supervised", "active"]).optional(),
	repo_root: z.string().optional(),
	workdir: z.string().optional(),
	/** Thinking level forwarded to the LLM. Defaults by role: orchestrator→"medium", lead→"medium", worker→"low". */
	thinking: z.enum(["off", "low", "medium", "high"]).optional(),
});

const teamMember = agentBase;

const teamLead = agentBase.extend({
	tools: z
		.union([z.array(z.string()), z.object({ delegate: z.boolean() })])
		.optional(),
});

const teamSchema = z.object({
	id: z.string(),
	color: z.string().optional(),
	enabled: z.boolean().default(true),
	lead: teamLead,
	members: z.array(teamMember).default([]),
});

export const multiTeamConfigSchema = z.object({
	app: z.object({
		name: z.string(),
		sessions_dir: z.string(),
		logs_dir: z.string().optional(),
		artifacts_dir: z.string().optional(),
		session_mode: z.enum(["per_request", "interactive"]).default("per_request"),
		default_show_workers: z.boolean().optional(),
		default_timeout_ms: z.number().optional(),
		repo_root: z.string().default("."),
	}),

	models: z.record(z.string(), z.string()),

	features: z
		.object({
			enable_replay: z.boolean().optional(),
			enable_worker_toggle: z.boolean().optional(),
			enable_memory_updates: z.boolean().optional(),
			enable_policy_enforcement: z.boolean().optional(),
			enable_cost_tracking: z.boolean().optional(),
		})
		.optional(),

	parallelism: z
		.object({
			max_parallel_workers: z.number().default(2),
		})
		.optional(),

	approval: z
		.object({
			max_files_touch: z.number().default(12),
			max_lines_changed: z.number().default(500),
		})
		.optional(),

	git: z
		.object({
			commits_enabled: z.boolean().default(false),
			create_session_branch: z.boolean().default(false),
			require_approval_before_commit: z.boolean().default(true),
			session_branch_prefix: z.string().default("pi-multi"),
		})
		.optional(),

	orchestrator: agentBase,

	global_autonomy: z
		.enum(["advisory", "supervised", "active"])
		.default("active"),

	teams: z.array(teamSchema),
});

export type Multi_teamConfig = z.infer<typeof multiTeamConfigSchema>;
export type TeamConfig = z.infer<typeof teamSchema>;
export type AgentDef = z.infer<typeof agentBase>;

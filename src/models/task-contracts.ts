import { z } from "zod";

export const taskTypeSchema = z.enum([
	"plan",
	"build",
	"validate",
	"inspect",
	"refactor",
	"review",
	"research",
]);

export const artifactPolicySchema = z.enum([
	"required",
	"optional",
	"forbidden",
]);

export const artifactKindSchema = z.enum([
	"plan",
	"report",
	"patch_manifest",
	"test_report",
	"risk_review",
	"diff_summary",
	"notes",
]);

export const taskContractSchema = z.object({
	task_id: z.string(),
	task_type: taskTypeSchema,
	artifact_policy: artifactPolicySchema,
	expected_artifact_kinds: z.array(artifactKindSchema).default([]),
});

export type TaskType = z.infer<typeof taskTypeSchema>;
export type ArtifactPolicy = z.infer<typeof artifactPolicySchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type TaskContract = z.infer<typeof taskContractSchema>;

export function defaultTaskTypeForTeam(teamId: string): TaskType {
	const t = teamId.toLowerCase();
	if (t.includes("plan")) return "plan";
	if (t.includes("engineer") || t.includes("build")) return "build";
	if (t.includes("validat") || t.includes("qa") || t.includes("security"))
		return "validate";
	if (t.includes("review")) return "review";
	if (t.includes("refactor")) return "refactor";
	if (t.includes("research")) return "research";
	return "inspect";
}

export function defaultContractForTeam(
	teamId: string,
	taskId: string,
): TaskContract {
	const taskType = defaultTaskTypeForTeam(teamId);
	if (taskType === "plan") {
		return {
			task_id: taskId,
			task_type: "plan",
			artifact_policy: "required",
			expected_artifact_kinds: ["plan", "notes"],
		};
	}
	if (taskType === "build") {
		return {
			task_id: taskId,
			task_type: "build",
			artifact_policy: "required",
			expected_artifact_kinds: ["patch_manifest", "diff_summary"],
		};
	}
	if (taskType === "validate") {
		return {
			task_id: taskId,
			task_type: "validate",
			artifact_policy: "required",
			expected_artifact_kinds: ["report", "test_report", "risk_review"],
		};
	}
	return {
		task_id: taskId,
		task_type: taskType,
		artifact_policy: "optional",
		expected_artifact_kinds: ["notes"],
	};
}

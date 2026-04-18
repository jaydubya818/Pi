export type SofieSeverity = "info" | "warn" | "blocker";
export type SofieVerdict = "continue" | "escalate";

export type SofieReviewInput = {
	userMessage: string;
	changedFiles: string[];
	policyViolationCount: number;
	approvalDenials: number;
	missingRequiredArtifacts: number;
	validationFailures: number;
	targetRepoRoot: string;
	harnessSessionRoot: string;
};

export type SofieFinding = {
	severity: SofieSeverity;
	code:
		| "validation_failure"
		| "missing_required_artifacts"
		| "approval_denied"
		| "policy_violation"
		| "scope_drift"
		| "clean_run"
		| "routine_guidance";
	message: string;
};

export type SofieReview = {
	verdict: SofieVerdict;
	findings: SofieFinding[];
	shouldEscalate: boolean;
	closureRecommendation: string;
	routineAnswer: string | null;
};

function hasScopeDrift(
	changedFiles: string[],
	targetRepoRoot: string,
): boolean {
	return changedFiles.some(
		(file) =>
			file.startsWith("src/") ||
			file.startsWith("config/") ||
			file.startsWith("extensions/") ||
			(!file.startsWith("web/") && targetRepoRoot.includes("AI_CEO")),
	);
}

function routineAnswerFor(message: string): string | null {
	const lower = message.toLowerCase();
	if (
		lower.includes("safe to continue") ||
		lower.includes("should we continue")
	) {
		return "Sofie: continue if validation has no failures, required artifacts are present, and no policy or approval blockers were recorded.";
	}
	if (lower.includes("close this") || lower.includes("ready to close")) {
		return "Sofie: closure is appropriate when the run stayed in scope, produced expected artifacts, and left no validation or policy blockers.";
	}
	if (lower.includes("scope") || lower.includes("in scope")) {
		return "Sofie: this workflow is in scope only for bounded review/operator/advisor guidance and the configured external target path.";
	}
	return null;
}

export function reviewSessionWithSofie(input: SofieReviewInput): SofieReview {
	const findings: SofieFinding[] = [];

	if (input.validationFailures > 0) {
		findings.push({
			severity: "blocker",
			code: "validation_failure",
			message: `Validation failures recorded: ${input.validationFailures}`,
		});
	}
	if (input.missingRequiredArtifacts > 0) {
		findings.push({
			severity: "blocker",
			code: "missing_required_artifacts",
			message: `Missing required artifacts: ${input.missingRequiredArtifacts}`,
		});
	}
	if (input.approvalDenials > 0) {
		findings.push({
			severity: "blocker",
			code: "approval_denied",
			message: `Approval denials recorded: ${input.approvalDenials}`,
		});
	}
	if (input.policyViolationCount > 0) {
		findings.push({
			severity: "blocker",
			code: "policy_violation",
			message: `Policy violations recorded: ${input.policyViolationCount}`,
		});
	}
	if (hasScopeDrift(input.changedFiles, input.targetRepoRoot)) {
		findings.push({
			severity: "warn",
			code: "scope_drift",
			message:
				"Observed file changes suggest possible drift outside the bounded external-target scope.",
		});
	}

	const routineAnswer = routineAnswerFor(input.userMessage);
	if (routineAnswer) {
		findings.push({
			severity: "info",
			code: "routine_guidance",
			message: routineAnswer,
		});
	}

	if (findings.length === 0) {
		findings.push({
			severity: "info",
			code: "clean_run",
			message: "No blockers detected from existing session artifacts.",
		});
	}

	const shouldEscalate = findings.some((f) => f.severity === "blocker");
	return {
		verdict: shouldEscalate ? "escalate" : "continue",
		findings,
		shouldEscalate,
		closureRecommendation: shouldEscalate
			? "Escalate through existing blocker/reporting flow."
			: "Proceed without human escalation; keep existing flow and artifacts unchanged.",
		routineAnswer,
	};
}

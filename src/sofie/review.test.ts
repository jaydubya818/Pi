#!/usr/bin/env tsx

import { reviewSessionWithSofie } from "./review.js";

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

const baseline = reviewSessionWithSofie({
	userMessage: "safe to continue?",
	changedFiles: [],
	policyViolationCount: 0,
	approvalDenials: 0,
	missingRequiredArtifacts: 0,
	validationFailures: 0,
	targetRepoRoot: "/repo/AI_CEO",
	harnessSessionRoot: "/repo/.runtime/sessions/x",
});
if (baseline.verdict !== "continue") fail("sofie baseline should continue");
if (!baseline.routineAnswer?.includes("continue")) {
	fail("sofie should answer safe-to-continue deterministically");
}

const closeReady = reviewSessionWithSofie({
	userMessage: "ready to close?",
	changedFiles: [],
	policyViolationCount: 0,
	approvalDenials: 0,
	missingRequiredArtifacts: 0,
	validationFailures: 0,
	targetRepoRoot: "/repo/AI_CEO",
	harnessSessionRoot: "/repo/.runtime/sessions/x",
});
if (!closeReady.routineAnswer?.includes("closure is appropriate")) {
	fail("sofie should answer ready-to-close deterministically");
}

const inScope = reviewSessionWithSofie({
	userMessage: "is this in scope?",
	changedFiles: [],
	policyViolationCount: 0,
	approvalDenials: 0,
	missingRequiredArtifacts: 0,
	validationFailures: 0,
	targetRepoRoot: "/repo/AI_CEO",
	harnessSessionRoot: "/repo/.runtime/sessions/x",
});
if (
	!inScope.routineAnswer?.includes(
		"in scope only for bounded review/operator/advisor guidance",
	)
) {
	fail("sofie should answer in-scope deterministically");
}

const blocked = reviewSessionWithSofie({
	userMessage: "ready to close?",
	changedFiles: ["src/cli/main.tsx"],
	policyViolationCount: 1,
	approvalDenials: 0,
	missingRequiredArtifacts: 0,
	validationFailures: 1,
	targetRepoRoot: "/repo/AI_CEO",
	harnessSessionRoot: "/repo/.runtime/sessions/x",
});
if (blocked.verdict !== "escalate") fail("sofie should escalate on blockers");
if (!blocked.findings.some((f) => f.code === "policy_violation")) {
	fail("sofie should record policy violation finding");
}

console.log("sofie-review: ok");

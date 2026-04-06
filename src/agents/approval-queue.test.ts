#!/usr/bin/env tsx

import type { SessionContext } from "../sessions/session-context.js";
import {
	getActiveApproval,
	resetApprovalQueue,
	resetSessionApprovals,
	submitApprovalDecision,
	waitForApproval,
} from "./approval-queue.js";

type CaseFailure = string;

function fakeSession(sessionId: string): SessionContext {
	return {
		sessionId,
		emit: async () => {},
	} as unknown as SessionContext;
}

async function main(): Promise<void> {
	const failures: CaseFailure[] = [];
	resetSessionApprovals();

	const s1 = fakeSession("s1");
	const s2 = fakeSession("s2");
	const req = {
		agent: "worker",
		team: "engineering",
		tool: "bash",
		action: "touch src/x.ts",
		paths: ["/tmp/x"],
		command: "touch src/x.ts",
		reason: "test",
	};

	const p1 = waitForApproval({ session: s1, req: { ...req, agent: "one" } });
	const p2 = waitForApproval({ session: s2, req: { ...req, agent: "two" } });

	if (getActiveApproval()?.agent !== "one") {
		failures.push(
			"expected FIFO approval queue to expose first pending request",
		);
	}

	await submitApprovalDecision("approve_once");
	const r1 = await p1;
	if (!r1.allowed) failures.push("approve_once should resolve first request");
	if (getActiveApproval()?.agent !== "two") {
		failures.push(
			"expected second request to remain pending after first approval",
		);
	}

	await submitApprovalDecision("approve_session");
	const r2 = await p2;
	if (!r2.allowed)
		failures.push("approve_session should resolve second request");

	resetApprovalQueue();
	const r3 = await waitForApproval({
		session: s2,
		req: { ...req, agent: "three" },
	});
	if (!r3.allowed) {
		failures.push(
			"session-scoped auto approval should persist after queue reset for the same session",
		);
	}

	const pStale = waitForApproval({
		session: s1,
		req: { ...req, agent: "stale" },
	});
	if (getActiveApproval()?.agent !== "stale") {
		failures.push("stale request should become the active approval");
	}
	resetApprovalQueue();
	const stale = await pStale;
	if (!("cancelTurn" in stale && stale.cancelTurn)) {
		failures.push("queue reset should cancel pending approvals");
	}
	if (getActiveApproval() !== null) {
		failures.push("queue reset should clear the active approval");
	}

	const p4 = waitForApproval({
		session: s1,
		req: { ...req, agent: "four" },
	});
	if (getActiveApproval()?.agent !== "four") {
		failures.push("approve_session should not leak to a different session");
	}
	await submitApprovalDecision("deny");
	const r4 = await p4;
	if (!("denied" in r4 && r4.denied)) {
		failures.push("deny should resolve with denied outcome");
	}

	resetSessionApprovals();

	// cancel_turn as a direct decision (not via resetApprovalQueue)
	const p5 = waitForApproval({ session: s1, req: { ...req, agent: "five" } });
	if (getActiveApproval()?.agent !== "five") {
		failures.push("cancel_turn direct: expected pending request to be active");
	}
	await submitApprovalDecision("cancel_turn");
	const r5 = await p5;
	if (!("cancelTurn" in r5 && r5.cancelTurn)) {
		failures.push(
			"cancel_turn decision should resolve with cancelTurn outcome",
		);
	}
	if (getActiveApproval() !== null) {
		failures.push("cancel_turn should clear active approval");
	}

	// approve_once should NOT persist to subsequent requests from same session
	const p6 = waitForApproval({ session: s1, req: { ...req, agent: "six-a" } });
	await submitApprovalDecision("approve_once");
	const r6a = await p6;
	if (!r6a.allowed)
		failures.push("approve_once: first request should be allowed");
	const p7 = waitForApproval({ session: s1, req: { ...req, agent: "six-b" } });
	if (getActiveApproval()?.agent !== "six-b") {
		failures.push("approve_once should not persist; next request must queue");
	}
	resetApprovalQueue();
	await p7; // drain

	resetSessionApprovals();

	if (failures.length > 0) {
		process.stderr.write(`approval-queue: ${failures.length} failure(s)\n`);
		for (const failure of failures) process.stderr.write(`- ${failure}\n`);
		process.exit(1);
	}
	process.stdout.write("approval-queue: ok\n");
}

void main();

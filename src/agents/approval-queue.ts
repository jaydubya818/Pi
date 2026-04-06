import type { SessionContext } from "../sessions/session-context.js";
import { newCorrelationId } from "../utils/ids.js";

export type ApprovalDecision =
	| "approve_once"
	| "deny"
	| "approve_session"
	| "cancel_turn";

export type RichApprovalRequest = {
	agent: string;
	team: string | null;
	tool: string;
	action: string;
	paths: string[];
	command: string | null;
	reason: string;
};

export type ApprovalOutcome =
	| { allowed: true }
	| { allowed: false; denied: true }
	| { allowed: false; cancelTurn: true };

export class TurnCancelledError extends Error {
	override name = "TurnCancelledError";
	constructor(message = "cancel_turn") {
		super(message);
	}
}

let uiNotifier: (() => void) | null = null;
const sessionAutoApprove = new Set<string>();
let testAutoApproveAll = false;

type Pending = {
	req: RichApprovalRequest;
	correlationId: string;
	resolve: (o: ApprovalOutcome) => void;
	session: SessionContext;
};

const pendingQueue: Pending[] = [];

function resolvePendingQueue(outcome: ApprovalOutcome): void {
	while (pendingQueue.length > 0) {
		pendingQueue.shift()?.resolve(outcome);
	}
	uiNotifier?.();
}

export function setApprovalUiNotifier(fn: (() => void) | null): void {
	uiNotifier = fn;
}

export function resetSessionApprovals(): void {
	resolvePendingQueue({ allowed: false, cancelTurn: true });
	sessionAutoApprove.clear();
	testAutoApproveAll = false;
}

export function setSessionAutoApproveForTests(v: boolean): void {
	testAutoApproveAll = v;
}

export function resetApprovalQueue(): void {
	resolvePendingQueue({ allowed: false, cancelTurn: true });
}

function isSessionAutoApproved(sessionId: string): boolean {
	return testAutoApproveAll || sessionAutoApprove.has(sessionId);
}

export function getActiveApproval():
	| (RichApprovalRequest & { correlationId: string })
	| null {
	const pending = pendingQueue[0];
	if (!pending) return null;
	return { ...pending.req, correlationId: pending.correlationId };
}

export async function waitForApproval(opts: {
	session: SessionContext;
	req: RichApprovalRequest;
}): Promise<ApprovalOutcome> {
	if (isSessionAutoApproved(opts.session.sessionId)) return { allowed: true };
	const correlationId = newCorrelationId();
	await opts.session.emit({
		correlation_id: correlationId,
		event_type: "approval_requested",
		agent: opts.req.agent,
		parent_agent: null,
		team: opts.req.team,
		session_id: opts.session.sessionId,
		payload: {
			tool: opts.req.tool,
			action: opts.req.action,
			paths: opts.req.paths,
			command: opts.req.command,
			reason: opts.req.reason,
		},
	});
	return new Promise((resolve) => {
		pendingQueue.push({
			req: opts.req,
			correlationId,
			resolve,
			session: opts.session,
		});
		uiNotifier?.();
	});
}

export async function submitApprovalDecision(
	decision: ApprovalDecision,
): Promise<void> {
	const pending = pendingQueue.shift();
	if (!pending) return;
	const { req, correlationId, resolve, session } = pending;
	uiNotifier?.();

	let outcome: ApprovalOutcome;
	if (decision === "approve_once") outcome = { allowed: true };
	else if (decision === "approve_session") {
		sessionAutoApprove.add(session.sessionId);
		outcome = { allowed: true };
	} else if (decision === "deny") outcome = { allowed: false, denied: true };
	else outcome = { allowed: false, cancelTurn: true };

	await session.emit({
		correlation_id: correlationId,
		event_type: "approval_resolved",
		agent: req.agent,
		parent_agent: null,
		team: req.team,
		session_id: session.sessionId,
		payload: {
			decision,
			outcome: outcome.allowed
				? "allowed"
				: "cancelTurn" in outcome && outcome.cancelTurn
					? "cancel_turn"
					: "denied",
		},
	});

	resolve(outcome);
}

export async function askApprovalResolved(
	session: SessionContext,
	req: RichApprovalRequest,
): Promise<ApprovalOutcome> {
	return waitForApproval({ session, req });
}

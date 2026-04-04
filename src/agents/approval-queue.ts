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

let sessionAutoApprove = false;
let uiNotifier: (() => void) | null = null;

type Pending = {
	req: RichApprovalRequest;
	correlationId: string;
	resolve: (o: ApprovalOutcome) => void;
	session: SessionContext;
};

let pending: Pending | null = null;

export function setApprovalUiNotifier(fn: (() => void) | null): void {
	uiNotifier = fn;
}

export function resetSessionApprovals(): void {
	sessionAutoApprove = false;
}

export function setSessionAutoApproveForTests(v: boolean): void {
	sessionAutoApprove = v;
}

export function getActiveApproval():
	| (RichApprovalRequest & { correlationId: string })
	| null {
	if (!pending) return null;
	return { ...pending.req, correlationId: pending.correlationId };
}

export async function waitForApproval(opts: {
	session: SessionContext;
	req: RichApprovalRequest;
}): Promise<ApprovalOutcome> {
	if (sessionAutoApprove) return { allowed: true };
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
		pending = { req: opts.req, correlationId, resolve, session: opts.session };
		uiNotifier?.();
	});
}

export async function submitApprovalDecision(
	decision: ApprovalDecision,
): Promise<void> {
	if (!pending) return;
	const { req, correlationId, resolve, session } = pending;
	pending = null;
	uiNotifier?.();

	let outcome: ApprovalOutcome;
	if (decision === "approve_once") outcome = { allowed: true };
	else if (decision === "approve_session") {
		sessionAutoApprove = true;
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

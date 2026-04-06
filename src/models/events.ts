import { z } from "zod";

export const EVENT_SCHEMA_VERSION = "1";

export const eventTypes = z.enum([
	"user_message",
	"routing_decision",
	"delegation_sent",
	"delegation_received",
	"tool_started",
	"tool_completed",
	"policy_blocked",
	"contract_error",
	"agent_completed",
	"agent_failed",
	"agent_timeout",
	"agent_abandoned",
	"late_result_ignored",
	"session_summary_written",
	"approval_requested",
	"approval_resolved",
	"turn_cancelled",
	"expertise_updated",
	"git_branch_created",
	"validation_outcome",
	"tool_output_truncated",
	"context_token_warning",
]);

export type EventType = z.infer<typeof eventTypes>;

export const sessionEventSchema = z.object({
	schema_version: z.literal(EVENT_SCHEMA_VERSION),
	timestamp: z.string(),
	session_id: z.string(),
	correlation_id: z.string(),
	event_type: eventTypes,
	agent: z.string(),
	parent_agent: z.string().nullable(),
	team: z.string().nullable(),
	payload: z.record(z.unknown()),
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export function makeEvent(
	p: Omit<SessionEvent, "schema_version" | "timestamp">,
): SessionEvent {
	return {
		schema_version: EVENT_SCHEMA_VERSION,
		timestamp: new Date().toISOString(),
		...p,
	};
}

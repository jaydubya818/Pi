import { join } from "node:path";
import fs from "fs-extra";
import type { Multi_teamConfig } from "../models/config-schema.js";
import { type SessionEvent, makeEvent } from "../models/events.js";
import { appendJsonl } from "../utils/jsonl.js";

export type AgentTurnTiming = {
	agent: string;
	team: string | null;
	role: string;
	elapsed_ms: number;
};

export class SessionContext {
	readonly sessionId: string;
	readonly root: string;
	readonly correlationBase: string;
	private turnTimings: AgentTurnTiming[] = [];

	constructor(
		readonly cfg: Multi_teamConfig,
		sessionId: string,
		baseDir: string,
		correlationBase: string,
	) {
		this.sessionId = sessionId;
		this.root = join(baseDir, sessionId);
		this.correlationBase = correlationBase;
	}

	async init(): Promise<void> {
		await fs.ensureDir(this.root);
		const sub = [
			"artifacts",
			"plans",
			"validation",
			"transcripts",
			"prompts",
			"memory_snapshots",
			"agents",
		];
		for (const s of sub) await fs.ensureDir(join(this.root, s));
		await fs.writeJson(
			join(this.root, "topology.json"),
			{ session_id: this.sessionId },
			{ spaces: 2 },
		);
	}

	path(name: string): string {
		return join(this.root, name);
	}

	async emit(
		p: Omit<SessionEvent, "schema_version" | "timestamp" | "session_id"> & {
			session_id?: string;
		},
	): Promise<void> {
		const ev = makeEvent({
			session_id: p.session_id ?? this.sessionId,
			correlation_id: p.correlation_id,
			event_type: p.event_type,
			agent: p.agent,
			parent_agent: p.parent_agent,
			team: p.team,
			payload: p.payload,
		});
		await appendJsonl(this.path("events.jsonl"), ev);
	}

	async appendConversation(line: Record<string, unknown>): Promise<void> {
		await appendJsonl(this.path("conversation.jsonl"), line);
	}

	async appendRouting(line: Record<string, unknown>): Promise<void> {
		await appendJsonl(this.path("routing-decisions.jsonl"), line);
	}

	recordAgentTurnTime(row: AgentTurnTiming): void {
		this.turnTimings.push(row);
	}

	getTurnTimings(): readonly AgentTurnTiming[] {
		return this.turnTimings;
	}
}

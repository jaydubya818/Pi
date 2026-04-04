import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import fs from "fs-extra";

export type ReplayRow = {
	timestamp: string;
	source: "events" | "conversation";
	agent?: string | null;
	team?: string | null;
	eventType?: string;
	role?: string;
	summary: string;
	payload: unknown;
};

function pickTs(o: Record<string, unknown>): string {
	return typeof o.timestamp === "string"
		? o.timestamp
		: typeof o.ts === "string"
			? o.ts
			: "";
}

async function readJsonl(path: string): Promise<unknown[]> {
	if (!(await fs.pathExists(path))) return [];
	const out: unknown[] = [];
	const rl = createInterface({
		input: createReadStream(path),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		try {
			out.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	return out;
}

export async function loadReplayTimeline(
	sessionDir: string,
): Promise<ReplayRow[]> {
	const dir = resolve(sessionDir);
	const events = (await readJsonl(`${dir}/events.jsonl`)) as Record<
		string,
		unknown
	>[];
	const conv = (await readJsonl(`${dir}/conversation.jsonl`)) as Record<
		string,
		unknown
	>[];

	const rows: ReplayRow[] = [];
	for (const e of events) {
		const et = typeof e.event_type === "string" ? e.event_type : "unknown";
		const summary = summarizeEvent(et, e);
		rows.push({
			timestamp: pickTs(e),
			source: "events",
			agent: (e.agent as string) ?? null,
			team: (e.team as string) ?? null,
			eventType: et,
			summary,
			payload: e.payload,
		});
	}
	for (const c of conv) {
		const role = typeof c.role === "string" ? c.role : "?";
		const text =
			typeof c.text === "string"
				? c.text
				: typeof c.content === "string"
					? c.content
					: JSON.stringify(c).slice(0, 200);
		rows.push({
			timestamp:
				(typeof c.timestamp === "string" ? c.timestamp : "") ||
				pickTs(c) ||
				"1970-01-01T00:00:00.000Z",
			source: "conversation",
			role,
			summary: `[${role}] ${text.slice(0, 500)}`,
			payload: c,
		});
	}
	rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	return rows;
}

function summarizeEvent(et: string, e: Record<string, unknown>): string {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	switch (et) {
		case "policy_blocked":
			return `POLICY: ${JSON.stringify(p.violation ?? p).slice(0, 400)}`;
		case "contract_error":
			return `CONTRACT: ${JSON.stringify(p).slice(0, 400)}`;
		case "approval_requested":
			return `APPROVAL: ${JSON.stringify(p).slice(0, 400)}`;
		case "approval_resolved":
			return `APPROVAL_RESULT: ${JSON.stringify(p).slice(0, 300)}`;
		case "expertise_updated":
			return `EXPERTISE: ${JSON.stringify(p.paths ?? p).slice(0, 300)}`;
		default:
			return `${et} ${JSON.stringify(p).slice(0, 280)}`;
	}
}

export function filterReplayRows(
	rows: ReplayRow[],
	opts: { agent?: string; team?: string; types?: string[] },
): ReplayRow[] {
	return rows.filter((r) => {
		if (opts.agent && r.agent !== opts.agent) return false;
		if (opts.team && r.team !== opts.team) return false;
		if (opts.types?.length) {
			if (r.source !== "events") return false;
			if (!r.eventType || !opts.types.includes(r.eventType)) return false;
		}
		return true;
	});
}

export function formatReplayRow(i: number, r: ReplayRow): string {
	const who = r.agent ? `${r.agent}` : (r.role ?? "?");
	const tm = r.team ? `@${r.team}` : "";
	const tag = r.eventType ?? r.source;
	return `${i + 1}. ${r.timestamp} [${tag}] ${who}${tm} — ${r.summary}`;
}

/** Markdown export for postmortems / sharing (plan: replay-export hook). */
export function timelineToMarkdown(
	rows: ReplayRow[],
	title = "Session timeline",
): string {
	const lines = [
		`# ${title}`,
		"",
		"| # | Time | Source | Kind | Actor | Summary |",
		"|---|------|--------|------|-------|---------|",
	];
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const kind = r.eventType ?? r.source;
		const actor = r.agent
			? `${r.agent}${r.team ? `@${r.team}` : ""}`
			: (r.role ?? "—");
		const sum = r.summary.replace(/\|/g, "\\|").slice(0, 240);
		lines.push(
			`| ${i + 1} | ${r.timestamp} | ${r.source} | ${kind} | ${actor.replace(/\|/g, " ")} | ${sum} |`,
		);
	}
	lines.push("");
	lines.push("## Event payloads (truncated)");
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		if (r.source !== "events") continue;
		lines.push(`### ${i + 1}. ${r.eventType ?? "event"}`);
		lines.push("\n```json");
		lines.push(JSON.stringify(r.payload, null, 2).slice(0, 6000));
		lines.push("```\n");
	}
	return lines.join("\n");
}

export async function writeTimelineMarkdownFile(opts: {
	sessionDir: string;
	outPath?: string;
	filter?: { agent?: string; team?: string; types?: string[] };
}): Promise<string> {
	const all = await loadReplayTimeline(opts.sessionDir);
	const rows = filterReplayRows(all, opts.filter ?? {});
	const md = timelineToMarkdown(rows, `Session replay: ${opts.sessionDir}`);
	const out = opts.outPath ?? resolve(opts.sessionDir, "replay-timeline.md");
	await fs.writeFile(out, md, "utf8");
	return out;
}

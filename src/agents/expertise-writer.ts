import { basename, dirname, join, resolve } from "node:path";
import fs from "fs-extra";
import { PROJECT_ROOT } from "../app/config-loader.js";
import type { Multi_teamConfig } from "../models/config-schema.js";
import type { DelegationEnvelope } from "../models/delegation.js";
import type { SessionContext } from "../sessions/session-context.js";

const SECTION_ORDER = [
	"Stable facts",
	"Domain boundaries",
	"Useful patterns",
	"Known pitfalls",
	"Recent lessons",
	"Open questions",
] as const;

const MAX_FILE_CHARS = 11_500;
const MAX_RECENT_LESSONS = 12;
const MAX_OPEN_QUESTIONS = 8;

const SKELETON = SECTION_ORDER.map((h) => `## ${h}\n\n`).join("\n");

function parseSections(md: string): Map<string, string> {
	const map = new Map<string, string>();
	const lines = md.split("\n");
	let current: string | null = null;
	const body: string[] = [];
	const flush = () => {
		if (current != null) map.set(current, body.join("\n").trim());
		body.length = 0;
	};
	for (const line of lines) {
		const m = /^## (.+)$/.exec(line);
		if (m) {
			flush();
			current = m[1]?.trim() ?? "";
		} else if (current != null) body.push(line);
	}
	flush();
	return map;
}

function serializeSections(map: Map<string, string>): string {
	const parts: string[] = [];
	for (const title of SECTION_ORDER) {
		const body = map.get(title) ?? "";
		parts.push(`## ${title}\n\n${body}\n`);
	}
	return `${parts.join("\n")}\n`;
}

function truncateBullets(text: string, maxLines: number): string {
	const L = text.split("\n").filter((l) => l.trim().length > 0);
	return L.slice(-maxLines).join("\n");
}

export async function applyExpertiseAfterTurn(opts: {
	cfg: Multi_teamConfig;
	session: SessionContext;
	agentName: string;
	team: string | null;
	expertiseWritable: string[];
	result: {
		text: string;
		envelope?: DelegationEnvelope;
		contract_error?: boolean;
	};
}): Promise<void> {
	if (opts.cfg.features?.enable_memory_updates === false) return;
	if (!opts.expertiseWritable.length) return;

	const ts = new Date().toISOString();
	const env = opts.result.envelope;
	const summaryLine = env?.summary
		? env.summary.replace(/\s+/g, " ").trim().slice(0, 220)
		: opts.result.text.replace(/\s+/g, " ").trim().slice(0, 180);

	const lesson =
		opts.result.contract_error === true
			? `- ${ts} **${opts.agentName}** contract_error — check session logs.`
			: `- ${ts} **${opts.agentName}** ${summaryLine}`;

	const blockerLines =
		env?.blockers?.length && opts.result.contract_error !== true
			? env.blockers
					.map((b) =>
						typeof b === "string"
							? `- ${b.replace(/\s+/g, " ").trim().slice(0, 120)}`
							: "",
					)
					.filter(Boolean)
			: [];

	const dryRun = process.env.PI_EXPERTISE_DRY_RUN === "1";

	for (const rel of opts.expertiseWritable) {
		const abs = resolve(PROJECT_ROOT, rel.replace(/^\.\//, ""));
		const dir = dirname(abs);
		await fs.ensureDir(dir);
		const archiveDir = join(dir, "_archive");
		await fs.ensureDir(archiveDir);

		let raw = (await fs.pathExists(abs)) ? await fs.readFile(abs, "utf8") : "";
		if (!raw.trim()) raw = SKELETON;

		const map = parseSections(raw);
		for (const t of SECTION_ORDER) {
			if (!map.has(t)) map.set(t, "");
		}

		const recent = map.get("Recent lessons") ?? "";
		const mergedRecent = `${lesson}\n${recent}`.trim();
		map.set(
			"Recent lessons",
			truncateBullets(mergedRecent, MAX_RECENT_LESSONS),
		);

		if (blockerLines.length) {
			const oq = map.get("Open questions") ?? "";
			const mergedOq = `${blockerLines.join("\n")}\n${oq}`.trim();
			map.set("Open questions", truncateBullets(mergedOq, MAX_OPEN_QUESTIONS));
		}

		let out = serializeSections(map);
		if (out.length > MAX_FILE_CHARS) {
			const stamp = ts.replace(/[:.]/g, "-");
			try {
				await fs.copy(
					abs,
					join(archiveDir, `${basename(abs, ".md")}-${stamp}.md`),
				);
			} catch {
				/* no source yet */
			}
			const lessons = truncateBullets(map.get("Recent lessons") ?? "", 6);
			const oqTrim = truncateBullets(map.get("Open questions") ?? "", 4);
			map.set("Recent lessons", lessons);
			map.set("Open questions", oqTrim);
			out = serializeSections(map);
			if (out.length > MAX_FILE_CHARS) {
				map.set("Recent lessons", truncateBullets(lessons, 3));
				out = serializeSections(map);
			}
		}

		if (!dryRun) await fs.writeFile(abs, out, "utf8");
		await opts.session.emit({
			correlation_id: opts.session.correlationBase,
			event_type: "expertise_updated",
			agent: opts.agentName,
			parent_agent: null,
			team: opts.team,
			payload: {
				paths: [rel],
				bytes_written: out.length,
				contract_error: Boolean(opts.result.contract_error),
				dry_run: dryRun,
			},
		});
	}
}

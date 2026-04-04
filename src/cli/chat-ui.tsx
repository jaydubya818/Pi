/**
 * chat-ui.tsx
 *
 * All terminal rendering components for pi-multi-team-local.
 * Pure presentational layer — no state, no control-plane imports.
 *
 * Components exported:
 *   Header, MessageRow, SystemLine, HelpBlock, Composer, StatusBar
 *
 * Types exported:
 *   AgentKind, ChatMessage
 *
 * Helpers exported:
 *   classifyAgent, makeMessage
 */

import { Box, Text } from "ink";
import React from "react";

// ── Types ─────────────────────────────────────────────────────────────────

export type AgentKind =
	| "user"
	| "orchestrator"
	| "planning-lead"
	| "engineering-lead"
	| "validation-lead"
	| "worker"
	| "system"
	| "help"
	| "error";

export interface ChatMessage {
	id: number;
	kind: AgentKind;
	/** raw agent name from onChat / internal */
	from: string;
	/** raw text — JSON summarization happens at render time */
	text: string;
	ts: Date;
}

// ── Badge config ──────────────────────────────────────────────────────────

interface BadgeCfg {
	/** single letter shown in the colored square */
	letter: string;
	/** display name shown next to badge */
	name: string;
	/** Ink color name for text and badge bg */
	color: string;
}

const BADGE: Record<AgentKind, BadgeCfg> = {
	user: { letter: "Y", name: "You", color: "cyan" },
	orchestrator: { letter: "O", name: "Orchestrator", color: "green" },
	"planning-lead": { letter: "P", name: "Planning Lead", color: "magenta" },
	"engineering-lead": {
		letter: "E",
		name: "Engineering Lead",
		color: "yellow",
	},
	"validation-lead": { letter: "V", name: "Validation Lead", color: "blue" },
	worker: { letter: "w", name: "", color: "cyan" },
	system: { letter: "·", name: "sys", color: "gray" },
	help: { letter: "?", name: "help", color: "cyan" },
	error: { letter: "!", name: "error", color: "red" },
};

// ── Classification + helpers ──────────────────────────────────────────────

/** Classify a raw agent name (from onChat `from` param) into an AgentKind. */
export function classifyAgent(from: string): AgentKind {
	const f = from.toLowerCase();
	if (f === "user") return "user";
	if (f === "system" || f === "sys" || f === "ui") return "system";
	if (f === "error" || f === "err") return "error";
	if (f === "help") return "help";
	if (f.includes("orchestrat")) return "orchestrator";

	// Leads — check before workers since lead names include team keywords
	if (f.includes("lead") || f.endsWith("-lead")) {
		if (f.includes("plan")) return "planning-lead";
		if (f.includes("eng")) return "engineering-lead";
		if (f.includes("valid") || f.includes("val")) return "validation-lead";
		return "orchestrator"; // unknown lead → treat as orchestrator
	}

	// Workers
	if (
		f.includes("dev") ||
		f.includes("pragmatist") ||
		f.includes("spec") ||
		f.includes("qa") ||
		f.includes("security") ||
		f.includes("worker") ||
		f.includes("reviewer") ||
		f.includes("writer") ||
		f.includes("frontend") ||
		f.includes("backend") ||
		f.includes("engineer") ||
		f.includes("manager") ||
		f.includes("researcher") ||
		f.includes("analyst")
	)
		return "worker";

	return "orchestrator"; // safe fallback for unknown agents
}

let _id = 0;
/** Create a new ChatMessage with auto-incrementing id and current timestamp. */
export function makeMessage(
	kind: AgentKind,
	from: string,
	text: string,
): ChatMessage {
	return { id: _id++, kind, from, text, ts: new Date() };
}

export function formatTime(d: Date): string {
	let h = d.getHours();
	const m = d.getMinutes();
	const ampm = h >= 12 ? "PM" : "AM";
	h = h % 12 || 12;
	return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function termWidth(): number {
	return Math.min(process.stdout.columns ?? 100, 140);
}

// ── JSON contract summarizer ──────────────────────────────────────────────

function tryParseContract(text: string): string | null {
	const t = text.trim();
	if (!t.startsWith("{")) return null;
	try {
		const obj = JSON.parse(t) as Record<string, unknown>;
		if (typeof obj !== "object" || Array.isArray(obj)) return null;
		const parts: string[] = [];

		// Status
		if (obj.status) parts.push(`Status: ${String(obj.status)}`);

		// Validation result — check common field names
		const vRaw =
			obj.validation_result ?? obj.validation ?? obj.result ?? obj.passed;
		if (vRaw !== undefined && vRaw !== null) {
			if (typeof vRaw === "boolean") {
				parts.push(`Validation: ${vRaw ? "✓ pass" : "✗ fail"}`);
			} else if (typeof vRaw === "object") {
				const vObj = vRaw as Record<string, unknown>;
				if (vObj.passed !== undefined) {
					parts.push(`Validation: ${vObj.passed ? "✓ pass" : "✗ fail"}`);
				}
			}
		}

		// Summary (truncated — keep tight)
		if (obj.summary) {
			const s = String(obj.summary).slice(0, 180);
			parts.push(`Summary: ${s}${String(obj.summary).length > 180 ? "…" : ""}`);
		}

		// Artifact + blocker counts on one line
		const aCount = Array.isArray(obj.artifacts) ? obj.artifacts.length : 0;
		const bCount = Array.isArray(obj.blockers)
			? (obj.blockers as unknown[]).length
			: 0;
		if (aCount > 0 || bCount > 0) {
			const counts: string[] = [];
			if (aCount > 0)
				counts.push(`${aCount} artifact${aCount !== 1 ? "s" : ""}`);
			if (bCount > 0)
				counts.push(`⚠ ${bCount} blocker${bCount !== 1 ? "s" : ""}`);
			parts.push(counts.join("  ·  "));
		}

		return parts.length > 0 ? parts.join("\n") : null;
	} catch {
		return null;
	}
}

function getDisplayText(text: string, debug: boolean): string {
	if (debug) return text;
	return tryParseContract(text) ?? text;
}

// ── Per-line validation accent ────────────────────────────────────────────

/** Returns an Ink color for validation-flavored lines, or undefined. */
function lineAccent(line: string): string | undefined {
	const l = line.toLowerCase();
	// ✓/✗ are not word chars so tested with includes(), not \b
	if (/\b(pass(?:ed)?|success(?:ful)?|approved)\b/.test(l) || l.includes("✓"))
		return "green";
	if (
		/\b(fail(?:ed)?|invalid|reject(?:ed)?|denied)\b/.test(l) ||
		l.includes("✗")
	)
		return "red";
	if (/\b(warn(?:ing)?|partial|skip(?:ped)?|blocker)\b/.test(l))
		return "yellow";
	return undefined;
}

/** True if the message text signals a blocked / policy / contract error state. */
function isBlockedMsg(text: string): boolean {
	const l = text.toLowerCase();
	return (
		l.includes("contract_error") ||
		l.includes("policy_blocked") ||
		l.includes('"blocked"') ||
		l.includes("'blocked'") ||
		(l.includes("blocked") && l.includes("policy"))
	);
}

// ── @mention inline highlighter ───────────────────────────────────────────

function MentionText({ text }: { text: string }) {
	const parts = text.split(/(@[\w][\w-]*)/g);
	return (
		<>
			{parts.map((part, i) => {
				// Key combines position + first chars — stable for static splits
				const k = `${i}:${part.slice(0, 12)}`;
				return part.startsWith("@") ? (
					<Text key={k} color="magenta" bold>
						{part}
					</Text>
				) : (
					<Text key={k}>{part}</Text>
				);
			})}
		</>
	);
}

// ── Header ────────────────────────────────────────────────────────────────

interface HeaderProps {
	topologyLine: string;
	showWorkers: boolean;
	debugMode: boolean;
}

export function Header({ topologyLine, showWorkers, debugMode }: HeaderProps) {
	const cols = termWidth();
	const left = `  pi-multi-team-local  ·  ${topologyLine || "—"}`;
	const right = `workers:${showWorkers ? "on" : "off"}  debug:${debugMode ? "on" : "off"}  `;
	const gap = Math.max(1, cols - left.length - right.length);
	return (
		<Box flexDirection="column">
			<Box>
				<Text bold color="cyan">
					{left}
				</Text>
				<Text dimColor>{" ".repeat(gap)}</Text>
				<Text dimColor>{right}</Text>
			</Box>
			<Text dimColor>{"─".repeat(cols)}</Text>
		</Box>
	);
}

// ── MessageRow ────────────────────────────────────────────────────────────

interface MessageRowProps {
	msg: ChatMessage;
	debug: boolean;
}

export function MessageRow({ msg, debug }: MessageRowProps) {
	const cols = termWidth();

	// ── System line ─────────────────────────────────────────────────────
	if (msg.kind === "system") {
		return (
			<Box>
				<Text dimColor>{"  · "}</Text>
				<Text dimColor>{msg.text.slice(0, cols - 6)}</Text>
			</Box>
		);
	}

	// ── Error line ──────────────────────────────────────────────────────
	if (msg.kind === "error") {
		return (
			<Box>
				<Text color="red">{"  ✗ "}</Text>
				<Text color="red">{msg.text.slice(0, cols - 6)}</Text>
			</Box>
		);
	}

	// ── Help block ──────────────────────────────────────────────────────
	if (msg.kind === "help") {
		return (
			<Box>
				<Text color="cyan" dimColor>
					{"  "}
					{msg.text}
				</Text>
			</Box>
		);
	}

	// ── Chat message ─────────────────────────────────────────────────────
	const cfg = BADGE[msg.kind];
	const displayName =
		msg.kind === "worker"
			? msg.from // show raw agent name for workers
			: cfg.name;
	const time = formatTime(msg.ts);
	const blocked = isBlockedMsg(msg.text);

	// Header row: [badge] SenderName ............... 11:44 AM
	const headerLeft = `  ${displayName}`;
	const headerRightLen = time.length;
	const badgeWidth = 3; // " X " with bg
	// blocked indicator eats 2 chars on left
	const blockedPad = blocked ? 2 : 0;
	const spacerLen = Math.max(
		1,
		cols - badgeWidth - headerLeft.length - headerRightLen - blockedPad - 1,
	);

	// Body text — summarize JSON in non-debug mode
	const body = getDisplayText(msg.text, debug).slice(0, 1600);
	const bodyLines = body.split("\n");

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* ── Header row ── */}
			<Box>
				{blocked && (
					<Text color="red" bold>
						{"▌ "}
					</Text>
				)}
				<Text backgroundColor={blocked ? "red" : cfg.color} color="black" bold>
					{` ${cfg.letter} `}
				</Text>
				<Text bold color={blocked ? "red" : cfg.color}>
					{headerLeft}
				</Text>
				<Text>{" ".repeat(spacerLen)}</Text>
				<Text dimColor>{time}</Text>
			</Box>
			{/* ── Body ── */}
			{bodyLines.map((line, i) => {
				const accent = lineAccent(line);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: line index is stable per message
					<Box key={i} paddingLeft={5}>
						{accent ? (
							<Text wrap="wrap" color={accent}>
								{line}
							</Text>
						) : (
							<Text wrap="wrap">
								<MentionText text={line} />
							</Text>
						)}
					</Box>
				);
			})}
		</Box>
	);
}

// ── Composer ──────────────────────────────────────────────────────────────

interface ComposerProps {
	buf: string;
	busy: boolean;
}

export function Composer({ buf, busy }: ComposerProps) {
	if (busy) {
		return (
			<Box paddingX={1} marginTop={0}>
				<Text color="yellow">{"  ⟳ "}</Text>
				<Text color="yellow" dimColor>
					running… (or awaiting approval — press 1–4)
				</Text>
			</Box>
		);
	}
	return (
		<Box borderStyle="round" borderColor="cyan" paddingX={1}>
			<Text color="cyan" bold>
				{"▸ "}
			</Text>
			<Text>{buf}</Text>
			<Text backgroundColor="cyan" color="black">
				{" "}
			</Text>
		</Box>
	);
}

// ── StatusBar ─────────────────────────────────────────────────────────────

interface StatusBarProps {
	sessionLabel: string;
	elapsed: number;
	usage: { total: number; byAgent: Record<string, number> };
	status: Record<string, string>;
	lastArtifactCount: number | null;
	sessionMode: string;
	mock: boolean;
	/** agent-name → model string from config */
	modelByAgent?: Record<string, string>;
}

function shortAgentLabel(name: string): string {
	const n = name.toLowerCase();
	if (n.includes("orchestrat")) return "Orch";
	if (n.includes("planning") && n.includes("lead")) return "Plan Lead";
	if (n.includes("engineer") && n.includes("lead")) return "Eng Lead";
	if (n.includes("valid") && n.includes("lead")) return "Val Lead";
	if (n.includes("lead")) return "Lead";
	// Workers — keep first two non-empty segments
	return name
		.split(/[-_]/)
		.filter((s) => s.length > 0)
		.slice(0, 2)
		.map((s) => (s[0] ?? "").toUpperCase() + s.slice(1))
		.join(" ");
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

function agentTier(name: string): "orch" | "lead" | "worker" {
	const n = name.toLowerCase();
	if (n.includes("orchestrat")) return "orch";
	if (n.includes("lead") || n.endsWith("-lead")) return "lead";
	return "worker";
}

export function StatusBar({
	sessionLabel,
	elapsed,
	usage,
	status,
	lastArtifactCount,
	sessionMode,
	mock,
	modelByAgent,
}: StatusBarProps) {
	const cols = termWidth();

	// ── Session header line ─────────────────────────────────────────────
	const sessionInfo = [
		`session=${sessionLabel}`,
		`${elapsed}s`,
		`mode=${sessionMode}`,
		lastArtifactCount != null ? `artifacts=${lastArtifactCount}` : null,
		mock ? "PI_MOCK" : null,
	]
		.filter(Boolean)
		.join("  ·  ");

	// ── Agent tree ─────────────────────────────────────────────────────
	// Sort: orch first, leads second, workers last
	const agentEntries = Object.entries(usage.byAgent).sort(([a], [b]) => {
		const ta = agentTier(a);
		const tb = agentTier(b);
		const rank = { orch: 0, lead: 1, worker: 2 };
		return rank[ta] - rank[tb];
	});

	return (
		<Box flexDirection="column">
			<Text dimColor>{"─".repeat(cols)}</Text>
			{/* Session line */}
			<Box justifyContent="space-between" width={cols}>
				<Text dimColor color="cyan">
					{"pi-multi-team-local"}
				</Text>
				<Text dimColor>{sessionInfo}</Text>
			</Box>
			{/* Agent rows */}
			{agentEntries.slice(0, 10).map(([agent, tokens]) => {
				const tier = agentTier(agent);
				const label = shortAgentLabel(agent);
				const agentStatus = status[agent];
				const prefix =
					tier === "orch" ? "└ " : tier === "lead" ? "  ├ ♦ " : "  │  └ ";
				const tokenStr = fmtTokens(tokens);
				// Rough cost: use $15/M for orch/leads (opus), $3/M for workers (sonnet)
				const rate = tier === "worker" ? 3 : 15;
				const cost = ((tokens / 1_000_000) * rate).toFixed(3);
				const statusStr = agentStatus ? ` [${agentStatus}]` : "";
				const model = modelByAgent?.[agent];
				const modelStr = model ? `  ${model}` : "";
				return (
					<Box key={agent}>
						<Text dimColor>{prefix}</Text>
						<Text
							color={
								tier === "orch" ? "white" : tier === "lead" ? "magenta" : "cyan"
							}
						>
							{label}
						</Text>
						<Text color="yellow">{`  💰 $${cost}`}</Text>
						<Text color="magenta">{`  🧠 ${tokenStr}`}</Text>
						<Text dimColor>{modelStr}</Text>
						<Text dimColor>{statusStr}</Text>
					</Box>
				);
			})}
			{/* Key hints */}
			<Text dimColor>
				{
					"  Tab=workers (off by default)  ·  d=debug  ·  /help  ·  /reload  ·  Ctrl+C=exit  ·  App prompt only"
				}
			</Text>
		</Box>
	);
}

// ── Help block (as messages) ───────────────────────────────────────────────

/** Returns lines to push as 'help' ChatMessages */
export const HELP_LINES: readonly string[] = [
	"─────────────────────────────────────────────────────",
	"  Agent prompts  →  @engineering inspect backend",
	"                    @validation review recent changes",
	"                    ask all teams for improvements",
	"                    plan → engineer → validate",
	"  Library skill  →  orchestrator + team leads load the vendored",
	"                    library skill (catalog /library …). Workers",
	"                    do not; ask a lead if you need catalog ops.",
	"  App commands   →  /help  /reload  /debug",
	"  Keys           →  Tab=workers (hidden by default)  d=debug  Ctrl+C=exit",
	"                    exit / quit = clean exit",
	"  Sessions       →  path after each turn: npm run inspect-session -- <dir>",
	"  Mock pipeline  →  PI_MOCK=1 npm run demo (prints session path at end)",
	"  Shell commands  →  run in your terminal (not here)",
	"─────────────────────────────────────────────────────",
];

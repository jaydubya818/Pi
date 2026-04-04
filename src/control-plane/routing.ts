import {
	type TaskContract,
	defaultContractForTeam,
} from "../models/task-contracts.js";

export type RoutingMode =
	| "freeform"
	| "team_mention"
	| "ask_all"
	| "sequential_pev"
	| "engineering_only"
	| "validation_only";

export type RoutePlan = {
	mode: RoutingMode;
	teams: string[];
	raw: string;
	work_items: TaskContract[];
};

const DEFAULT_SEQ = ["planning", "engineering", "validation"];

export function parseRouting(userInput: string, teamIds: string[]): RoutePlan {
	const t = userInput.trim();
	const lower = t.toLowerCase();

	for (const id of teamIds) {
		if (lower.includes(`@${id.toLowerCase()}`)) {
			const work = [defaultContractForTeam(id, `task-${id}-1`)];
			return { mode: "team_mention", teams: [id], raw: t, work_items: work };
		}
	}

	if (
		lower.includes("ask all teams") ||
		(lower.includes("all teams") &&
			(lower.includes("improvement") || lower.includes("ask")))
	) {
		const work = teamIds.map((id, i) =>
			defaultContractForTeam(id, `task-${id}-${i + 1}`),
		);
		return { mode: "ask_all", teams: [...teamIds], raw: t, work_items: work };
	}

	if (
		lower.includes("plan") &&
		lower.includes("engineer") &&
		lower.includes("validat")
	) {
		const ordered = [
			...DEFAULT_SEQ.filter((x) => teamIds.includes(x)),
			...teamIds.filter((x) => !DEFAULT_SEQ.includes(x)),
		];
		return {
			mode: "sequential_pev",
			teams: ordered,
			raw: t,
			work_items: ordered.map((id, i) =>
				defaultContractForTeam(id, `task-${id}-${i + 1}`),
			),
		};
	}

	if (
		teamIds.includes("validation") &&
		(lower.includes("validation-only") || lower.includes("@validation only"))
	) {
		return {
			mode: "validation_only",
			teams: ["validation"],
			raw: t,
			work_items: [defaultContractForTeam("validation", "task-validation-1")],
		};
	}
	if (
		teamIds.includes("engineering") &&
		(lower.includes("engineering-only") || lower.includes("@engineering only"))
	) {
		return {
			mode: "engineering_only",
			teams: ["engineering"],
			raw: t,
			work_items: [defaultContractForTeam("engineering", "task-engineering-1")],
		};
	}

	const work = teamIds.map((id, i) =>
		defaultContractForTeam(id, `task-${id}-${i + 1}`),
	);
	return { mode: "freeform", teams: [...teamIds], raw: t, work_items: work };
}

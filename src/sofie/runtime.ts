import fs from "fs-extra";
import type { Multi_teamConfig } from "../models/config-schema.js";
import type { SessionContext } from "../sessions/session-context.js";
import { reviewSessionWithSofie } from "./review.js";

export async function maybeRunSofie(opts: {
	cfg: Multi_teamConfig;
	session: SessionContext;
	userMessage: string;
	onChat: (from: string, line: string) => void;
	repoRoot: string;
}): Promise<void> {
	if (opts.cfg.features?.enable_sofie !== true) return;

	const changed = (await fs.readJson(
		opts.session.path("changed-files.json"),
	)) as {
		files?: string[];
		repoRoot?: string;
	};
	const policy = (await fs.readJson(
		opts.session.path("policy-violations.json"),
	)) as { violations?: unknown[] };
	const artifacts = (await fs.readJson(
		opts.session.path("artifacts.json"),
	)) as {
		missing_required_by_agent?: unknown[];
		validation_outcomes?: Array<{ validation_status?: string }>;
	};
	const eventsRaw = await fs.readFile(
		opts.session.path("events.jsonl"),
		"utf8",
	);
	const approvalDenials = eventsRaw
		.split("\n")
		.filter((line) => line.includes('"event_type":"approval_resolved"'))
		.filter(
			(line) =>
				line.includes('"outcome":"denied"') ||
				line.includes('"outcome":"cancel_turn"'),
		).length;

	const review = reviewSessionWithSofie({
		userMessage: opts.userMessage,
		changedFiles: changed.files ?? [],
		policyViolationCount: policy.violations?.length ?? 0,
		approvalDenials,
		missingRequiredArtifacts: artifacts.missing_required_by_agent?.length ?? 0,
		validationFailures:
			artifacts.validation_outcomes?.filter(
				(o) => o.validation_status === "fail",
			).length ?? 0,
		targetRepoRoot: changed.repoRoot ?? opts.repoRoot,
		harnessSessionRoot: opts.session.root,
	});

	const summary = `${review.verdict.toUpperCase()}: ${review.closureRecommendation}`;
	opts.onChat("sofie", summary);
	if (review.routineAnswer) {
		opts.onChat("sofie", review.routineAnswer);
	}
}

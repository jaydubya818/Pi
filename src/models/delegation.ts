import { z } from "zod";
import { taskTypeSchema } from "./task-contracts.js";
import { validationResultSchema } from "./validation.js";

export const delegationStatusSchema = z.enum([
	"success",
	"partial",
	"blocked",
	"failed",
]);

export const delegationEnvelopeSchema = z.object({
	task_type: taskTypeSchema,
	objective: z.string(),
	status: delegationStatusSchema,
	summary: z.string(),
	files_touched: z.array(z.string()),
	artifacts: z.array(z.string()),
	blockers: z.array(z.string()),
	next_step: z.string(),
	validation_result: validationResultSchema.optional(),
});

export type DelegationEnvelope = z.infer<typeof delegationEnvelopeSchema>;

/** Brace-balanced scan for first top-level JSON object */
export function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	let q = "";
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) {
				esc = false;
				continue;
			}
			if (c === "\\") {
				esc = true;
				continue;
			}
			if (c === q) inStr = false;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = true;
			q = c;
			continue;
		}
		if (c === "{") depth++;
		if (c === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

export type ParseEnvelopeResult =
	| { ok: true; data: DelegationEnvelope }
	| { ok: false; error: string };

export function parseDelegationEnvelope(text: string): ParseEnvelopeResult {
	const raw = extractFirstJsonObject(text);
	if (!raw) return { ok: false, error: "no_json_object" };
	try {
		const data: unknown = JSON.parse(raw);
		const r = delegationEnvelopeSchema.safeParse(data);
		if (!r.success) return { ok: false, error: r.error.message };
		return { ok: true, data: r.data };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

export const REPAIR_PROMPT = `Your previous reply did not contain a valid JSON object matching this exact schema:
{"task_type":"plan|build|validate|inspect|refactor|review|research","objective":"string","status":"success|partial|blocked|failed","summary":"string","files_touched":[],"artifacts":[],"blockers":[],"next_step":"string","validation_result":{"validation_status":"pass|warn|fail","checks_run":[],"failed_checks":[],"summary":"string","artifacts":[],"requires_approval_for_further_mutation":false}}
Reply with ONLY that JSON object and no other text.`;

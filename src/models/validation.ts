import { z } from "zod";

export const validationStatusSchema = z.enum(["pass", "warn", "fail"]);

export const validationResultSchema = z.object({
	validation_status: validationStatusSchema,
	checks_run: z.array(z.string()),
	failed_checks: z.array(z.string()),
	summary: z.string(),
	artifacts: z.array(z.string()),
	requires_approval_for_further_mutation: z.boolean(),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import YAML from "yaml";
import {
	type Multi_teamConfig,
	multiTeamConfigSchema,
} from "../models/config-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..", "..");

export async function loadConfig(
	configPath?: string,
): Promise<Multi_teamConfig> {
	const selectedConfig =
		configPath ??
		process.env.PI_MULTI_CONFIG ??
		join(PROJECT_ROOT, "config", "multi-team.yaml");
	const path = resolve(selectedConfig);
	const raw = await fs.readFile(path, "utf8");
	const data = YAML.parse(raw);
	const parsed = multiTeamConfigSchema.safeParse(data);
	if (!parsed.success) {
		throw new Error(`Invalid config: ${parsed.error.message}`);
	}
	return parsed.data;
}

export function resolveFromRoot(cfg: Multi_teamConfig, p: string): string {
	return resolve(PROJECT_ROOT, p.replace(/^\.\//, ""));
}

import { resolve } from "node:path";
import { minimatch } from "minimatch";
import type { Multi_teamConfig } from "../models/config-schema.js";
import { checkShellCommand, isSecretsPath } from "./command-policy.js";
import {
	isUnderRootRealpathSync,
	isUnderRootSync,
	normalizePath,
} from "./path-policy.js";

export type Violation = {
	code: string;
	message: string;
	path?: string;
};

export type SessionMetrics = {
	filesTouched: Set<string>;
	approxLinesChanged: number;
};

const INFRA_GLOBS = [
	"**/Dockerfile*",
	"**/*.tf",
	"**/.github/workflows/**",
	"**/kubernetes/**",
	"**/k8s/**",
];

function resolvedRoots(repoRoot: string, relPaths: string[]): string[] {
	return relPaths.map((p) => resolve(repoRoot, p.replace(/^\.\//, "")));
}

export function isPathInWritableRoots(
	absPath: string,
	repoRoot: string,
	writableRel: string[],
): boolean {
	const roots = resolvedRoots(repoRoot, writableRel);
	for (const r of roots) {
		if (isUnderRootRealpathSync(absPath, r)) return true;
	}
	return false;
}

export class PolicyEngine {
	constructor(
		private readonly cfg: Multi_teamConfig,
		private readonly repoRoot: string,
		private readonly writableRel: string[],
		private readonly deleteRel: string[] | undefined,
		private readonly autonomy: "advisory" | "supervised" | "active",
		private readonly role: "orchestrator" | "lead" | "worker",
		private readonly metrics: SessionMetrics,
	) {}

	checkWrite(absPath: string): Violation | null {
		if (this.autonomy === "advisory") {
			return {
				code: "advisory_mode",
				message: "Writes disabled in advisory autonomy",
			};
		}
		if (this.role === "lead" && this.autonomy !== "active") {
			const leadOk = isPathInWritableRoots(absPath, this.repoRoot, [
				".runtime",
				"handoffs",
				"plans",
				"validation",
				".pi/experts",
			]);
			if (!leadOk) {
				return {
					code: "lead_app_code",
					message:
						"Lead cannot write application code paths in supervised/advisory modes",
					path: absPath,
				};
			}
		}
		if (!isPathInWritableRoots(absPath, this.repoRoot, this.writableRel)) {
			return {
				code: "write_outside_domain",
				message: "Write outside allowed domain",
				path: absPath,
			};
		}
		if (isSecretsPath(absPath)) {
			return {
				code: "secrets_path",
				message: "Secrets-related path blocked by policy",
				path: absPath,
			};
		}
		const rel = absPath.startsWith(this.repoRoot)
			? absPath.slice(this.repoRoot.length + 1)
			: absPath;
		for (const pat of INFRA_GLOBS) {
			if (minimatch(rel, pat, { dot: true }) && this.autonomy !== "active") {
				return {
					code: "infra_path",
					message: "Infra/config paths need active autonomy",
					path: absPath,
				};
			}
		}
		return null;
	}

	checkRead(absPath: string, readableRel: string[]): Violation | null {
		const roots = resolvedRoots(this.repoRoot, readableRel);
		const ok = roots.some((r) => isUnderRootRealpathSync(absPath, r));
		if (!ok)
			return {
				code: "read_denied",
				message: "Read outside allowed domain",
				path: absPath,
			};
		return null;
	}

	checkDelete(absPath: string): Violation | null {
		if (this.autonomy === "advisory") {
			return {
				code: "advisory_delete_blocked",
				message: "Advisory mode blocks delete operations",
				path: absPath,
			};
		}
		const deleteRoots = this.deleteRel ?? this.writableRel;
		if (!isPathInWritableRoots(absPath, this.repoRoot, deleteRoots)) {
			return {
				code: "delete_outside_domain",
				message: "Delete outside allowed delete domain",
				path: absPath,
			};
		}
		if (isSecretsPath(absPath)) {
			return {
				code: "secrets_path",
				message: "Secrets-related delete blocked by policy",
				path: absPath,
			};
		}
		return null;
	}

	checkBash(cmd: string, needApproval: boolean): Violation | null {
		if (this.autonomy === "advisory") {
			const r = checkShellCommand(cmd, {
				allowPackageManagers: false,
				isDestructiveBlocked: true,
			});
			if (!r.ok) return { code: r.code, message: r.message };
			const r2 = checkShellCommand(cmd, {
				allowPackageManagers: false,
				isDestructiveBlocked: false,
			});
			if (!r2.ok) return { code: r2.code, message: r2.message };
			if (/\b(git\s+commit|git\s+push)\b/.test(cmd)) {
				if (!this.cfg.git?.commits_enabled) {
					return {
						code: "git_commit_disabled",
						message: "git commit/push disabled by config",
					};
				}
			}
		}
		const allowPkg = this.autonomy === "active" && !needApproval;
		const shell = checkShellCommand(cmd, {
			allowPackageManagers: allowPkg,
			isDestructiveBlocked: this.autonomy !== "active",
		});
		if (!shell.ok) return { code: shell.code, message: shell.message };
		return null;
	}

	noteFileTouch(absPath: string, linesDelta: number): void {
		this.metrics.filesTouched.add(absPath);
		this.metrics.approxLinesChanged += Math.abs(linesDelta);
	}

	exceedsFileBudget(maxFiles: number): boolean {
		return this.metrics.filesTouched.size > maxFiles;
	}

	exceedsLineBudget(maxLines: number): boolean {
		return this.metrics.approxLinesChanged > maxLines;
	}
}

export { normalizePath, checkShellCommand, isSecretsPath };

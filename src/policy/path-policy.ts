import { dirname, normalize, relative, resolve } from "node:path";
import fs from "fs-extra";

export function normalizePath(workdir: string, input: string): string {
	const n = resolve(workdir, normalize(input.trim()));
	return n;
}

/** Returns true if candidate is under root (after realpath when possible). */
export async function isUnderRoot(
	candidate: string,
	root: string,
): Promise<boolean> {
	let c = candidate;
	let r = resolve(root);
	try {
		if (await fs.pathExists(c)) c = await fs.realpath(c);
	} catch {
		/* use unresolved */
	}
	try {
		r = await fs.realpath(r);
	} catch {
		r = resolve(root);
	}
	const rel = relative(r, c);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function isUnderRootSync(candidate: string, root: string): boolean {
	const r = resolve(root);
	const c = resolve(candidate);
	const rel = relative(r, c);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Realpath-aware containment for enforcement hot paths.
 * Uses parent dir realpath when candidate does not yet exist.
 */
export function isUnderRootRealpathSync(
	candidate: string,
	root: string,
): boolean {
	let resolvedRoot = resolve(root);
	let resolvedCandidate = resolve(candidate);
	try {
		resolvedRoot = fs.realpathSync(resolvedRoot);
	} catch {
		/* keep resolved root */
	}
	try {
		const probe = fs.existsSync(resolvedCandidate)
			? resolvedCandidate
			: dirname(resolvedCandidate);
		const rp = fs.realpathSync(probe);
		if (!fs.existsSync(resolvedCandidate)) {
			const suffix = relative(probe, resolvedCandidate);
			resolvedCandidate = resolve(rp, suffix);
		} else {
			resolvedCandidate = rp;
		}
	} catch {
		/* keep resolved candidate */
	}
	const rel = relative(resolvedRoot, resolvedCandidate);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Any path in allow list: must be under at least one */
export async function matchesAllowList(
	absPath: string,
	allowDirs: string[],
	repoRoot: string,
): Promise<boolean> {
	for (const a of allowDirs) {
		const base = resolve(repoRoot, a.replace(/^\.\//, ""));
		if (await isUnderRoot(absPath, base)) return true;
	}
	return false;
}

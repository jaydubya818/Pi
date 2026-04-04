/**
 * shell-guard.ts
 *
 * Detects input that looks like a shell command rather than an agent prompt.
 * Used by the TUI to prevent accidental routing of shell commands to agents.
 *
 * Rules (in priority order):
 *  1. App slash-commands (/help, /reload) — always allowed; never shell.
 *  2. First word matches a known shell-command set.
 *  3. Starts with `sudo`.
 *  4. Starts with `./` or `../` (relative script/path invocation).
 *  5. Starts with an absolute path that contains a sub-directory (`/bin/bash`,
 *     `/usr/local/bin/node`). Distinguished from app commands like `/reload`
 *     because app commands have no second `/`.
 *  6. Contains shell chain operators (` && ` or ` || `).
 *  7. Contains a pipe (` | `) AND the first word is a known shell command.
 */

export const SHELL_CMD_SET: ReadonlySet<string> = new Set([
	// filesystem
	"ls",
	"cat",
	"cd",
	"pwd",
	"find",
	"mkdir",
	"rm",
	"mv",
	"cp",
	"touch",
	"chmod",
	"chown",
	"ln",
	"stat",
	// text processing
	"grep",
	"sed",
	"awk",
	"sort",
	"uniq",
	"head",
	"tail",
	"wc",
	"cut",
	"echo",
	"printf",
	// process / system
	"ps",
	"kill",
	"pkill",
	"top",
	"htop",
	"env",
	"export",
	"source",
	"which",
	"man",
	// network
	"curl",
	"wget",
	"ping",
	"ssh",
	"scp",
	// package / build / vcs
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"git",
	"make",
	"cargo",
	"go",
	// runtimes
	"node",
	"python",
	"python3",
	"ruby",
	"perl",
	"bash",
	"zsh",
	"sh",
	"fish",
	// privilege
	"sudo",
	"su",
]);

/**
 * Returns true when `msg` looks like a shell command rather than an agent
 * prompt.  App slash-commands (/help, /reload) always return false.
 */
export function isShellLike(msg: string): boolean {
	const trimmed = msg.trim();

	// ── Rule 1: app slash-commands are never shell ─────────────────────────
	// App commands: single-segment starting with / e.g. /help, /reload.
	// Absolute shell paths have at least one more /: /bin/bash, /usr/bin/env.
	if (trimmed.startsWith("/") && !/^\/[^/]+\//.test(trimmed)) {
		return false;
	}

	const firstWord = trimmed.split(/\s+/)[0].toLowerCase();

	// ── Rule 2 & 3: known shell command or sudo ────────────────────────────
	if (SHELL_CMD_SET.has(firstWord)) return true;

	// ── Rule 4: relative script invocation ────────────────────────────────
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;

	// ── Rule 5: absolute path with sub-directory ──────────────────────────
	if (/^\/[^/]+\//.test(trimmed)) return true;

	// ── Rule 6: shell chain operators ─────────────────────────────────────
	if (trimmed.includes(" && ") || trimmed.includes(" || ")) return true;

	// ── Rule 7: pipe where first word is a shell command ──────────────────
	if (trimmed.includes(" | ") && SHELL_CMD_SET.has(firstWord)) return true;

	return false;
}

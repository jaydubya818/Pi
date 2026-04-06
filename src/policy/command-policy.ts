const DANGEROUS = [
	/\brm\s+(-[rRf]*\s+)*\/\s*/,
	/\brm\s+-rf\s+/,
	/\bdd\s+if=/,
	/\bmkfs\b/,
	/\bchmod\s+-R\s+777/,
	/>\s*\/dev\/sd/,
];

const PKG_MANAGERS = [
	/\bnpm\s+(i|install|ci|update|unlink)\b/,
	/\byarn\s+(add|install)\b/,
	/\bpnpm\s+(i|install|add)\b/,
	/\bbun\s+(add|install|i)\b/,
	/\bpip\s+(install|uninstall)\b/,
	/\bcargo\s+(add|install)\b/,
];

const SHELL_INTERPRETERS = new Set([
	"bash",
	"zsh",
	"sh",
	"python",
	"python3",
	"node",
	"ruby",
	"perl",
	"osascript",
]);

const SECRETISH = [/\.env/i, /credential/i, /\.pem/i, /id_rsa/i];

export type CommandCheck =
	| { ok: true }
	| { ok: false; code: string; message: string };

function firstExecutables(cmd: string): string[] {
	return cmd
		.split(/&&|;|\|\||\|/g)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map(
			(chunk) => chunk.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [],
		)
		.map((tokens) => {
			let i = 0;
			while (
				i < tokens.length &&
				/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[i] ?? "")
			) {
				i += 1;
			}
			return tokens[i]?.replace(/^['"]|['"]$/g, "").toLowerCase() ?? "";
		})
		.filter(Boolean);
}

export function checkShellCommand(
	cmd: string,
	opts: { allowPackageManagers: boolean; isDestructiveBlocked: boolean },
): CommandCheck {
	const c = cmd.trim();
	for (const re of DANGEROUS) {
		if (re.test(c) && opts.isDestructiveBlocked) {
			return {
				ok: false,
				code: "dangerous_destructive",
				message: `Blocked pattern: ${re}`,
			};
		}
	}
	if (!opts.allowPackageManagers) {
		for (const re of PKG_MANAGERS) {
			if (re.test(c)) {
				return {
					ok: false,
					code: "package_manager",
					message:
						"Package manager invocation requires approval or active+gate",
				};
			}
		}
	}
	for (const executable of firstExecutables(c)) {
		if (SHELL_INTERPRETERS.has(executable)) {
			return {
				ok: false,
				code: "shell_interpreter",
				message:
					"Nested shells and scripting runtimes are blocked in mediated bash",
			};
		}
	}
	if (/[<>]/.test(c)) {
		return {
			ok: false,
			code: "shell_redirection",
			message: "Shell redirection is blocked in mediated bash",
		};
	}
	if (SECRETISH.some((re) => re.test(c))) {
		return {
			ok: false,
			code: "secretish_path",
			message: "Command references a secretish path or credential file",
		};
	}
	return { ok: true };
}

export function isSecretsPath(pathStr: string): boolean {
	return SECRETISH.some((re) => re.test(pathStr));
}

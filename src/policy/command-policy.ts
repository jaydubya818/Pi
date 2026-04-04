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
	/\bpip\s+(install|uninstall)\b/,
	/\bcargo\s+(add|install)\b/,
];

const SECRETISH = [/\.env/i, /credential/i, /\.pem/i, /id_rsa/i];

export type CommandCheck =
	| { ok: true }
	| { ok: false; code: string; message: string };

export function checkShellCommand(
	cmd: string,
	opts: { allowPackageManagers: boolean; isDestructiveBlocked: boolean },
): CommandCheck {
	const c = cmd.trim();
	for (const re of DANGEROUS) {
		if (re.test(c) && opts.isDestructiveBlocked) {
			return {
				ok: false,
				code: "destructive_shell",
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
	return { ok: true };
}

export function isSecretsPath(pathStr: string): boolean {
	return SECRETISH.some((re) => re.test(pathStr));
}

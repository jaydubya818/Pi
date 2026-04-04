#!/usr/bin/env node
/**
 * Run `npm run pi-play:verify` only when `pi` is on PATH; otherwise exit 0 with a clear skip message.
 * For local use and CI (agents without Pi still pass).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const probe = spawnSync("pi", ["--help"], {
	encoding: "utf8",
	windowsHide: true,
});

const ok = !probe.error && probe.status === 0;
if (!ok) {
	const reason =
		probe.error?.code === "ENOENT"
			? "`pi` not found on PATH"
			: "`pi --help` did not succeed";
	console.log(
		`SKIP pi playground verify (${reason}). Install the Pi CLI: https://github.com/mariozechner/pi-coding-agent — then run: npm run pi-play:verify`,
	);
	process.exit(0);
}

const child = spawnSync(
	process.execPath,
	[join(root, "scripts", "verify-pi-play.mjs")],
	{
		cwd: root,
		stdio: "inherit",
	},
);
process.exit(child.status ?? 1);

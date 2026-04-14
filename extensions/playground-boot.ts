/**
 * First `-e` in npm `pi-play:*` / `pi-tier:*` stacks. If `PI_PLAYGROUND_LABEL`
 * is set (by those scripts), shows one startup notify so operators see which
 * preset launched. No-op when the env var is unset.
 *
 * Pi v0.67.1 — PI_CODING_AGENT detection:
 *   Pi sets PI_CODING_AGENT=true at startup so subprocesses can detect they are
 *   running inside the coding agent. When present, skip the startup notify to
 *   avoid polluting the parent agent's output stream with UI noise.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Pi v0.67.1: subagent subprocess — suppress startup notify.
		if (process.env.PI_CODING_AGENT === "true") return;

		const label = process.env.PI_PLAYGROUND_LABEL?.trim();
		if (!label || !ctx.hasUI) return;
		ctx.ui.notify(
			`${label} — /help lists Pi slash commands · README has tier map`,
			"info",
		);
	});
}

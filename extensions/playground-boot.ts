/**
 * First `-e` in npm `pi-play:*` / `pi-tier:*` stacks. If `PI_PLAYGROUND_LABEL`
 * is set (by those scripts), shows one startup notify so operators see which
 * preset launched. No-op when the env var is unset.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const label = process.env.PI_PLAYGROUND_LABEL?.trim();
		if (!label || !ctx.hasUI) return;
		ctx.ui.notify(
			`${label} — /help lists Pi slash commands · README has tier map`,
			"info",
		);
	});
}

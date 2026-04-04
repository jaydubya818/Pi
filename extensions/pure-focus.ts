/**
 * Pure Focus — Strip all footer and extension status UI
 *
 * Removes the footer bar and clears extension status slots (Pi combines those
 * into the status area). Load this extension **after** any extension that sets
 * status (e.g. `pi -e extensions/theme-cycler.ts -e extensions/pure-focus.ts`)
 * so the status line stays empty.
 *
 * Usage: pi -e extensions/pure-focus.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { applyExtensionDefaults } from "./themeMap.ts";

/** Keys used by playground extensions that call ctx.ui.setStatus(key, …) */
const STATUS_KEYS_TO_CLEAR = [
	"theme",
	"system-prompt",
	"tilldone",
	"damage-control",
	"damage-control-alert",
	"agent-team",
	"agent-chain",
	"pi-pi",
] as const;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.setFooter((_tui, _theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(_width: number): string[] {
				return [];
			},
		}));
		for (const key of STATUS_KEYS_TO_CLEAR) {
			ctx.ui.setStatus(key, undefined);
		}
	});
}

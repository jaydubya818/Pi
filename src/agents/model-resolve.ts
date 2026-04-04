import {
	type Api,
	type KnownProvider,
	type Model,
	getModel,
} from "@mariozechner/pi-ai";

const ALIASES: Record<string, [KnownProvider, string]> = {
	"claude-opus": ["anthropic", "claude-opus-4-5"],
	"claude-sonnet": ["anthropic", "claude-sonnet-4-6"],
	opus: ["anthropic", "claude-opus-4-5"],
	sonnet: ["anthropic", "claude-sonnet-4-6"],
};

export function resolveModel(ref: string): Model<Api> | undefined {
	const alias = ALIASES[ref];
	if (alias) {
		const m = getModel(alias[0], alias[1] as never);
		if (m) return m as Model<Api>;
	}
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const prov = ref.slice(0, slash) as KnownProvider;
		const id = ref.slice(slash + 1);
		return getModel(prov, id as never) as Model<Api> | undefined;
	}
	return undefined;
}

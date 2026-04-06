/**
 * context-tokens.ts
 *
 * Lightweight context token estimation for the multi-team pipeline.
 *
 * Adapted from badlogic/pi-mono's context token tracking approach.
 * Uses a simple character-to-token ratio (4 chars ≈ 1 token) as a
 * rough but fast estimate — accurate enough for threshold warnings.
 */

/** Approximate context windows (tokens) for common model families. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"claude-opus-4": 200_000,
	"claude-sonnet-4": 200_000,
	"claude-haiku-4": 200_000,
	"claude-3-5-sonnet": 200_000,
	"claude-3-5-haiku": 200_000,
	"claude-3-opus": 200_000,
	"claude-3-sonnet": 200_000,
	"claude-3-haiku": 200_000,
	"gpt-4o": 128_000,
	"gpt-4-turbo": 128_000,
	"gpt-4": 8_192,
	"gpt-3.5": 16_385,
	"gemini-1.5-pro": 1_048_576,
	"gemini-1.5-flash": 1_048_576,
};

/** Warn when estimated usage exceeds this fraction of the context window. */
const WARN_THRESHOLD = 0.75;

/** Characters per token (GPT-4 empirical average). */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the number of tokens in a string.
 * Uses the simple heuristic: tokens ≈ charCount / 4.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Look up the context window size for a model ID.
 * Falls back to 200 000 (Claude default) if the model is unknown.
 */
export function contextWindowFor(modelId: string): number {
	const lower = modelId.toLowerCase();
	for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (lower.includes(prefix)) return size;
	}
	return 200_000; // safe default for unknown models
}

export interface TokenBudget {
	/** Accumulated estimated tokens so far in this session turn. */
	used: number;
	/** Remaining tokens before hitting the warning threshold. */
	remaining: number;
	/** Whether the warning threshold has been exceeded. */
	warnExceeded: boolean;
	/** The full context window for the model. */
	window: number;
	/** Usage as a fraction 0–1. */
	fraction: number;
}

/**
 * A mutable token accumulator for a single pipeline run.
 * Create one per `runUserMessage` call and pass it to agents.
 */
export class TokenTracker {
	private _used = 0;
	private readonly _window: number;

	constructor(modelId: string) {
		this._window = contextWindowFor(modelId);
	}

	/** Add `tokens` (or estimate from a string) to the running total. */
	add(tokensOrText: number | string): void {
		const n =
			typeof tokensOrText === "string"
				? estimateTokens(tokensOrText)
				: tokensOrText;
		this._used += n;
	}

	/** Current budget snapshot. */
	get budget(): TokenBudget {
		const fraction = this._used / this._window;
		const warnThreshold = Math.floor(this._window * WARN_THRESHOLD);
		return {
			used: this._used,
			remaining: Math.max(0, warnThreshold - this._used),
			warnExceeded: this._used >= warnThreshold,
			window: this._window,
			fraction,
		};
	}

	/** Total tokens used. */
	get used(): number {
		return this._used;
	}
}

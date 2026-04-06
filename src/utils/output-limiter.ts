/**
 * output-limiter.ts
 *
 * Limits the size of shell / tool output returned to the agent context.
 * Large outputs can exhaust the context window and degrade performance.
 *
 * Ported and adapted from badlogic/pi-mono bash-executor rolling-buffer pattern.
 */

/** Default ceiling in bytes (32 KiB). Override via PI_OUTPUT_MAX_BYTES env var. */
export const DEFAULT_MAX_BYTES = 32 * 1024;

/**
 * How many bytes of the tail to preserve when the output exceeds the limit.
 * pi-mono keeps the most recent content (the tail) because it is typically
 * the most actionable (compilation errors, final log lines, etc.).
 */
export const TAIL_BYTES = 4 * 1024;

export interface LimitResult {
	/** Possibly-truncated output text, ready to return to the agent. */
	text: string;
	/** True if the original output was truncated. */
	truncated: boolean;
	/** Original byte length before truncation. */
	originalBytes: number;
}

/**
 * Truncates `text` to `maxBytes`, preserving the first portion and a
 * configurable tail.  A clear truncation notice is inserted at the cut point
 * so the agent understands what happened.
 *
 * @param text     Raw output string.
 * @param maxBytes Hard ceiling in bytes (default: `DEFAULT_MAX_BYTES`).
 */
export function limitOutput(
	text: string,
	maxBytes: number = Number(process.env.PI_OUTPUT_MAX_BYTES ?? "") ||
		DEFAULT_MAX_BYTES,
): LimitResult {
	const buf = Buffer.from(text, "utf8");
	const originalBytes = buf.length;

	if (originalBytes <= maxBytes) {
		return { text, truncated: false, originalBytes };
	}

	// Keep `headBytes` from the front and `TAIL_BYTES` from the back.
	const tailBytes = Math.min(TAIL_BYTES, Math.floor(maxBytes / 2));
	const headBytes = maxBytes - tailBytes;

	const head = buf.subarray(0, headBytes).toString("utf8");
	const tail = buf.subarray(buf.length - tailBytes).toString("utf8");
	const droppedBytes = originalBytes - headBytes - tailBytes;

	const notice = [
		"",
		`--- [OUTPUT TRUNCATED: ${originalBytes.toLocaleString()} bytes total;`,
		`     showing first ${headBytes.toLocaleString()} bytes and last ${tailBytes.toLocaleString()} bytes.`,
		`     ${droppedBytes.toLocaleString()} bytes omitted. Set PI_OUTPUT_MAX_BYTES to raise the limit.] ---`,
		"",
	].join("\n");

	return {
		text: head + notice + tail,
		truncated: true,
		originalBytes,
	};
}

/**
 * Convenience: apply `limitOutput` to every text chunk in a tool result
 * content array.  Returns the guarded content and an overall `truncated` flag.
 */
export function limitToolOutput(
	content: Array<{ type: string; text?: string; [k: string]: unknown }>,
	maxBytes?: number,
): {
	content: Array<{ type: string; text?: string; [k: string]: unknown }>;
	truncated: boolean;
} {
	let anyTruncated = false;
	const out = content.map((chunk) => {
		if (chunk.type !== "text" || typeof chunk.text !== "string") return chunk;
		const result = limitOutput(chunk.text, maxBytes);
		if (result.truncated) anyTruncated = true;
		return { ...chunk, text: result.text };
	});
	return { content: out, truncated: anyTruncated };
}

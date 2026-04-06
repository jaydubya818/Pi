/**
 * output-guard.ts
 *
 * Redacts sensitive data from agent tool output before it is stored in
 * session events or returned to the LLM context.
 *
 * Ported and adapted from badlogic/pi-mono output-guard pattern.
 */

/** Replacement token used wherever a secret is detected. */
const REDACTED = "[REDACTED]";

/**
 * Ordered list of patterns that indicate sensitive content.
 * Patterns are applied in sequence; the first match wins for each line.
 */
const SENSITIVE_PATTERNS: { label: string; re: RegExp }[] = [
	// PEM private/public key blocks (multi-line)
	{
		label: "pem_key",
		re: /-----BEGIN [A-Z ]+-----[\s\S]{4,}?-----END [A-Z ]+-----/g,
	},
	// JWT tokens (header.payload.signature – all base64url parts ≥10 chars each)
	{
		label: "jwt",
		re: /ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	},
	// AWS access key IDs
	{
		label: "aws_key",
		re: /AKIA[0-9A-Z]{16}/g,
	},
	// Authorization: Bearer / Basic / Token headers
	{
		label: "auth_header",
		re: /\b(Authorization|X-Api-Key|X-Auth-Token)\s*:\s*(Bearer|Basic|Token|AWS4-HMAC-SHA256)\s+[A-Za-z0-9+/_.=~-]{8,}/gi,
	},
	// key=value assignments where the key looks like a secret
	{
		label: "secret_assignment",
		re: /\b(password|passwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*[^\s&;,\n'"]{8,}/gi,
	},
	// Quoted secret assignments  (password="value")
	{
		label: "secret_assignment_quoted",
		re: /\b(password|passwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["'][^"']{8,}["']/gi,
	},
	// Long base64-like strings that are likely tokens (≥40 contiguous chars)
	{
		label: "base64_token",
		re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g,
	},
];

/**
 * Redacts known sensitive patterns from a text string.
 * Returns the sanitised version along with how many replacements were made.
 */
export function redactSensitive(text: string): {
	text: string;
	replacements: number;
} {
	let out = text;
	let replacements = 0;

	for (const { re } of SENSITIVE_PATTERNS) {
		// Reset lastIndex for global regexes between calls
		re.lastIndex = 0;
		const before = out;
		out = out.replace(re, (match, ...groups) => {
			// For key=value patterns, preserve the key part, only redact the value.
			// The key is in capture group 1 when present.
			const key = typeof groups[0] === "string" ? groups[0] : null;
			if (key && match.includes(key)) {
				const valueStart = match.indexOf(key) + key.length;
				const separator =
					match.slice(valueStart).match(/^(\s*[=:]\s*["']?)/)?.[0] ?? "=";
				return `${key}${separator}${REDACTED}`;
			}
			return REDACTED;
		});
		if (out !== before) replacements++;
	}

	return { text: out, replacements };
}

/**
 * Applies `redactSensitive` to every text chunk in a tool result's content
 * array, returning a new content array with secrets replaced.
 */
export function guardToolResult(
	content: Array<{ type: string; text?: string; [k: string]: unknown }>,
): Array<{ type: string; text?: string; [k: string]: unknown }> {
	return content.map((chunk) => {
		if (chunk.type !== "text" || typeof chunk.text !== "string") return chunk;
		const { text } = redactSensitive(chunk.text);
		return { ...chunk, text };
	});
}

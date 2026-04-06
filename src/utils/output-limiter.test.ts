#!/usr/bin/env tsx
/**
 * Tests for output-limiter.ts
 * Run: tsx src/utils/output-limiter.test.ts
 */

import {
	DEFAULT_MAX_BYTES,
	limitOutput,
	limitToolOutput,
} from "./output-limiter.js";

const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) failures.push(`FAIL [${label}]: got ${a}, want ${e}`);
}

function expectContains(label: string, text: string, needle: string): void {
	if (!text.includes(needle))
		failures.push(`FAIL [${label}]: expected "${needle}" in output`);
}

// ─── limitOutput ──────────────────────────────────────────────────────────────

{
	// Under limit: no truncation
	const short = "hello world";
	const r = limitOutput(short, 1000);
	expect("short: truncated=false", r.truncated, false);
	expect("short: text unchanged", r.text, short);
	expect(
		"short: originalBytes correct",
		r.originalBytes,
		Buffer.byteLength(short, "utf8"),
	);
}

{
	// Exactly at limit: no truncation
	const exactly = "x".repeat(100);
	const r = limitOutput(exactly, 100);
	expect("exact: truncated=false", r.truncated, false);
}

{
	// Over limit: truncation applied
	const big = "A".repeat(5000);
	const r = limitOutput(big, 1000);
	expect("big: truncated=true", r.truncated, true);
	expect("big: originalBytes=5000", r.originalBytes, 5000);
	expectContains("big: notice present", r.text, "[OUTPUT TRUNCATED");
	expectContains("big: originalBytes in notice", r.text, "5,000");
	// Output must NOT exceed significantly more than maxBytes (head + notice + tail)
	const outBytes = Buffer.byteLength(r.text, "utf8");
	if (outBytes > 1000 + 2000 /* notice size headroom */)
		failures.push(`FAIL [big: output too large]: ${outBytes} bytes`);
}

{
	// Tail content preserved
	const text = "HEAD".repeat(200) + "TAIL_MARKER".repeat(50);
	const r = limitOutput(text, 512);
	expect("tail: truncated=true", r.truncated, true);
	expectContains("tail: tail content preserved", r.text, "TAIL_MARKER");
}

{
	// Head content preserved
	const text = `HEAD_MARKER${"x".repeat(5000)}`;
	const r = limitOutput(text, 512);
	expectContains("head: head content preserved", r.text, "HEAD_MARKER");
}

// DEFAULT_MAX_BYTES exported and sane
if (DEFAULT_MAX_BYTES < 4096 || DEFAULT_MAX_BYTES > 1024 * 1024)
	failures.push(
		`FAIL [default size]: ${DEFAULT_MAX_BYTES} is out of expected range`,
	);

// ─── limitToolOutput ─────────────────────────────────────────────────────────

{
	const longText = "Z".repeat(5000);
	const content = [
		{ type: "text", text: longText },
		{ type: "image", data: "img", mimeType: "image/png" },
	];
	const { content: out, truncated } = limitToolOutput(content, 1000);
	expect("limitToolOutput: truncated=true", truncated, true);
	const textChunk = out[0];
	if (
		!textChunk ||
		textChunk.type !== "text" ||
		typeof textChunk.text !== "string"
	)
		failures.push("FAIL [limitToolOutput]: missing text chunk");
	else {
		expectContains(
			"limitToolOutput: notice in text",
			textChunk.text,
			"[OUTPUT TRUNCATED",
		);
	}
	// Image chunk untouched
	expect("limitToolOutput: image unchanged", out[1], content[1]);
}

{
	// Short content: no truncation
	const content = [{ type: "text", text: "short" }];
	const { truncated } = limitToolOutput(content, 1000);
	expect("limitToolOutput: short not truncated", truncated, false);
}

// ─── result ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
	process.stderr.write(`output-limiter: ${failures.length} failure(s)\n`);
	for (const f of failures) process.stderr.write(`  ${f}\n`);
	process.exit(1);
}
process.stdout.write("output-limiter: ok\n");

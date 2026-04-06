#!/usr/bin/env tsx
/**
 * Tests for output-guard.ts
 * Run: tsx src/utils/output-guard.test.ts
 */

import { guardToolResult, redactSensitive } from "./output-guard.js";

const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) failures.push(`FAIL [${label}]: got ${a}, want ${e}`);
}

function expectContains(label: string, text: string, needle: string): void {
	if (!text.includes(needle))
		failures.push(
			`FAIL [${label}]: expected "${needle}" in "${text.slice(0, 120)}"`,
		);
}

function expectNotContains(label: string, text: string, needle: string): void {
	if (text.includes(needle))
		failures.push(
			`FAIL [${label}]: did NOT expect "${needle}" in "${text.slice(0, 120)}"`,
		);
}

// ─── redactSensitive ──────────────────────────────────────────────────────────

{
	const { text, replacements } = redactSensitive(
		"no secrets here, just plain text",
	);
	expectNotContains("plain-text unchanged", text, "[REDACTED]");
	expect("plain-text replacements=0", replacements, 0);
}

{
	const raw = "password=supersecret123";
	const { text } = redactSensitive(raw);
	expectNotContains("password= value gone", text, "supersecret123");
	expectContains("password= key preserved", text, "password");
}

{
	const raw = 'secret="my-very-secret-value"';
	const { text } = redactSensitive(raw);
	expectNotContains("secret= quoted value gone", text, "my-very-secret-value");
}

{
	const raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
	const { text } = redactSensitive(raw);
	expectNotContains(
		"auth header token gone",
		text,
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	);
}

{
	const raw = "AKIAIOSFODNN7EXAMPLE";
	const { text } = redactSensitive(raw);
	expectNotContains("aws key id gone", text, "AKIAIOSFODNN7EXAMPLE");
}

{
	// JWT with 3 base64url segments
	const jwt =
		"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
	const { text } = redactSensitive(jwt);
	expectNotContains(
		"jwt redacted",
		text,
		"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	);
}

{
	// Long base64-like string (≥40 chars)
	const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr==";
	const { text } = redactSensitive(`token ${b64}`);
	expectNotContains("long base64 gone", text, b64);
}

{
	// Short values should NOT be redacted (avoid false positives on short hashes)
	const raw = "password=short";
	const { text } = redactSensitive(raw);
	// "short" is only 5 chars which is below the ≥8 threshold — should not redact
	expectContains("short value preserved", text, "short");
}

{
	// PEM block
	const pem =
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
	const { text } = redactSensitive(pem);
	expectNotContains("pem key gone", text, "MIIEpAIBAAKCAQEA");
}

// ─── guardToolResult ──────────────────────────────────────────────────────────

{
	const content = [
		{ type: "text", text: "api_key=supersecretvalue123" },
		{ type: "image", data: "raw-image", mimeType: "image/png" },
	];
	const guarded = guardToolResult(content);
	const textChunk = guarded[0];
	if (
		!textChunk ||
		textChunk.type !== "text" ||
		typeof textChunk.text !== "string"
	)
		failures.push("FAIL [guardToolResult]: missing text chunk");
	else {
		expectNotContains(
			"guardToolResult: secret gone",
			textChunk.text,
			"supersecretvalue123",
		);
		expectContains("guardToolResult: key kept", textChunk.text, "api_key");
	}
	// Image chunk must be untouched
	expect("guardToolResult: image unchanged", guarded[1], content[1]);
}

// ─── result ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
	process.stderr.write(`output-guard: ${failures.length} failure(s)\n`);
	for (const f of failures) process.stderr.write(`  ${f}\n`);
	process.exit(1);
}
process.stdout.write("output-guard: ok\n");

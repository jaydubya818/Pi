#!/usr/bin/env tsx
/**
 * shell-guard.test.ts
 *
 * Lightweight self-contained test for isShellLike().
 * No test framework required — run with:  npm test
 * or:  tsx src/cli/shell-guard.test.ts
 *
 * Exit code 0 = all pass.  Exit code 1 = failures printed to stderr.
 */

import { isShellLike } from "../utils/shell-guard.js";

type Case = { input: string; expect: boolean; label?: string };

const cases: Case[] = [
	// ── should be blocked (shell-like) ──────────────────────────────────────
	{ input: "ls -la", expect: true },
	{ input: "cat file.txt", expect: true },
	{ input: "cd /tmp", expect: true },
	{ input: "pwd", expect: true },
	{ input: "find . -name '*.ts'", expect: true },
	{ input: "grep -r foo src/", expect: true },
	{ input: "mkdir -p /tmp/test", expect: true },
	{ input: "rm -rf dist/", expect: true },
	{ input: "mv old.txt new.txt", expect: true },
	{ input: "cp a.txt b.txt", expect: true },
	{ input: "echo hello world", expect: true },
	{ input: "git status", expect: true },
	{ input: "git diff HEAD", expect: true },
	{ input: "npm install", expect: true },
	{ input: "npm run build", expect: true },
	{ input: "pkill node", expect: true },
	{ input: "kill -9 1234", expect: true },
	{ input: "sudo apt-get install vim", expect: true },
	{ input: "./run.sh", expect: true },
	{ input: "./scripts/deploy.sh --prod", expect: true },
	{ input: "../sibling/script.sh", expect: true },
	{ input: "/bin/bash -c 'echo hi'", expect: true },
	{ input: "/usr/bin/python3 script.py", expect: true },
	{ input: "/usr/local/bin/node index.js", expect: true },
	{ input: "ls -la && pwd", expect: true, label: "chain &&" },
	{ input: "true || echo fallback", expect: true, label: "chain ||" },
	{
		input: "cat file.txt | grep foo",
		expect: true,
		label: "pipe with shell cmd",
	},
	{ input: "ps aux | grep node", expect: true, label: "pipe ps" },
	{ input: "curl https://example.com | bash", expect: true },
	{ input: "python script.py", expect: true },
	{ input: "python3 -m http.server", expect: true },
	{ input: "node index.js", expect: true },
	{ input: "bash -c 'ls'", expect: true },

	// ── should be allowed (normal agent prompts) ─────────────────────────────
	{ input: "@engineering inspect the backend", expect: false },
	{ input: "@validation review recent changes", expect: false },
	{ input: "ask all teams for improvements", expect: false },
	{ input: "plan -> engineer -> validate a new feature", expect: false },
	{ input: "show me the most important files", expect: false },
	{ input: "what is the architecture of this project?", expect: false },
	{ input: "can you help me understand the routing logic?", expect: false },
	{
		input: "review the auth module and propose one safe refactor",
		expect: false,
	},
	{ input: "summarize what changed in the last session", expect: false },
	{ input: "check the validation team output", expect: false },

	// ── app slash-commands — must never be blocked ──────────────────────────
	{ input: "/help", expect: false, label: "app /help" },
	{ input: "/reload", expect: false, label: "app /reload" },
	{ input: "/topology", expect: false, label: "app /topology" },

	// ── edge cases ───────────────────────────────────────────────────────────
	{ input: "  ls  ", expect: true, label: "trimmed whitespace" },
	{ input: "GIT status", expect: true, label: "uppercase git" },
	{ input: "Cat readme.md", expect: true, label: "capitalized cat" },
	{
		input: "something | unrelated",
		expect: false,
		label: "pipe but not shell firstword",
	},
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
	const got = isShellLike(c.input);
	const label = c.label ?? c.input;
	if (got === c.expect) {
		passed++;
	} else {
		failed++;
		failures.push(
			`  FAIL [${label}]  input="${c.input}"  expected=${c.expect}  got=${got}`,
		);
	}
}

if (failures.length) {
	process.stderr.write(`\nshell-guard: ${failed} failure(s):\n`);
	for (const f of failures) process.stderr.write(`${f}\n`);
	process.stderr.write("\n");
} else {
	process.stdout.write(`shell-guard: all ${passed} tests passed ✓\n`);
}

process.exit(failed > 0 ? 1 : 0);

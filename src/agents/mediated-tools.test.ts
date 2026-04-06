#!/usr/bin/env tsx

import { resolve } from "node:path";
import { collectShellIntents } from "./mediated-tools.js";

const cwd = "/repo";
const failures: string[] = [];

function expectOk(command: string, summary: string): void {
	const result = collectShellIntents(command, cwd);
	if (!result.ok) {
		failures.push(`${summary}: expected ok, got ${result.code}`);
	}
}

function expectBlocked(command: string, code: string, summary: string): void {
	const result = collectShellIntents(command, cwd);
	if (result.ok || result.code !== code) {
		failures.push(
			`${summary}: expected blocked ${code}, got ${result.ok ? "ok" : result.code}`,
		);
	}
}

const readResult = collectShellIntents("cat README.md", cwd);
if (!readResult.ok) failures.push("cat README.md should be mediated as read");
else if (readResult.intents[0]?.path !== resolve(cwd, "README.md")) {
	failures.push("cat README.md should normalize read path");
}

const writeResult = collectShellIntents("touch src/new-file.ts", cwd);
if (!writeResult.ok) failures.push("touch should be mediated as write");
else if (writeResult.intents[0]?.kind !== "write") {
	failures.push("touch should emit write intent");
}

const copyResult = collectShellIntents("cp src/a.txt dist/b.txt", cwd);
if (!copyResult.ok) failures.push("cp should be mediated");
else {
	const kinds = copyResult.intents.map((intent) => intent.kind).join(",");
	if (kinds !== "read,write") {
		failures.push(`cp should emit read,write intents; got ${kinds}`);
	}
}

const pipedResult = collectShellIntents(
	"cat README.md | tee artifacts/out.txt",
	cwd,
);
if (!pipedResult.ok) failures.push("piped cat|tee should be mediated");
else {
	const kinds = pipedResult.intents.map((intent) => intent.kind).join(",");
	if (kinds !== "read,write") {
		failures.push(`cat|tee should emit read,write intents; got ${kinds}`);
	}
}

expectOk("grep foo src/index.ts", "grep path mediation");
expectBlocked(
	"tar -xf /tmp/archive.tar",
	"unmediated_shell_path",
	"unknown shell command with explicit path",
);
expectBlocked(
	"echo $(pwd)",
	"shell_substitution",
	"command substitution should be blocked",
);
expectBlocked(
	"cat ~/.ssh/config",
	"shell_home_path",
	"home-directory paths should be blocked",
);

if (failures.length > 0) {
	process.stderr.write(`mediated-tools: ${failures.length} failure(s)\n`);
	for (const failure of failures) process.stderr.write(`- ${failure}\n`);
	process.exit(1);
}

process.stdout.write("mediated-tools: ok\n");

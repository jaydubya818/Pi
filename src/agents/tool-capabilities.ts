export type ToolCapability =
	| "read"
	| "write"
	| "delete"
	| "shell"
	| "package"
	| "git"
	| "config"
	| "network"
	| "secrets_sensitive";

export type ToolCapabilityDescriptor = {
	name: string;
	capabilities: ToolCapability[];
};

const TOOL_CAPABILITY_REGISTRY: Record<string, ToolCapabilityDescriptor> = {
	read: { name: "read", capabilities: ["read"] },
	grep: { name: "grep", capabilities: ["read"] },
	find: { name: "find", capabilities: ["read"] },
	ls: { name: "ls", capabilities: ["read"] },
	write: { name: "write", capabilities: ["write"] },
	edit: { name: "edit", capabilities: ["write"] },
	bash: { name: "bash", capabilities: ["shell"] },
};

export function getToolDescriptor(
	toolName: string,
): ToolCapabilityDescriptor | null {
	return TOOL_CAPABILITY_REGISTRY[toolName] ?? null;
}

export function classifyShellCommandCapabilities(
	command: string,
): Set<ToolCapability> {
	const out = new Set<ToolCapability>(["shell"]);
	const c = command.toLowerCase();
	if (/\b(rm|rmdir|unlink)\b/.test(c)) out.add("delete");
	if (/\b(npm|yarn|pnpm|pip|brew)\b/.test(c)) out.add("package");
	if (/\bgit\b/.test(c)) out.add("git");
	if (
		/\b(vercel|docker|kubectl|terraform|ansible)\b/.test(c) ||
		/(^|\s)(config|settings)(\s|$)/.test(c)
	)
		out.add("config");
	if (/\b(curl|wget|nc|ssh|scp)\b/.test(c)) out.add("network");
	if (/\.(env|pem|key|p12|kdbx)\b/.test(c)) out.add("secrets_sensitive");
	return out;
}

// Seven-stage permission pipeline for Pi.
// 1. mode gate  2. enterprise deny  3. project deny  4. user deny
// 5. project allow  6. user allow  7. PreToolUse hook
//
// Deny always wins over allow at the same scope. Higher scope (enterprise)
// always wins over lower scope (user).

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { ToolCall } from "../types";

export type Mode = "default" | "acceptEdits" | "bypass" | "plan";

export interface Rule {
  tool: string; // glob: "bash", "*", "write"
  match?: string; // glob over stringified input
  effect: "allow" | "deny";
}

export interface PermissionConfig {
  mode: Mode;
  rules: Rule[];
}

export interface PipelineDeps {
  mode: Mode;
  hooks: { emit(event: string, payload: any): Promise<any> };
  enterpriseRules?: Rule[];
  projectRules?: Rule[];
  userRules?: Rule[];
  promptUser?(call: ToolCall, reason: string): Promise<boolean>;
}

export async function runPermissionPipeline(
  call: ToolCall,
  deps: PipelineDeps
): Promise<{ allow: boolean; reason?: string }> {
  // Stage 1: mode gate
  if (deps.mode === "bypass") return { allow: true };
  if (deps.mode === "plan" && isMutating(call)) {
    return { allow: false, reason: "plan mode: mutating tools blocked" };
  }

  // Stages 2-4: deny rules, highest scope first
  for (const [scope, rules] of [
    ["enterprise", deps.enterpriseRules],
    ["project", deps.projectRules],
    ["user", deps.userRules],
  ] as const) {
    for (const r of rules ?? []) {
      if (r.effect === "deny" && matches(r, call)) {
        return { allow: false, reason: `${scope} deny: ${r.tool}` };
      }
    }
  }

  // Stages 5-6: allow rules
  let explicitAllow = false;
  for (const rules of [deps.projectRules, deps.userRules]) {
    for (const r of rules ?? []) {
      if (r.effect === "allow" && matches(r, call)) {
        explicitAllow = true;
        break;
      }
    }
  }

  // Stage 7: PreToolUse hook (escape hatch)
  const hookResult = await deps.hooks.emit("PreToolUse", { call });
  if (hookResult?.decision === "block") {
    return { allow: false, reason: hookResult.reason ?? "hook blocked" };
  }
  if (hookResult?.decision === "approve") return { allow: true };

  if (explicitAllow) return { allow: true };
  if (deps.mode === "acceptEdits" && isEdit(call)) return { allow: true };

  // Fall through → ask user
  if (deps.promptUser) {
    const ok = await deps.promptUser(call, "no matching rule");
    return { allow: ok, reason: ok ? undefined : "user denied" };
  }
  return { allow: false, reason: "no matching allow rule and no UI" };
}

function matches(rule: Rule, call: ToolCall): boolean {
  if (!globMatch(rule.tool, call.name)) return false;
  if (rule.match && !globMatch(rule.match, JSON.stringify(call.input))) return false;
  return true;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(value);
}

const MUTATING = new Set(["bash", "write", "edit", "git_commit"]);
function isMutating(c: ToolCall) {
  return MUTATING.has(c.name);
}
function isEdit(c: ToolCall) {
  return c.name === "edit" || c.name === "write";
}

// ---------- loader ----------
export async function loadRulesHierarchy(repoRoot: string) {
  return {
    enterpriseRules: await tryLoad("/etc/pi/permissions.json"),
    projectRules: await tryLoad(path.join(repoRoot, ".pi/permissions.json")),
    userRules: await tryLoad(path.join(os.homedir(), ".pi/permissions.json")),
  };
}

async function tryLoad(p: string): Promise<Rule[]> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")).rules ?? [];
  } catch {
    return [];
  }
}

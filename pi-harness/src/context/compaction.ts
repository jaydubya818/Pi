// Four-strategy compaction hierarchy: cheapest first.
// 1. microcompact   — dedupe identical tool results (zero model calls)
// 2. snipCompact    — drop oldest, preserve protectedTail
// 3. autoCompact    — summarize prior conversation with cheap model
// 4. contextCollapse — multi-phase staged compression

import crypto from "node:crypto";
import type { Message } from "../types";

const PROTECTED_TAIL = 12;
const SOFT_LIMIT_RATIO = 0.75;

export interface Budget {
  contextLimit: number;
  outputFloor: number;
}

export interface CompactionResult {
  messages: Message[];
  strategy: string | null;
}

export async function runCompactionPipeline(
  messages: Message[],
  budget: Budget
): Promise<CompactionResult> {
  // Always run microcompact (free).
  let out = microcompact(messages);
  let strategy: string | null = out !== messages ? "microcompact" : null;

  const tokens = approxTokens(out);
  if (tokens < budget.contextLimit * SOFT_LIMIT_RATIO) return { messages: out, strategy };

  // Snip
  out = snipCompact(out);
  strategy = "snip";
  if (approxTokens(out) < budget.contextLimit * SOFT_LIMIT_RATIO) return { messages: out, strategy };

  // Auto-compact (summarize) — caller should inject summarizer model
  out = await autoCompact(out);
  strategy = "auto";
  if (approxTokens(out) < budget.contextLimit * SOFT_LIMIT_RATIO) return { messages: out, strategy };

  // Last resort
  out = await contextCollapse(out);
  return { messages: out, strategy: "collapse" };
}

// ---------- 1. microcompact ----------
export function microcompact(messages: Message[]): Message[] {
  const seen = new Map<string, string>(); // hash → first toolUseId
  let mutated = false;
  const out = messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const newContent = m.content.map((c: any) => {
      if (c.type !== "tool_result") return c;
      const key = hash({ id: c.tool_use_id_origin ?? c.tool_use_id, content: c.content });
      const ref = seen.get(key);
      if (ref) {
        mutated = true;
        return { type: "tool_result", tool_use_id: c.tool_use_id, content: `[ref:${ref}]` };
      }
      seen.set(key, c.tool_use_id);
      return c;
    });
    return { ...m, content: newContent };
  });
  return mutated ? out : messages;
}

// ---------- 2. snipCompact ----------
export function snipCompact(messages: Message[]): Message[] {
  if (messages.length <= PROTECTED_TAIL + 2) return messages;
  // Always preserve the first system-context user message + the protected tail.
  return [messages[0], ...messages.slice(-PROTECTED_TAIL)];
}

// ---------- 3. autoCompact (LLM summarization) ----------
export async function autoCompact(messages: Message[]): Promise<Message[]> {
  // Hook in your cheap-model summarizer here. Track a generation counter on
  // the resulting summary message to prevent recursive summarization loops.
  const head = messages.slice(0, -PROTECTED_TAIL);
  const tail = messages.slice(-PROTECTED_TAIL);
  const summary: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<conversation_summary generation="1">\n${summarize(head)}\n</conversation_summary>`,
      },
    ],
  };
  return [summary, ...tail];
}

// ---------- 4. contextCollapse ----------
export async function contextCollapse(messages: Message[]): Promise<Message[]> {
  // Phase A: collapse tool results to refs.
  // Phase B: drop thinking blocks.
  // Phase C: summarize entire sections.
  return autoCompact(messages); // simplified
}

// ---------- helpers ----------
function approxTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function hash(obj: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

function summarize(messages: Message[]): string {
  return `[${messages.length} earlier messages elided — TODO: call summarizer model]`;
}

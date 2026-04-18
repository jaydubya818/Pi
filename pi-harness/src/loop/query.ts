// Pi extension: production agent loop as async generator.
// Mirrors Claude Code's query.ts five-phase iteration but built on Pi's
// multi-provider ModelClient (15+ providers, normalized at the edge).

import type { ModelClient, StreamEvent, Message, Tool } from "../types";
import { StreamingToolExecutor } from "../tools/streamingExecutor";
import { withRetry } from "../retry/withRetry";
import { runCompactionPipeline } from "../context/compaction";
import { applyToolResultBudget } from "../tools/budget";
import { runPermissionPipeline } from "../permissions/pipeline";

export interface QueryDeps {
  model: ModelClient;
  tools: Map<string, Tool<any, any>>;
  systemPrompt: Array<{ type: "text"; text: string; cache_control?: any }>;
  abortSignal: AbortSignal;
  maxTurns: number;
  hooks: { emit(event: string, payload: any): Promise<any> };
}

export interface QueryState {
  messages: Message[];
  turn: number;
  lastStopReason?: string;
  budget: { contextLimit: number; outputFloor: number };
}

export type Event =
  | StreamEvent
  | { type: "tool_result"; toolUseId: string; content: any; isError?: boolean }
  | { type: "compacted"; strategy: string }
  | { type: "turn_end" };

export async function* query(
  deps: QueryDeps,
  state: QueryState
): AsyncGenerator<Event> {
  await deps.hooks.emit("SessionStart", { state });

  while (state.turn < deps.maxTurns) {
    if (deps.abortSignal.aborted) return;

    // === Phase 1: Setup — compact + budget ===
    const compactResult = await runCompactionPipeline(state.messages, state.budget);
    state.messages = compactResult.messages;
    if (compactResult.strategy) yield { type: "compacted", strategy: compactResult.strategy };
    applyToolResultBudget(state.messages);

    // === Phase 2: Model invocation with retry + mid-stream tool exec ===
    const exec = new StreamingToolExecutor(deps.tools, deps.abortSignal);

    const stream = withRetry(
      () =>
        deps.model.stream({
          system: deps.systemPrompt,
          messages: state.messages,
          tools: [...deps.tools.values()].map((t) => t.schema),
          maxOutputTokens: state.budget.outputFloor,
        }),
      { state, deps }
    );

    let assistantMessage: Message = { role: "assistant", content: [] };

    for await (const ev of stream) {
      switch (ev.type) {
        case "text_delta":
          assistantMessage.content.push({ type: "text", text: ev.text });
          break;
        case "tool_use_stop": {
          // Permission gate BEFORE dispatch
          const decision = await runPermissionPipeline(ev.toolCall, deps);
          if (decision.allow) {
            assistantMessage.content.push({ type: "tool_use", ...ev.toolCall });
            exec.dispatch(ev.toolCall); // start mid-stream
          } else {
            exec.injectError(ev.toolCall.id, decision.reason ?? "denied");
          }
          break;
        }
        case "message_stop":
          state.lastStopReason = ev.stopReason;
          break;
      }
      yield ev;
    }

    state.messages.push(assistantMessage);

    // === Phase 4: Drain remaining tool results in original order ===
    const results = await exec.drain();
    if (results.length) {
      state.messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      });
      for (const r of results) yield { type: "tool_result", ...r };
    }

    yield { type: "turn_end" };

    // === Phase 5: Continue? ===
    if (state.lastStopReason !== "tool_use") return;
    state.turn++;
  }
}

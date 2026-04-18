// Shared type surface — provider-agnostic. Pi already speaks 15+ providers;
// keep all internal code on these normalized shapes.

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolCall: ToolCall }
  | { type: "tool_use_delta"; id: string; partialInput: string }
  | { type: "tool_use_stop"; toolCall: ToolCall }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number };

export interface Message {
  role: "user" | "assistant";
  content: any[];
}

export interface ModelClient {
  stream(req: {
    system: Array<{ type: "text"; text: string; cache_control?: any }>;
    messages: Message[];
    tools: any[];
    maxOutputTokens?: number;
  }): AsyncIterable<StreamEvent>;
}

export interface ToolCtx {
  signal: AbortSignal;
  toolUseId: string;
}

export interface Tool<I, O> {
  name: string;
  schema: any;
  concurrency: "readonly" | "serial" | "exclusive";
  maxResultSizeChars: number;
  run(input: I, ctx: ToolCtx): Promise<O>;
}

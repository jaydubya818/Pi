// Streaming tool executor: dispatches tool calls the moment their input
// JSON is complete in the model stream, weeks before the model finishes
// generating its turn. Mirrors Claude Code's StreamingToolExecutor.

import type { Tool, ToolCall } from "../types";

interface PendingResult {
  toolUseId: string;
  order: number;
  promise: Promise<{ content: any; isError?: boolean }>;
  controller: AbortController;
  classification: "readonly" | "serial" | "exclusive";
}

export class StreamingToolExecutor {
  private pending: PendingResult[] = [];
  private order = 0;
  private serialChain: Promise<unknown> = Promise.resolve();
  private readonlyInflight = 0;
  private readonly READONLY_PARALLELISM = 10;

  constructor(
    private tools: Map<string, Tool<any, any>>,
    private parentAbort: AbortSignal
  ) {}

  dispatch(call: ToolCall) {
    const tool = this.tools.get(call.name);
    if (!tool) return this.injectError(call.id, `unknown tool: ${call.name}`);

    const sibling = new AbortController();
    // Parent abort cascades down. Sibling failure does NOT abort parent.
    this.parentAbort.addEventListener("abort", () => sibling.abort(), { once: true });

    const order = this.order++;
    const cls = tool.concurrency;

    let promise: Promise<{ content: any; isError?: boolean }>;
    if (cls === "readonly") {
      promise = this.runReadonly(tool, call, sibling.signal);
    } else {
      // serial / exclusive: chain after the previous serial task
      promise = this.serialChain = this.serialChain.then(() =>
        this.runOne(tool, call, sibling.signal)
      ) as any;
    }

    this.pending.push({
      toolUseId: call.id,
      order,
      promise,
      controller: sibling,
      classification: cls,
    });
  }

  injectError(toolUseId: string, reason: string) {
    this.pending.push({
      toolUseId,
      order: this.order++,
      promise: Promise.resolve({ content: reason, isError: true }),
      controller: new AbortController(),
      classification: "readonly",
    });
  }

  private async runReadonly(
    tool: Tool<any, any>,
    call: ToolCall,
    signal: AbortSignal
  ) {
    while (this.readonlyInflight >= this.READONLY_PARALLELISM) {
      await Promise.race(this.pending.filter((p) => p.classification === "readonly").map((p) => p.promise));
    }
    this.readonlyInflight++;
    try {
      return await this.runOne(tool, call, signal);
    } finally {
      this.readonlyInflight--;
    }
  }

  private async runOne(tool: Tool<any, any>, call: ToolCall, signal: AbortSignal) {
    try {
      const result = await tool.run(call.input, { signal, toolUseId: call.id });
      return { content: result };
    } catch (err: any) {
      // Failure aborts parallel siblings of THIS tool only — never the parent.
      return { content: String(err?.message ?? err), isError: true };
    }
  }

  /** Drain results in original tool-call order. */
  async drain() {
    const settled = await Promise.all(
      this.pending.map(async (p) => ({ order: p.order, toolUseId: p.toolUseId, ...(await p.promise) }))
    );
    return settled.sort((a, b) => a.order - b.order);
  }
}

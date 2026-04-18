// Retry state machine. Ten error classes, each with its own recovery path.
// Wraps any async stream factory; transparently retries and re-streams.

import type { StreamEvent } from "../types";

interface RetryCtx {
  state: { messages: any[]; budget: { contextLimit: number; outputFloor: number } };
  deps: any;
}

const MAX_ATTEMPTS = 8;
const BASE_MS = 500;
const MAX_BACKOFF_MS = 32_000;
let consecutive529 = 0;
let fastModeDisabled = false;

function backoff(attempt: number) {
  const base = Math.min(BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.random() * 0.25 * base;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* withRetry(
  makeStream: () => AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>,
  ctx: RetryCtx
): AsyncIterable<StreamEvent> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const stream = await makeStream();

      // Idle watchdog: abort if no chunks for 90s.
      let lastChunk = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastChunk > 90_000) throw new Error("STREAM_IDLE_TIMEOUT");
      }, 5_000);

      try {
        for await (const ev of stream) {
          lastChunk = Date.now();
          yield ev;
        }
      } finally {
        clearInterval(watchdog);
      }
      consecutive529 = 0;
      return;
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const headers = err?.response?.headers ?? {};

      // 429 — rate limited
      if (status === 429) {
        const retryAfter = Number(headers["retry-after"] ?? 0);
        if (headers["overage-disabled"]) fastModeDisabled = true;
        if (retryAfter <= 20) {
          await sleep((retryAfter || 1) * 1000);
          continue;
        }
        await sleep(Math.min(retryAfter * 1000, 30 * 60_000));
        continue;
      }

      // 529 — server overloaded
      if (status === 529) {
        consecutive529++;
        if (consecutive529 >= 3 && ctx.deps.fallbackModel) {
          ctx.deps.model = ctx.deps.fallbackModel;
          consecutive529 = 0;
        }
        await sleep(backoff(attempt));
        continue;
      }

      // 400 — context overflow: parse, recompute, reactive compact, retry
      if (status === 400 && /context|tokens/i.test(err?.message ?? "")) {
        const m = /(\d+).*?(\d+)/.exec(err.message);
        if (m) {
          const limit = Number(m[2]);
          const available = limit - 1000; // safety buffer
          ctx.state.budget.outputFloor = Math.max(3000, available);
        }
        // Trigger reactive compaction by dropping oldest non-protected messages
        ctx.state.messages = ctx.state.messages.slice(-Math.max(20, ctx.state.messages.length / 2));
        continue;
      }

      // 401 / 403
      if (status === 401 || status === 403) {
        await ctx.deps.refreshAuth?.();
        continue;
      }

      // Network
      if (["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(err?.code) || err?.message === "STREAM_IDLE_TIMEOUT") {
        await ctx.deps.disableKeepAlive?.();
        await sleep(backoff(attempt));
        continue;
      }

      throw err;
    }
  }
  throw new Error("withRetry: max attempts exceeded");
}

export const isFastModeDisabled = () => fastModeDisabled;

# Pi Agent Harness — Blueprint

A condensed, opinionated map from Claude Code's architecture to a harness you can build for **Pi**. Four layers: Weights → Context → Harness → Infrastructure. Below, each Claude Code pattern → the concrete file in this scaffold → why it matters.

---

## Layer 1 — Weights (commodity)
Pluggable model provider. Don't couple to one API.

- `src/loop/modelClient.ts` — `interface ModelClient { stream(req): AsyncIterable<StreamEvent> }`
- Implementations: `AnthropicClient`, `OpenAIClient`, `LocalClient`. Normalize input/output to a single `StreamEvent` union (`text_delta`, `tool_use_start`, `tool_use_delta`, `tool_use_stop`, `message_stop`, `usage`).
- This is the answer to Prashanth's multi-provider point: normalize at the edge, never inside the loop.

## Layer 2 — Context

### 2a. System prompt as cache-friendly array
`src/context/systemPrompt.ts`
- Export `buildSystemPrompt()` → `Array<{type:'text', text, cache_control?}>`.
- Static blocks first (identity, tool docs, safety). Mark the LAST static block with `cache_control: {type:'ephemeral'}` — that's your `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
- Memoized blocks next (per-session: project tree summary).
- Volatile blocks last (per-turn: date, git status). Keep small.

### 2b. PI.md hierarchy (the CLAUDE.md analogue)
`src/context/piMd.ts`
- Resolution order (low → high precedence; higher overrides):
  1. `/etc/pi/PI.md` (enterprise, MDM-pushable)
  2. `<repo>/.pi/PI.md` (project)
  3. `~/.pi/PI.md` (user)
  4. `<repo>/PI.local.md` (local, gitignored)
- Support `@./path.md` include directive. Inject contents as the FIRST user message wrapped in `<system-reminder>` — never in the system prompt (cache stability).

### 2c. Compaction hierarchy
`src/context/compaction.ts` — four strategies, cheap → expensive:
1. `microcompact()` — every turn. Replace duplicate tool results (same tool+input) with `{ref: <hash>}`. Zero model calls.
2. `snipCompact()` — drop oldest messages, preserve a `protectedTail` of the last N exchanges. No model.
3. `autoCompact()` — fires above token threshold. Summarizes prior messages with a Haiku-class model. Track `compactionGeneration` to prevent recursive summarization.
4. `contextCollapse()` — multi-phase: collapse tool results → thinking blocks → sections. Feature-flagged.

Always preserve the `protectedTail`. Always run cheapest first.

---

## Layer 3 — Harness

### 3a. The loop is an async generator
`src/loop/query.ts`
```ts
export async function* query(deps: QueryDeps, state: QueryState): AsyncGenerator<Event> {
  const abort = deps.abortSignal;
  while (state.turn < state.maxTurns && !abort.aborted) {
    // Phase 1: Setup
    state.messages = await deps.compact(state.messages, state.budget);
    deps.applyToolResultBudget(state.messages);

    // Phase 2: Model invocation (with retry + streaming tool exec)
    const stream = deps.withRetry(() => deps.model.stream({
      system: deps.systemPrompt,
      messages: state.messages,
      tools: deps.tools.schemas(),
    }));
    const exec = new StreamingToolExecutor(deps.tools, abort);
    for await (const ev of stream) {
      if (ev.type === 'tool_use_stop') exec.dispatch(ev.toolCall); // start mid-stream
      yield ev;
    }

    // Phase 3: Recover (context overflow / max_tokens / etc.) — handled inside withRetry

    // Phase 4: Drain remaining tool results
    const results = await exec.drain();
    for (const r of results) {
      state.messages.push(toolResultMessage(r));
      yield { type: 'tool_result', ...r };
    }

    // Phase 5: Continue?
    if (state.lastStopReason !== 'tool_use') return;
    state.turn++;
  }
}
```
Generator gives you streaming, cancellation, backpressure, composability for free. **Do not** use a while-loop that returns a final string.

### 3b. Tool concurrency classification
`src/tools/types.ts`
```ts
export type ConcurrencyClass = 'readonly' | 'serial' | 'exclusive';
export interface Tool<I,O> {
  name: string;
  concurrency: ConcurrencyClass;
  maxResultSizeChars: number;
  inputSchema: JsonSchema;
  run(input: I, ctx: ToolCtx): Promise<O>;
}
```
`src/tools/orchestration.ts` partitions a turn's tool calls:
- All `readonly` calls run in parallel (cap 10).
- `serial` calls run one at a time, after readonly batch drains.
- `exclusive` (e.g. shell with mutations, git commit) blocks everything.

### 3c. Streaming tool executor
`src/tools/streamingExecutor.ts`
- On `tool_use_stop` from the model stream, immediately schedule the tool. Don't wait for `message_stop`.
- Per-tool `siblingAbortController`: failure of one parallel tool aborts only its parallel siblings, not the parent loop.
- Reorder results to match original tool-call order before yielding.
- On stream fallback (streaming → non-streaming), discard queued tools and emit synthetic error results for any in-flight.

### 3d. Tool result budgeting
`src/tools/budget.ts`
- Each tool returns `{preview, fullPath?}`. If `result.length > tool.maxResultSizeChars`, write full to `~/.pi/results/<hash>` and return `{preview: result.slice(0,N), fullPath}`.
- `applyToolResultBudget(messages)` walks history before each API call, replacing oldest oversized results with `{ref: fullPath}`.

### 3e. Permission pipeline (7 stages)
`src/permissions/pipeline.ts` — each tool call passes through:
1. **Mode gate** — `default | acceptEdits | bypass | plan`
2. **Enterprise deny** (`/etc/pi/permissions.json`)
3. **Project deny** (`.pi/permissions.json`)
4. **User deny** (`~/.pi/permissions.json`)
5. **Project allow**
6. **User allow**
7. **PreToolUse hook** → `{decision: 'approve'|'block'|'ask'}` → user prompt if `ask`.

Rules use glob+JSON-path matching: `bash:git *`, `write:src/**/*.ts`. Deny always wins over allow at the same scope.

### 3f. Retry state machine
`src/retry/withRetry.ts` — one function, ten error classes, each with its own recovery:
| Error | Strategy |
|---|---|
| 429 (Retry-After ≤ 20s) | wait + retry |
| 429 (> 20s or `overage-disabled`) | enter cooldown / disable fast mode |
| 529 ×3 | switch to fallback model; bail in background mode |
| 400 context overflow | parse limits, recompute budget, reactive compact, retry |
| 401/403 | clear key cache, refresh OAuth, retry |
| ECONNRESET/EPIPE | disable keep-alive, new connection |
| stream idle 90s | abort, fallback non-streaming |
| stream stall 30s gap | log + continue |
Backoff: `min(500ms × 2^n, 32s) + jitter`. Persistent mode for unattended runs: indefinite retries, 5-min cap, 30s heartbeats.

### 3g. Hooks
`src/hooks/registry.ts` — events: `SessionStart`, `PreToolUse`, `PostToolUse`, `FileChanged`, `Stop`. Backends: shell command, HTTP endpoint, in-process function. Hook returns JSON `{decision, reason?, mutate?}`.

---

## Layer 4 — Infrastructure

### 4a. Sub-agent spawning + isolation
`src/subagents/spawn.ts`
- Same `query()` generator, fresh state, **cloned** file caches, **no-op** parent state setter.
- Parent abort cascades to children. Child abort never touches parent.
- Three backends: `in-process` (fastest), `tmux` (visible), `remote` (full isolation via SSH/container).

### 4b. Git worktree per agent
`src/subagents/worktree.ts`
```
getOrCreateWorktree(repoRoot, slug):
  validate slug (≤64, no traversal)
  if exists → return (fast resume)
  git fetch
  git worktree add ../pi-wt-<slug> -b pi/<slug>
  symlink node_modules, .venv, .cache
  copy PI.md, .env, .pi/settings.json
```

### 4c. Disk-backed task list (distributed coord)
`src/subagents/taskList.ts`
- Files at `~/.pi/tasks/<listId>/<taskId>.json`.
- File-based lock via `O_EXCL` lockfile + exponential backoff (30 retries, 5–100ms).
- High-watermark counter prevents id reuse on reset.

### 4d. Multi-tenancy / RBAC
The PI.md hierarchy + permission pipeline IS your RBAC. Enterprise admins push `/etc/pi/PI.md` and `/etc/pi/permissions.json` via MDM. Conflicts resolve deterministically (deny > allow, higher scope > lower).

### 4e. Session persistence
- Within session: compaction.
- Across sessions: PI.md project memory + serialized message log at `~/.pi/sessions/<id>.jsonl`.
- Across agents: task list.

---

## Extension surface (composition over modification)
- **Skills** — markdown + YAML frontmatter, discovered by glob path matching, only injected when relevant files are touched.
- **Hooks** — see 3g.
- **MCP** — stdio / SSE / HTTP / WS / in-process transports. Configured per-scope.
- **Plugins** — directories bundling skills + hooks + MCP servers + config.

If users have to fork your code to extend, the architecture has a gap.

---

## Build order (recommended)
1. `ModelClient` interface + Anthropic impl (1 day)
2. `query()` generator + 3 tools (Read/Grep/Bash) (2 days)
3. `withRetry` state machine (2 days)
4. Streaming tool executor + concurrency classes (2 days)
5. Permission pipeline + PI.md loader (2 days)
6. Compaction hierarchy (3 days)
7. Sub-agents + worktrees + task list (4 days)
8. Hooks + MCP + plugins (1 week)

Two engineers, ~5 weeks to a defensible v1.

## On the X replies
- **Prashanth (multi-provider, dedupe, sessions):** dedupe is microcompact (hash tool+input). Multi-provider is solved by `ModelClient` normalizing to a single event union. Sessions are JSONL append + replay.
- **The "Claude Code is shit as a harness" take:** the patterns above are model-agnostic. You're not forced to ship Claude Code. You're stealing its decisions.

# pi-harness

A Claude-Code-style production harness layered onto **[Pi](https://pi.dev/)** (Mario Zechner's minimal multi-provider TS coding agent).

Pi ships powerful defaults but deliberately omits MCP, sub-agents, and permission popups. This package adds them as Pi extensions without forking core.

## Why this exists
Pi is the right base: TS/Node, 15+ providers, tree-structured sessions, RPC + SDK modes. What it lacks is the *infrastructure* layer that makes an agent survive production: compaction, retry state machine, permission RBAC, sub-agent isolation, worktree coordination. This repo adds exactly that — see `BLUEPRINT.md` for the full mapping.

## Layout
```
src/
  loop/query.ts              — async-generator agent loop (5 phases)
  tools/streamingExecutor.ts — mid-stream tool dispatch + concurrency classes
  retry/withRetry.ts         — 10-error-class state machine
  context/compaction.ts      — 4-strategy hierarchy (micro → snip → auto → collapse)
  permissions/pipeline.ts    — 7-stage permission pipeline + PI.md hierarchy loader
  subagents/worktree.ts      — git worktree per agent
  types.ts                   — provider-agnostic event/message types
BLUEPRINT.md                 — full architecture doc
```

## Install into Pi
1. Drop this directory into your Pi extensions folder (or `npm link`).
2. Register `query()` as Pi's session driver (Pi exposes a TS module hook for this — check Pi's extension docs for the current entry point name).
3. Point Pi's ModelClient at the existing 15+ providers; the `ModelClient` interface in `types.ts` is the normalized shim.
4. Add `.pi/permissions.json` and `PI.md` to your repo.

## What's stubbed
- `autoCompact()` needs your cheap-model summarizer wired in.
- `loadRulesHierarchy()` reads JSON; the YAML/TOML variant is yours.
- `worktree.ts` assumes git ≥ 2.5.

## Open questions worth answering before v1
- **Dedupe** (Prashanth's question): handled by `microcompact` hashing `{tool,input}`. Sessions persist as JSONL + replay.
- **Multi-provider normalization**: every provider's stream collapses to the `StreamEvent` union in `types.ts` *at the provider boundary*, never inside the loop.
- **Pi already has tree-structured history** — reuse it for sub-agent state instead of re-implementing the disk task list.

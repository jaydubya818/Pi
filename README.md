# pi-multi-team-local

**Faithful local recreation of a multi-tier agent architecture using public Pi (`@mariozechner/pi-coding-agent`) capabilities.** This is not the private “video” codebase; it is a sibling control plane that composes multiple real `AgentSession` instances with YAML config, policy-mediation, contracts, and session artifacts.

## Current maturity

**Working today:** YAML config + Zod validation; orchestrator → teams → leads → workers; explicit per-team **task contracts** (`task_type`, `artifact_policy`, expected artifact kinds) enforced in envelopes; policy-mediated tools; delegation JSON contract + repair; session tree (events/conversation/routing JSONL); Ink TUI with worker toggle; **interactive supervised approvals** (1–4 keys) logging `approval_requested` / `approval_resolved`; structured **validation outcomes** (`validation_result`) with deterministic approval-gate state for later mutations in the same request; **post-turn expertise merge** into writable expert files (bounded sections, archives on growth) with `expertise_updated` events — `PI_EXPERTISE_DRY_RUN=1` during `npm run demo` so expert files are not modified; **replay** (`npm run replay -- <sessionDir>`, optional `--dump`, `--types=`, `--agent=`, `--team=`) plus Ink step mode (n/p/q); **token footer** (best-effort: mock estimates under `PI_MOCK`, otherwise labeled n/a); **`/reload`** in the TUI reloads `multi-team.yaml` between turns; optional **git session branch** (`git.create_session_branch`) and **supervised approval for `git commit`** when `commits_enabled` and `require_approval_before_commit` are set.

**Deferred / not claimed:** validation-failure-driven approval gates; accurate per-call token/cost from Pi SDK; automatic opening of artifact files from replay; multi-turn topology changes mid-flight.

## Why a sibling project (not a fork of pi-mono)

- **Pi has no built-in orchestrator / leads / workers hierarchy** — you orchestrate multiple sessions yourself ([Pi SDK](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)).
- **Keeps `pi-mono` untouched** — integration is via the published npm package only.
- **Trust boundaries belong in your app** — tool mediation, git artifacts, and autonomy live here.

## Architecture (short)

1. **Control plane** (this repo): routing, parallelism cap, approval gates, logging.
2. **Pi SDK**: one `createAgentSession()` per agent role with mediated tools only.
3. **Flow**: user → orchestrator → each **team** (sequential) → **lead** (envelope) → **workers** (batched parallel, `parallelism.max_parallel_workers`, default 2) → session artifacts.

```
User → Orchestrator session
     → Team lead session (JSON contract)
     → Worker sessions (parallel batches) → artifacts + envelope
     → summary.md, changed-files.json, git-diff.patch, events.jsonl, …
```

## Trust boundaries (architecture)

These are enforced in **code**, not by prompts alone.

1. **Tool mediation** — The control plane wraps Pi tools: every tool is checked against a declared capability registry (`read`, `write`, `delete`, `shell`, `package`, `git`, `config`, `network`, `secrets_sensitive`) before policy checks run. Unregistered tools are blocked by default. Registered actions then pass `PolicyEngine` checks, normalized paths (relative to each agent `workdir`), structured `policy_blocked` responses, optional supervised approvals, and append-only **`events.jsonl`** (`tool_started` / `tool_completed` / `policy_blocked`). Agents do not receive unmediated `createCodingTools` results.
2. **Git** — Session artifacts include **`changed-files.json`** and **`git-diff.patch`**. **`commits_enabled`** defaults to false; no auto-commit. Optional **`create_session_branch`** and supervised **`git commit`** when commits are enabled and **`require_approval_before_commit`** is set.
3. **Delegation contract** — Handoffs use a **Zod-validated** JSON envelope (first balanced `{…}` in output, one repair retry, then **`contract_error`**). Prose is not treated as structured data if parsing fails.

## Install

```bash
cd <your-workspace>/pi-multi-team-local
npm install
cp .env.example .env
# set ANTHROPIC_API_KEY for live runs
```

Reference monorepo (optional): `<your-workspace>/pi-mono`

## Run

```bash
npm run check-env
npm run start          # Ink TUI; Tab toggles workers; /reload config; Ctrl+C exit
PI_MOCK=1 npm run demo # no API keys — structure + artifact smoke test (expertise dry-run)
npm run replay -- .runtime/sessions/<id> --dump
npm run export-timeline -- .runtime/sessions/<id> [--out=./timeline.md]
```

Environment:

- **`PI_MOCK=1`** — skips LLM calls; still runs pipeline and writes session artifacts (for CI / layout tests).
- **`PI_APPROVAL_AUTO=1`** — auto-approves supervised gates (dev only).
- **`PI_EXPERTISE_DRY_RUN=1`** — log `expertise_updated` without writing expert files (set automatically for `npm run demo`).

## Config

Single file: [`config/multi-team.yaml`](config/multi-team.yaml)

- **Teams are data** — disable a team with `enabled: false`; add new teams in YAML without changing TypeScript topology types.
- **Autonomy**: `global_autonomy` and per-agent `autonomy`: `advisory` (read-only tools), `supervised` (writes/package commands may wait on approval), `active` (writes within domain; infra paths still constrained for non-active in policy).
- **Parallelism**: `parallelism.max_parallel_workers` (default 2). Orchestrator and leads run **sequentially**; workers run in bounded parallel batches.

## Policy & tool mediation

Every tool call goes through **`wrapAgentTools`** → `PolicyEngine` → Pi execution. Prompts are **not** the enforcement layer. Violations emit `policy_blocked` in `events.jsonl` and merge into `policy-violations.json`.

## Delegation contract

Leads and workers must return **machine-validated** JSON (Zod): `objective`, `status`, `summary`, `files_touched`, `artifacts`, `blockers`, `next_step`. Parser takes the **first balanced `{…}`**. One **repair** session retry on failure, then `contract_error` in events/UI.

## Sessions

Each user submit in the TUI uses a new session folder under `.runtime/sessions/<id>/` with:

- `conversation.jsonl`, `events.jsonl`, `routing-decisions.jsonl`, `topology.json`
- `summary.md`, `changed-files.json`, `artifacts.json`, `policy-violations.json`, `timing.json`, `git-diff.patch`
- `artifacts/`, `plans/`, `validation/`, `agents/`, …

Inspect:

```bash
npm run inspect-session -- .runtime/sessions/<id>
```

## Routing modes (heuristic)

| Mode | How triggered (examples) |
|------|---------------------------|
| freeform | default; all enabled teams in config order |
| `@planning` / `@engineering` / `@validation` | substring in message |
| ask all | “ask all teams …” |
| plan → engineer → validate | all three words in message |
| engineering-only / validation-only | phrases containing those |

## Honesty / limitations

- **Not identical** to any private multi-agent product; this is an implementation against public Pi + your spec.
- **Heuristic routing** — not an LLM-only router; orchestrator still runs for narrative synthesis.
- **Timeout cancellation** — `AgentSession.abort()` is wired for timeout paths. If an operation still finishes after abandonment, the late result is logged as `late_result_ignored` and excluded from synthesis.
- **Live cost/token attribution** — footer is best-effort; Pi SDK usage hooks can replace mock estimates.

## Demo prompts (also used in `npm run demo`)

1. Show important files  
2. Ask all teams for improvements  
3. Plan → engineer → validate  
4. `@engineering` backend refactor suggestion  
5. `@validation` risk review  

## Scoring (quick)

- **Runnable**: yes (`PI_MOCK=1 npm run demo`)
- **Policy-enforced**: mediation + domain paths in code
- **Contracts**: Zod + repair + `contract_error`
- **Inspectable**: JSONL + session files

## License

MIT (match Pi ecosystem; adjust if your org requires otherwise).

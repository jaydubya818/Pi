# pi-multi-team-local

**Faithful local recreation of a multi-tier agent architecture using public Pi (`@mariozechner/pi-coding-agent`) capabilities.** This is not the private “video” codebase; it is a sibling control plane that composes multiple real `AgentSession` instances with YAML config, policy-mediation, contracts, and session artifacts.

## Current Maturity

### Status
**Operator-grade supervised local multi-agent system** built on public Pi capabilities.

This project is a faithful local recreation of the multi-team orchestration architecture using:
- public Pi SDK/runtime capabilities
- a separate control plane
- code-enforced policy boundaries
- structured task contracts
- declared tool capability mediation
- structured validation gating
- per-request session isolation
- durable session artifacts and replay/export support

It is **not** a copy of any private repository or private Pi implementation.

---

## What This System Can Do

The system supports a supervised multi-agent workflow where:

- a single user prompt enters through the orchestrator
- the orchestrator routes work to configured team leads
- leads delegate work to workers
- workers operate within code-enforced domain boundaries
- results are synthesized back through the hierarchy
- every top-level request gets its own isolated session
- session logs, routing decisions, artifacts, validation outcomes, and policy violations are persisted

Current capabilities include:

- YAML-driven team topology
- per-agent models, workdirs, skills, and expertise files
- strict delegation envelopes with contract validation and repair retry
- artifact accountability based on explicit task contracts
- central tool capability registry with default-deny for unknown tools
- policy enforcement for reads, writes, deletes, shell, package, git, config, and secrets-sensitive operations
- supervised approval gates for risky actions
- structured validation results that can gate further mutation
- replay/export foundations and durable session summaries

---

## Trust Boundaries

This system is designed around explicit trust boundaries.

### 1. Control plane over agent runtime
Pi sessions are used as agent runtimes.
All orchestration, policy checks, approvals, contracts, and synthesis happen in the control plane.

### 2. Tool mediation is enforced in code
Agents do not directly receive unrestricted mutating tools.
All tool access flows through mediation layers that apply:
- declared tool capabilities
- path/domain policy
- approval gating
- validation-state gating
- logging and audit trails

Unknown or unregistered tools are denied by default.

### 3. Git is treated as a trust boundary
The system produces:
- `changed-files.json`
- `git-diff.patch`
- session summaries of modified files

No automatic commit behavior is assumed unless explicitly enabled and gated.

### 4. Contracts over prose
Inter-agent coordination is validated through structured contracts rather than relying on freeform prose.
This includes:
- task contracts
- delegation envelopes
- validation result contracts
- artifact obligations

### 5. Sessions are first-class artifacts
Each top-level request gets its own session directory with isolated logs, events, artifacts, prompts, and summaries.

---

## Known Operational Caveat

### Cancellation boundary
Timeouts and cancellation are robust at the orchestration layer:
- timed-out agent work is aborted where supported
- abandoned work is marked explicitly
- late results are ignored and cannot contaminate final synthesis

However, **absolute prevention of every external side effect cannot be guaranteed** once a downstream tool or runtime has already begun acting outside the control plane.

In practice, this means:
- orchestration remains correct and bounded
- synthesis ignores abandoned/late work
- audit logs remain accurate
- but hard kill guarantees depend on downstream runtime/tool behavior

This is a known and documented operational boundary.

---

## What This Project Is Best For

This system is a strong fit for:

- supervised local multi-agent coding workflows
- architecture experimentation
- orchestration and trust-boundary research
- internal demos and operator-driven runs
- structured planning / build / validate loops
- controlled mutation workflows with approvals

---

## What This Project Is Not Yet Claiming

This project is **not** currently claiming:

- fully unattended destructive autonomy
- guaranteed process-level cancellation of every external side effect
- universal semantic validation of every artifact kind
- production SaaS-grade multi-tenant isolation
- a direct copy of any private multi-agent Pi system

---

## Recommended Use

Use this system as:

- an operator-grade supervised local system
- a control plane for trusted multi-agent experimentation
- a foundation for more advanced local agent teams

Recommended operating mode:
- start in `supervised`
- use explicit approvals for risky actions
- review session artifacts and validation outcomes
- widen autonomy only when the task/tool boundary is well understood

---

## Near-Term Hardening Opportunities

The next most valuable improvements are:

1. **Artifact kind semantic validation**
   Validate artifact kinds against stronger schemas/content expectations, not only existence and policy.

2. **Stronger external side-effect containment**
   Improve kill/isolation semantics for high-risk tool paths using deeper runtime isolation where needed.

3. **Live demo mode**
   Keep mock demo support, but add a clearly labeled live demo path using real Pi behavior when credentials are available.

4. **Operator UX improvements**
   Expand topology inspection, artifact browsing, approval history, validation-state display, and best-effort usage/cost surfacing.

---

## Bottom Line

This project is now a **supervised, operator-grade local multi-agent system** with:
- real orchestration
- real policy enforcement
- real contract validation
- real artifact accountability
- real validation gating
- honest and explicit operational boundaries

That is the current maturity level.

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

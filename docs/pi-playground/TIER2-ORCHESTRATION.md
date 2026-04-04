# Tier 2 — Pi CLI orchestration (v9–v12)

Playground-only: [`extensions/`](../../extensions/), [`.pi/agents/`](../../.pi/agents/), [`.pi/damage-control-rules.yaml`](../../.pi/damage-control-rules.yaml). Not the Ink control plane (`src/`).

| Tier | Feature | npm | just |
|------|---------|-----|------|
| v9 | Agent team (YAML teams, `dispatch_agent`) | `npm run pi-tier:v9` | `just tier-v9` |
| v10 | System select (`/system` personas) | `npm run pi-tier:v10` | `just tier-v10` |
| v11 | Damage control (tool intercept + rules) | `npm run pi-tier:v11` | `just tier-v11` |
| v12 | Agent chain / pipeline | `npm run pi-tier:v12` | `just tier-v12` |

Automated config + policy smoke (no TUI): **`npm run verify-tier2`**

Raw `pi` examples:

```bash
pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts
pi -e extensions/system-select.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts
pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts
pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts
```

---

## v9 — Agent team

**What it is:** The primary session has no repo tools; it delegates work to specialists via the `dispatch_agent` tool. Specialists are Markdown personas under [`.pi/agents/*.md`](../../.pi/agents/). Teams are declared in [`.pi/agents/teams.yaml`](../../.pi/agents/teams.yaml).

**Team config**

- **`default`** — lean triad: `planner`, `builder`, `reviewer` (intended as the usual boot default; first key in YAML drives dialog order together with other teams).
- **`full`** — alternate wide roster: `scout`, `planner`, `builder`, `reviewer`, `documenter`, `red-team`.
- Other sets (`plan-build`, `frontend`, `pi-pi`, …) remain available for switching.

**Switch teams**

- At session start, a select dialog picks the active team.
- During the session: command **`/agents-team`** — choose another team from the same YAML.
- **`/agents-list`** — roster; **`/agents-grid N`** — dashboard columns.

**Manual proof**

1. `npm run pi-tier:v9` (keys in env).
2. Pick `default` or `full` when prompted.
3. Ask the lead to delegate a trivial task to `reviewer` (or another member) via `dispatch_agent`.
4. Confirm the child session runs and the grid updates.

---

## v10 — System select

**What it is:** **`/system`** opens a picker loaded from `.pi/agents/`, `.claude/agents`, `.gemini/agents`, `.codex/agents` (project + home, see [extensions/system-select.ts](../../extensions/system-select.ts)). Selected persona **prepends** body text to the system prompt; optional `tools:` in frontmatter narrows tools.

**Browser-like / specialized option**

- **[`.pi/agents/bowser.md`](../../.pi/agents/bowser.md)** — Playwright / headless browser agent (`name: bowser`). After launch, run **`/system`** and choose **bowser**.

**Manual proof**

1. `npm run pi-tier:v10`.
2. Run `/system` → **bowser** (or **scout**, **planner**, …).
3. Send a message; status line shows `System Prompt: …`.

---

## v11 — Damage control

**What it is:** Extension hooks **`tool_call`** and blocks or confirms risky operations using [`.pi/damage-control-rules.yaml`](../../.pi/damage-control-rules.yaml) (or `~/.pi/damage-control-rules.yaml` if project file missing).

**Rule categories**

- **`bashToolPatterns`** — regex on bash command; optional **`ask: true`** → confirm dialog instead of hard block.
- **`zeroAccessPaths`** — read/write/grep paths denied.
- **`readOnlyPaths`** — writes/edits denied.
- **`noDeletePaths`** — deletes denied.

**Customize:** Edit the YAML; reload by restarting Pi with the extension.

**Manual proof (blocked command)**

1. `npm run pi-tier:v11`.
2. In the Pi session, trigger a **bash** tool with: `git reset --hard` (or `rm -rf /tmp/foo` style matching rules).
3. Expect block notification and tool abort (wording from [extensions/damage-control.ts](../../extensions/damage-control.ts)).

**Automated:** `npm run verify-tier2` asserts a non–`ask` pattern blocks `git reset --hard`.

---

## v12 — Agent chain / pipeline

**What it is:** Chains live in [`.pi/agents/agent-chain.yaml`](../../.pi/agents/agent-chain.yaml). The primary agent uses the **`run_chain`** tool. Steps run **in order**; each step’s model output becomes `$INPUT` for the next; `$ORIGINAL` is always the user’s first message.

**Runnable example: `full-review`**

1. `scout` — explore / analyze  
2. `planner` — plan from prior output  
3. `builder` — implement  
4. `reviewer` — review  

**Switch chains**

- Boot dialog selects active chain.
- **`/chain`** — pick another; **`/chain-list`** — names and step counts.

**Manual proof**

1. `npm run pi-tier:v12`.
2. Select **`full-review`** when prompted.
3. Ask for a small change (e.g. “add a comment in README”); approve **`run_chain`** when the model proposes it.
4. Watch step widgets advance through scout → planner → builder → reviewer.

---

## Limits

- **Agent team / chain** spawn real Pi child processes; need API keys and a real terminal for full proof.
- **`verify-tier2`** checks YAML structure and damage-control regex only—not live TUI or `dispatch_agent` RPC.

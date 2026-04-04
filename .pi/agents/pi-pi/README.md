# Pi Pi — Tier 3 meta-agent experts

Markdown experts in this directory (except **`pi-orchestrator.md`**) are loaded by [`extensions/pi-pi.ts`](../../extensions/pi-pi.ts). The orchestrator template defines the **primary meta-agent** system prompt; experts answer `query_experts` in parallel subprocesses.

| Role (transcript / tier doc) | Expert file |
|------------------------------|-------------|
| Prompt / system | `prompt-expert.md` |
| Hooks / extensions | `ext-expert.md` |
| Themes / widgets (TUI) | `theme-expert.md`, `tui-expert.md` |
| Teams / chains | `teams-chains-expert.md`, `agent-expert.md` |
| Safety / damage-control | `safety-expert.md` |
| Docs / README | `docs-expert.md` |

**Also present:** `skill-expert.md`, `config-expert.md`, `cli-expert.md`, `keybinding-expert.md`.

**Roster hint:** [`teams.yaml`](../teams.yaml) key `pi-pi` lists the suggested dispatch set.

**User doc:** [docs/pi-playground/TIER3-META-AGENT.md](../../../docs/pi-playground/TIER3-META-AGENT.md)  
**Example prompts:** [examples/meta-agent/](../../../examples/meta-agent/)

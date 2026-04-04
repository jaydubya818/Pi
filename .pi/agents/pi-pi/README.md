# Pi Pi — Tier 3 meta-agent experts

Markdown experts in this directory (except **`pi-orchestrator.md`**) are loaded by [`extensions/pi-pi.ts`](../../extensions/pi-pi.ts). The orchestrator template defines the **primary meta-agent** system prompt; experts answer `query_experts` in parallel subprocesses.

| Role | Expert file |
|------|-------------|
| Agents / personas / team structure | `agent-expert.md` |
| CLI / flags / automation | `cli-expert.md` |
| Config / settings / providers | `config-expert.md` |
| Docs / README / tier docs | `docs-expert.md` |
| Extensions / hooks / tools | `ext-expert.md` |
| Keybindings / shortcuts | `keybinding-expert.md` |
| Prompt templates / system text | `prompt-expert.md` |
| Safety / damage-control | `safety-expert.md` |
| Skills / `SKILL.md` | `skill-expert.md` |
| Teams / chains / delegation | `teams-chains-expert.md` |
| Validation / verify scripts | `test-expert.md` |
| Themes / tokens / palettes | `theme-expert.md` |
| TUI / widgets / rendering | `tui-expert.md` |

**Roster hint:** [`teams.yaml`](../teams.yaml) key `pi-pi` lists the suggested dispatch set.

**User doc:** [docs/pi-playground/TIER3-META-AGENT.md](../../../docs/pi-playground/TIER3-META-AGENT.md)  
**Example prompts:** [examples/meta-agent/](../../../examples/meta-agent/)

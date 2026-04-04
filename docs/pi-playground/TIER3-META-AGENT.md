# Tier 3 — Meta-agent (Pi Pi)

A **primary** Pi session ([`pi-orchestrator.md`](../../.pi/agents/pi-pi/pi-orchestrator.md)) coordinates **domain experts** ([`.pi/agents/pi-pi/*.md`](../../.pi/agents/pi-pi/)) via the `query_experts` tool in [`extensions/pi-pi.ts`](../../extensions/pi-pi.ts). Experts run read-only **sub-`pi` JSON processes** with scoped tools; the primary agent **writes** extensions, YAML, themes, and docs.

## Layout

| Piece | Path |
|-------|------|
| Extension | [`extensions/pi-pi.ts`](../../extensions/pi-pi.ts) |
| Primary prompt template | [`.pi/agents/pi-pi/pi-orchestrator.md`](../../.pi/agents/pi-pi/pi-orchestrator.md) |
| Experts | [`.pi/agents/pi-pi/*.md`](../../.pi/agents/pi-pi/README.md) (except orchestrator) |
| Team roster hint | [`teams.yaml` → `pi-pi`](../../.pi/agents/teams.yaml) |
| Copy-paste examples | [`examples/meta-agent/`](../../examples/meta-agent/) |

## Run

```bash
npm run pi-tier:v13
# or
just tier-v13
# raw:
pi -e extensions/pi-pi.ts -e extensions/theme-cycler.ts
```

**Commands:** `/experts`, `/experts-grid N`  
**Tool:** `query_experts` with `{ queries: [{ expert, question }, ...] }`

**Dry-run / asset check (no API):** `npm run verify-tier3`

## Minimum expert coverage

- **prompt-expert** — prompts / system text  
- **ext-expert** — extensions API  
- **theme-expert** + **tui-expert** — themes & widgets  
- **teams-chains-expert** + **agent-expert** — teams / chains / personas  
- **safety-expert** — damage-control YAML  
- **docs-expert** — README & playground docs  

## Example workflows

See [`examples/meta-agent/`](../../examples/meta-agent/):

1. **01-query-all-experts.md** — one `query_experts` call with every Tier-3 expert.  
2. **02-pi-variant-spec.template.md** — filled by the meta-agent into a Tier-style variant spec.  
3. **03-scaffold-team-or-extension.md** — instructions to emit `teams.yaml` snippet + `extensions/*.ts` skeleton.

## Limits

- Expert calls spawn **`pi`** with `--no-extensions` and your model; **API keys** required for real research output.  
- **verify-tier3** only checks files, team list overlap, and `pi --help` load—not LLM quality.

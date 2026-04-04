# Tier 1 Pi variants (v0–v8)

Transcript-aligned **Pi CLI playground** stacks. These are **not** the control-plane Ink app (`npm run start`). Run from repo root with `pi` on PATH and API keys in the environment if you use models.

| Tier | Name | Extensions / config | npm | just |
|------|------|---------------------|-----|------|
| v0 | Default Pi | No extensions; Pi defaults + [`.pi/settings.json`](../../.pi/settings.json) if present | `npm run pi-tier:v0` | `just tier-v0` |
| v1 | Pure focus | [`extensions/pure-focus.ts`](../../extensions/pure-focus.ts) | `npm run pi-tier:v1` | `just tier-v1` |
| v2 | Minimal footer | [`minimal.ts`](../../extensions/minimal.ts), [`theme-cycler.ts`](../../extensions/theme-cycler.ts); themes in [`.pi/themes/`](../../.pi/themes/) | `npm run pi-tier:v2` | `just tier-v2` |
| v3 | Cross-agent | [`cross-agent.ts`](../../extensions/cross-agent.ts), `minimal.ts`; scans `.claude/`, `.gemini/`, `.codex/`, [`.pi/agents/`](../../.pi/agents/) | `npm run pi-tier:v3` | `just tier-v3` |
| v4 | Purpose gate | [`purpose-gate.ts`](../../extensions/purpose-gate.ts), `minimal.ts` | `npm run pi-tier:v4` | `just tier-v4` |
| v5 | Tool counter (footer) | [`tool-counter.ts`](../../extensions/tool-counter.ts) | `npm run pi-tier:v5` | `just tier-v5` |
| v6 | Tool counter widget + theme | [`tool-counter-widget.ts`](../../extensions/tool-counter-widget.ts), `minimal.ts`, `theme-cycler.ts` | `npm run pi-tier:v6` | `just tier-v6` |
| v7 | Subagent widget | [`subagent-widget.ts`](../../extensions/subagent-widget.ts), `pure-focus.ts`, `theme-cycler.ts`; sessions under `~/.pi/agent/sessions/subagents/` | `npm run pi-tier:v7` | `just tier-v7` |
| v8 | TillDone | [`tilldone.ts`](../../extensions/tilldone.ts), `theme-cycler.ts` | `npm run pi-tier:v8` | `just tier-v8` |

Raw `pi` invocation examples:

```bash
pi
pi -e extensions/pure-focus.ts
pi -e extensions/minimal.ts -e extensions/theme-cycler.ts
# … same stacks as pi-tier:v* / just tier-v*
```

---

## v0 — Default Pi

**What it is:** Stock Pi CLI with workspace `.pi` (themes, settings) only—no repo extensions.

**Launch:** `npm run pi-tier:v0` or `just tier-v0`.

**Manual test:** `pi --help` exits 0; start Pi and send a message (needs keys). Footer/status behave as Pi defaults.

---

## v1 — Pure focus

**What it is:** Hides the custom footer and clears known extension status slots so the UI is mostly conversation + editor.

**Launch:** `npm run pi-tier:v1`.

**Manual test:** No footer bar; no extension status text. If you stack another extension that sets status, load **pure-focus last** in `-e` order.

---

## v2 — Minimal footer

**What it is:** Compact footer: model id + 10-block context meter. Theme cycler: **Ctrl+X** / **Ctrl+Q**, `/theme`.

**Launch:** `npm run pi-tier:v2`.

**Manual test:** Footer shows `[####------] nn%`; theme changes and swatch/widget from `theme-cycler`.

---

## v3 — Cross-agent

**What it is:** Discovers commands (`.md` → `/name`), skills (`/skill:name`), agents (`@name`) from `.claude`, `.gemini`, `.codex`, and `.pi/agents`. Registers slash commands at load time. Uses minimal footer (no theme shortcuts unless you stack `theme-cycler`).

**Launch:** `npm run pi-tier:v3`.

**Manual test:** On session start, colored summary of discovered paths; try `/prime` if [`.claude/commands/prime.md`](../../.claude/commands/prime.md) exists.

---

## v4 — Purpose gate

**What it is:** On startup, prompts for session purpose; shows a persistent **PURPOSE** widget; injects `<purpose>` into the system prompt; blocks normal input until purpose is set.

**Launch:** `npm run pi-tier:v4`.

**Manual test:** Answer the purpose dialog; widget stays visible; try sending a message only after purpose is set.

---

## v5 — Tool counter (footer)

**What it is:** Two-line footer: model + context meter + token/cost on line 1; cwd/branch + per-tool tallies on line 2.

**Launch:** `npm run pi-tier:v5`.

**Manual test:** Run a turn that uses tools; footer tallies update.

---

## v6 — Tool counter widget + theme cycler

**What it is:** Above-editor widget with tallies per tool (colored blocks) + minimal context footer + full theme cycler (shortcuts + `/theme`).

**Launch:** `npm run pi-tier:v6`.

**Manual test:** Widget shows `Tools (n):` after tool calls; **Ctrl+X** cycles themes.

---

## v7 — Subagent widget

**What it is:** `/sub <task>` spawns background Pi processes; live widgets; `/subcont`, `/subrm`, `/subclear` (see extension header).

**Launch:** `npm run pi-tier:v7`.

**Manual test:** In a real terminal with keys: `/sub list files in extensions/` and watch widget progress. Pure-focus clears chrome; theme-cycler still available.

---

## v8 — TillDone

**What it is:** Agent tool `tilldone` for task lists (add/toggle/done, footer + status + widget). **`clear` and replacing a list via `new-list` use `ctx.ui.confirm`** before wiping tasks.

**Launch:** `npm run pi-tier:v8`.

**Manual test:** Ask the model to use tilldone `add` tasks, then complete them; try `clear` and confirm/cancel dialogs.

---

## Automated smoke (no full TUI)

From repo root, if `pi` is on PATH:

```bash
npm run pi-play:verify
npm run pi-play:verify-if-available   # skips cleanly if pi missing
```

This only checks `pi <stack> --help` loads each bundle—not interactive proof.

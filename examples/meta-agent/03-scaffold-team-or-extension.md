# Example: scaffold a team roster + extension entry

**Goal:** Add a playground team **`my-stack`** with agents `scout`, `planner`, and generate a stub extension `extensions/my-footer.ts` that only sets a one-line footer.

**Ask Pi Pi:**

```text
1) Query teams-chains-expert: valid YAML for a new team `my-stack` with agents scout and planner only, referencing existing .md names in .pi/agents/.

2) Query ext-expert: minimal TypeScript for extensions/my-footer.ts using ExtensionAPI, session_start, ctx.ui.setFooter returning model name only.

3) Query docs-expert: which README section to append npm script pi-play:my-footer and matching just target.

Then write the three artifacts to the repo (teams.yaml edit, new extension file, README snippet as a patch suggestion).
```

**Verify locally after write:**
- `npm run verify-tier2` (teams YAML still parses)
- `pi -e extensions/my-footer.ts -e extensions/theme-cycler.ts --help`

---
name: scope
description: Keep only the claude.ai connectors the current task needs. Runs automatically through hooks; use by hand when the user says scope/เปิดเฉพาะที่จำเป็น/ลด token, or to audit where tokens went.
---

# scope

Every enabled connector adds its tool names to every request (Vercel alone is ~212 tools). Default is narrow: only `always` connectors stay on.

## Automatic (hooks)

- `UserPromptSubmit` runs `scope hook-prompt`. Silent unless the prompt names a connector-backed task (e.g. "deploy to vercel"); then a `scope:` note asks you to enable that connector. Enable it only if the task really needs it, say it arrives next turn, stop.
- At a prompt with context >= 100k, if a step just finished (commit, tests pass, STATUS.md edit, "โอเค/ok", new-topic words, 30 min idle; or, with no such signal, a JEV Noul p >= 0.75 on "did a step finish?"), or context >= 300k regardless, a `scope:` note asks you to update the repo's `STATUS.md` after handling the message and tell the user they can `/clear`. The user clears.
- `SessionStart` runs `scope hook-start`. On startup, `/clear` and compaction it adds the project's `STATUS.md` (only under `status.trustedRoots`, empty by default, capped at `status.maxChars`; elsewhere a private handoff file under `~/.local/share/scope/handoff/` is restored after a clear); continue from its Next section. If an earlier task left connectors on, it asks you to disable them unless the first message needs them.
- In the Claude desktop app with `autoClear` on, the note instead asks you to save state, export the chat, then clear the session yourself; the next session opens with a short recap.
- Each feature can be switched off: `/scope:setup`, or `scope features set <name>=on|off`. Kill switch for everything: `SCOPE_OFF=1`.

To toggle: load `mcp__ccd_connectors__set_session_connector_enabled` via ToolSearch, call it once per connector in one parallel batch. Changes apply when the turn ends and become the default for new sessions.

## By hand

- `scope plan "<task>" [--profile a,b]`: which connectors a task needs (`want`). Compare with `mcp__ccd_connectors__session_connectors_status` rows of `kind: "connector"`; enable wanted ones that are `disabled`, disable the rest.
- `scope audit [--days 7]`: per-session requests, baseline (fixed context) and peak context from transcripts.
- `scope profiles`: list profiles.
- `scope features [set name=value ...]`: show or change feature switches.

Run the CLI as `node "${CLAUDE_PLUGIN_ROOT}/bin/scope.mjs" <command>`. Shipped defaults live in the plugin's `src/profiles.json`; the user's overrides (their own profiles, `status.trustedRoots`, thresholds) go in `~/.config/scope/config.json`, which is merged on top and survives plugin updates. Never edit the plugin copy.

Only `kind: "connector"` rows can be toggled. Plugin servers, project `.mcp.json` servers and desktop extensions are managed in their own settings; do not edit them silently.

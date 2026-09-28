---
description: Choose which scope features to turn on
allowed-tools: Bash(node:*), AskUserQuestion
---

Current scope feature switches (JSON):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/scope.mjs" features --json`

Help the user pick which scope features to turn on. Reply in the user's language, in plain words for a non-technical user.

1. Ask with AskUserQuestion, `multiSelect: true`, one question listing the on/off features from the JSON above (`connectors`, `handoff`, `autoClear`, `idleBlock`, `bigSkill`, `readGuard`). Label each option with a short plain name; use the `th` or `en` text as its description, whichever matches the user's language. Pre-state which ones are on now. A question holds at most 4 options, so split into two questions if needed.
2. If `TYPESAFE_API_KEY` matters to them, ask about `jev` separately (auto / on / off); otherwise leave it at `auto`.
3. Save every answer in one command, with every feature listed as on or off:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/scope.mjs" features set connectors=on handoff=on autoClear=off idleBlock=off bigSkill=on readGuard=on`
4. Tell the user in two or three lines what is now on, that it applies from their next message, and that they can run /scope:setup again any time.

Notes for the explanation: `autoClear` works only in the Claude desktop app and exports each chat to ~/Downloads before clearing (older exports it made beyond the newest 5 go to the Trash). `idleBlock` holds one message after a long break so a /clear can happen first; sending it again goes through.

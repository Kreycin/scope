# Install scope: instructions for an AI agent

For a user who wants their coding agent (Claude Code or similar) to install and set up scope. The user can say: "Install scope by following https://github.com/Kreycin/scope/blob/main/docs/install-for-ai.md".

Human-readable guides: [English](getting-started.md), [ภาษาไทย](getting-started.th.md).

## Rules for the agent

- Talk to the user in their language, in plain words; assume they are not technical.
- Run each check before the step that depends on it. Stop and explain if a check fails; do not work around it.
- Never ask the user to paste an API key into the chat, never print a key, never put a key in a command line you run. The user writes the key file themselves (step 6).
- Do not install software the user did not agree to. Ask before installing Node.js.
- Do not edit the plugin's own files. User settings go in `~/.config/scope/config.json` only.

## Step 1: check the environment

Run:

```bash
node -v
```

```bash
claude --version
```

- `node -v` must print `v20` or higher. If missing or older: ask the user to install the LTS from https://nodejs.org (or, with their consent, use their package manager, e.g. `brew install node`). After installing, the user must quit and reopen the Claude app.
- If `claude` is not found but you are running inside the Claude desktop app, skip the CLI and use the `/plugin` slash commands in step 2 instead.

## Step 2: install the plugin

Preferred (CLI):

```bash
claude plugin marketplace add Kreycin/scope
```

```bash
claude plugin install scope@scope
```

If the CLI is unavailable, ask the user to type these in Claude Code, one per message:

```
/plugin marketplace add Kreycin/scope
```

```
/plugin install scope@scope
```

Check: `claude plugin list` shows `scope@scope`, or the user sees `scope` under `/plugin`.

## Step 3: find the plugin CLI

Hooks run from the installed copy. Locate it:

```bash
ls -d ~/.claude/plugins/cache/scope/scope/*/bin/scope.mjs | tail -1
```

Call that path `SCOPE` below; run commands as `node "$SCOPE" <command>`.

Check:

```bash
node "$SCOPE" features --json
```

It prints `features` with `connectors`, `handoff`, `autoClear`, `idleBlock`, `bigSkill`, `jev`.

## Step 4: ask the user which features to turn on

Ask in one multi-select question (split into two if your question tool allows at most 4 options). Use the `en` or `th` text from the JSON as descriptions. Explain in plain words:

| Feature | Default | Plain explanation |
|---|---|---|
| `connectors` | on | Keeps unused claude.ai connectors off; turns one on when a message needs it. |
| `handoff` | on | On a very long chat at the end of a step, saves the work state and suggests `/clear`; the next session gets the state back. |
| `autoClear` | off | Desktop app only: saves state, exports the chat to `~/Downloads`, clears the session automatically. Old exports beyond 5 go to the Trash. |
| `idleBlock` | off | After 60+ min away on a long chat, holds the first message once so the user can `/clear` first (that message would cost ~2x). Resending goes through. |
| `bigSkill` | on | Suggests `/clear` after a task that loaded a 20k+ token skill. |

If unsure, recommend: `connectors`, `handoff`, `bigSkill` on; `autoClear` on only for desktop-app users who agree to chat exports; `idleBlock` on for users who take long breaks mid-task.

## Step 5: save the choices

One command, every feature listed explicitly:

```bash
node "$SCOPE" features set connectors=on handoff=on autoClear=off idleBlock=off bigSkill=on
```

Check: `node "$SCOPE" features` shows the new values. This also marks setup as done (no more daily reminder). The user can rerun `/scope:setup` any time.

## Step 6: JEV (optional)

Explain first:

- JEV (TypeSafe) answers "did a step just finish?" when there is no clear signal, so save-and-clear reminders land at better times. Without it scope still works on clear signals and always reminds past 300k tokens.
- Paid per use; scope asks rarely (in testing, 125 questions cost about $0.007 total).
- Data sent to `api.typesafe.ai` per question: the user's latest message, Claude's latest reply (up to 1,500 characters each), recent tool names. If the user's work must not leave their company, recommend off.

If the user wants it:

1. The user signs in at https://console.typesafe.ai and creates a key at https://console.typesafe.ai/keys.
2. Create the empty private file for them:

   ```bash
   mkdir -p ~/.config/typesafe && touch ~/.config/typesafe/env && chmod 600 ~/.config/typesafe/env
   ```

3. Ask the user to open `~/.config/typesafe/env` in a text editor (for example `open -e ~/.config/typesafe/env` on macOS) and add one line, `TYPESAFE_API_KEY=<their key>`, then save. Do not read the file's contents back.
4. Check that a key is present without printing it:

   ```bash
   grep -c '^TYPESAFE_API_KEY=.' ~/.config/typesafe/env
   ```

   Expect `1`.
5. Set JEV: `node "$SCOPE" features set jev=auto` (on when a key exists; `on` or `off` also valid).

Optional strictness: JEV must be at least 85% sure by default. For more frequent reminders, merge `{"handoff": {"jev": {"threshold": 0.75}}}` into `~/.config/scope/config.json` (keep existing keys; the file must stay valid JSON).

## Step 7: finish

Tell the user in two or three lines:

- which features are on;
- that scope starts in their **next new session** (start one now);
- that `/scope:setup` changes features, `SCOPE_OFF=1` pauses everything, and `/plugin uninstall scope@scope` removes it (settings in `~/.config/scope/`, logs in `~/.local/share/scope/`).

## Reference

- Update: `claude plugin marketplace update scope`, then `claude plugin update scope@scope`, then a new session.
- Hooks do nothing: check `node -v` works for the app (reopen the app after installing Node.js) and that `~/.config/scope/config.json`, if present, is valid JSON.
- Log of what scope did: `~/.local/share/scope/log.jsonl`.
- Issues: https://github.com/Kreycin/scope/issues

# Getting started with scope (from zero)

scope is a Claude Code plugin that cuts the tokens Claude re-reads every time you send a message, so your quota lasts longer before you hit a limit.

This guide goes from an empty computer to a finished setup in about 15 minutes. ภาษาไทย: [getting-started.th.md](getting-started.th.md). Letting an AI agent install it for you: [install-for-ai.md](install-for-ai.md).

Contents

1. [What you need](#1-what-you-need)
2. [Install Claude](#2-install-claude)
3. [Install Node.js](#3-install-nodejs)
4. [Install scope](#4-install-scope)
5. [Choose features](#5-choose-features)
6. [JEV (optional)](#6-jev-optional)
7. [What it looks like day to day](#7-what-it-looks-like-day-to-day)
8. [Update, pause, uninstall](#8-update-pause-uninstall)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What you need

| Item | Required? | Notes |
|---|---|---|
| A Claude plan that includes Claude Code (for example Pro or Max) | Yes | Sign up at [claude.ai](https://claude.ai) |
| The Claude desktop app, or Claude Code in a terminal | One of the two | The desktop app is recommended: every feature works there |
| Node.js 20 or newer | Yes | scope is written in JavaScript and needs Node.js to run |
| A TypeSafe account and API key | No | Only for the JEV feature, see section 6 |

## 2. Install Claude

**Desktop app (recommended)**

1. Download it from [claude.ai/download](https://claude.ai/download) for Mac or Windows.
2. Install, open it and sign in.
3. Open the **Code** tab and pick your project folder.

**Terminal**

Follow the [Claude Code quickstart](https://docs.claude.com/en/docs/claude-code/quickstart), then run `claude` in your project folder.

## 3. Install Node.js

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version.
2. Run the installer and click through to the end.
3. Check it: open Terminal (Mac) or PowerShell (Windows) and run

   ```bash
   node -v
   ```

   Any version from `v20` up (for example `v22.11.0`) works.

4. **Quit and reopen the Claude app** so it sees the new Node.js.

## 4. Install scope

In the desktop app's Code tab, or inside `claude` in a terminal, type one line at a time:

```
/plugin marketplace add Kreycin/scope
```

```
/plugin install scope@scope
```

Or from a terminal:

```bash
claude plugin marketplace add Kreycin/scope
```

```bash
claude plugin install scope@scope
```

Then **start a new session** (a new session in the app, or quit and rerun `claude`). scope is active from that session on, and once a day Claude reminds you to set it up until you do.

## 5. Choose features

Type:

```
/scope:setup
```

Claude asks which features you want; tick the ones you like:

| Feature | Default | What it does | Suggested |
|---|---|---|---|
| Unused connectors off (`connectors`) | on | claude.ai connectors (Gmail, Vercel, ...) cost tokens on every message even when unused. scope keeps the ones a task does not need off, and turns one on when your message needs it. | on |
| Save and clear (`handoff`) | on | When the chat is very long (over 100k tokens of context) and a step just finished (a commit, tests passing, you say "ok"), Claude saves where the work stands and tells you to type `/clear`. The next session gets that state back and carries on. | on |
| Auto clear (`autoClear`) | off | Desktop app only. At that same moment Claude saves the state, exports the chat to `Downloads` and clears the session itself. The new session opens with a short recap. Exports it made beyond the newest 5 move to the Trash (never deleted outright). | on if you would rather not type `/clear` |
| Hold after a long break (`idleBlock`) | off | After 60+ minutes away on a long chat, the next message costs about twice as much (the whole chat has to be loaded again). scope holds that first message once so you can `/clear` first; send it again to go through. | on if you often step away mid-task |
| Big-skill warning (`bigSkill`) | on | Some skills are very long (20k+ tokens) and stay in the chat once loaded. scope suggests `/clear` after that task is done. | on |

If you set up JEV (section 6), Claude also asks about it. Choices apply from your next message; run `/scope:setup` again any time.

## 6. JEV (optional)

**What it is.** JEV is a fast decision model from TypeSafe. scope asks it one question, "did a step just finish?", only when there is no clear signal (no commit, no passing tests, no "ok"). It makes the save-and-clear reminder land at better moments.

**Without it** scope works fine: it relies on clear signals only, and always reminds you once the chat passes 300k tokens.

**Cost.** TypeSafe bills per use, but scope only asks when the chat is over 100k tokens and has no clear signal. In our test, 125 questions cost about $0.007 in total. Check current pricing in the TypeSafe console.

### Set up JEV

1. Sign up and sign in at [console.typesafe.ai](https://console.typesafe.ai).
2. Open [API keys](https://console.typesafe.ai/keys), create a key and copy it.
3. Save the key in a private file scope reads. In Terminal, one line at a time (replace `paste-your-key-here`):

   ```bash
   mkdir -p ~/.config/typesafe
   ```

   ```bash
   echo 'TYPESAFE_API_KEY=paste-your-key-here' > ~/.config/typesafe/env
   ```

   ```bash
   chmod 600 ~/.config/typesafe/env
   ```

   The last command makes the file readable by your account only.

   > Why a file instead of `~/.zshrc`? The desktop app opened from the Dock often does not read `~/.zshrc`; scope always reads this file. If a `TYPESAFE_API_KEY` environment variable is also set, the variable wins.

4. Run `/scope:setup` and pick a JEV value:
   - **auto** (default): on whenever a key is found
   - **on**: always on
   - **off**: never used, even with a key

**What gets sent.** When asking JEV, scope sends your latest message, Claude's latest reply (up to 1,500 characters each) and the names of the tools Claude just used to `api.typesafe.ai`. If your work contains data that must not leave your company, set JEV to **off**.

**Strictness.** By default JEV must be at least 85% sure a step finished before scope reminds you. For more frequent reminders, put this in `~/.config/scope/config.json`:

```json
{ "handoff": { "jev": { "threshold": 0.75 } } }
```

(If the file already has settings, add `handoff` inside the existing braces rather than a second set.)

## 7. What it looks like day to day

Mostly nothing: scope works in the background. What you will notice:

- **A task that needs a connector**, like "deploy to vercel": Claude turns the connector on and says it is ready from the next message; send the request again.
- **A long chat at the end of a step**: Claude saves the state and tells you to type `/clear` (or clears itself with `autoClear`). The next session knows where you left off.
- **Coming back after a long break** (with `idleBlock`): the first message is held with an explanation. Send it again to continue, or `/clear` first.

**Where the state is kept.** By default in a private file under `~/.local/share/scope/handoff/`, restored only after a clear in the same folder within 24 hours. To keep it as `STATUS.md` in your own projects instead, see "Where state goes" in the [README](../README.md#where-state-goes).

## 8. Update, pause, uninstall

**Update**

```bash
claude plugin marketplace update scope
```

```bash
claude plugin update scope@scope
```

Then start a new session.

**Pause everything:** set the environment variable `SCOPE_OFF=1`, or switch features off one by one with `/scope:setup`.

**Uninstall**

```
/plugin uninstall scope@scope
```

Your settings stay in `~/.config/scope/`, logs and state in `~/.local/share/scope/`; delete both folders to remove everything. The JEV key is in `~/.config/typesafe/env`.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/scope:setup` does not exist | No new session since installing | Start a new session, or type `/plugin` and check `scope` is listed |
| Nothing ever happens, no reminders | The app cannot find Node.js | Check `node -v` in Terminal, then quit and reopen Claude |
| Nothing happens and Node.js is fine | `~/.config/scope/config.json` is not valid JSON (scope stays silent rather than guess) | Fix the JSON, or delete the file and rerun `/scope:setup` |
| JEV never runs | Key missing or wrong | Check `~/.config/typesafe/env` has a `TYPESAFE_API_KEY=...` line and the key is active in the console |
| Auto clear does nothing | Using Claude Code in a terminal, or Remote Control is on | Auto clear works only in the desktop app; elsewhere Claude asks you to type `/clear` |
| Want to see what scope did | | Read the log at `~/.local/share/scope/log.jsonl` |

Other problems: [GitHub Issues](https://github.com/Kreycin/scope/issues).

#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, summarize } from '../src/plan.mjs';
import { onPrompt, onStart } from '../src/hook.mjs';
import { decide } from '../src/boundary.mjs';
import { findBigSkills, readNewLines, bigSkillNote } from '../src/bigskill.mjs';
import { idleCheck } from '../src/idle.mjs';
import { audit, formatAudit, lastContextTokens } from '../src/audit.mjs';
import { breakdownAll, formatBreakdown } from '../src/breakdown.mjs';
import { loadStatusContext, isTrusted, privateStatusPath, loadPrivateStatus } from '../src/status.mjs';
import { simulateAll, formatSimulation } from '../src/simulate.mjs';
import { windowAll, formatWindow } from '../src/window.mjs';
import { loadState, saveState, pruneSessions, log } from '../src/store.mjs';
import { isHeadless } from '../src/env.mjs';
import { autoClearOn, markPending, takePending, pruneExports, recapMessage } from '../src/autoclear.mjs';
import { loadConfig, withDefaults, userConfigPath, readUserConfig, deepMerge } from '../src/config.mjs';
import { listFeatures, setFeatures } from '../src/features.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.SCOPE_CONFIG ?? join(here, '..', 'src', 'profiles.json');
const userPath = userConfigPath();
const dataDir = process.env.SCOPE_DATA_DIR ?? join(homedir(), '.local', 'share', 'scope');
const NUDGE_MS = 24 * 3600 * 1000;

const USAGE = `scope — keep only the connectors a task needs

  scope plan "<task>" [--profile a,b] [--status <file|->]
      Print JSON: matched profiles, connectors to keep ("want"),
      and with --status the exact enable/disable lists.
  scope status --status <file|->
      Connector tool counts and estimated tokens per request.
  scope profiles
      List profiles, their connectors and keywords.
  scope audit [--days 7] [--breakdown]
      Where input tokens went, from ~/.claude/projects transcripts.
      --breakdown splits them by source: tool results, thinking, hook injections, compaction.
      --window 5h finds the heaviest five-hour blocks and what filled them, price-weighted.
  scope simulate [--days 7]
      Replay transcripts under save-STATUS.md-and-/clear policies (size vs step boundary).
  scope features [--json]
      Show each feature switch and its current value.
  scope features set <name>=<value> ...
      Change switches in the user config (for example autoClear=on idleBlock=off).
  scope hook-prompt | hook-start
      Claude Code hooks (UserPromptSubmit / SessionStart); read hook JSON on stdin.

--status takes the JSON printed by session_connectors_status.
Config: ${configPath}
User config (overrides): ${userPath}`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' || a === '--status' || a === '--days') out[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--breakdown') out.breakdown = true;
    else if (a === '--json') out.json = true;
    else if (a === '--window') out.window = argv[++i];
    else out._.push(a);
  }
  return out;
}

function readStatus(src) {
  if (!src) return null;
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  return JSON.parse(raw);
}

// Last ~256 KB of a transcript is enough to find the latest usage row.
function tailLines(path, bytes = 262144) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

// Until the user picks features, remind once a day that /scope:setup exists.
function setupNudge(config, now = Date.now()) {
  if (config.setupDone) return null;
  const path = join(dataDir, 'setup-nudge.json');
  try {
    if (now - JSON.parse(readFileSync(path, 'utf8')).at < NUDGE_MS) return null;
  } catch {}
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ at: now }));
  return (
    `scope: the scope plugin is installed with safe defaults but not set up yet. ` +
    `At the end of your first reply, add one line in the user's language: they can run /scope:setup to choose which scope features to turn on.`
  );
}

// Hooks must never break a prompt: any failure means no output.
async function runHook(event, config) {
  const hookStart = Date.now();
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {}
  if (event === 'SessionStart') pruneSessions(dataDir);
  const args = { prompt: input.prompt, sessionId: input.session_id, source: input.source };
  const loaded = loadState(dataDir, input.session_id);
  const loadedLeftOn = [...loaded.leftOn];
  const fn = event === 'UserPromptSubmit' ? onPrompt : onStart;
  const first = config.connectors.enabled ? fn(args, loaded, config) : { context: null, state: loaded };
  let state = first.state;
  const contexts = first.context ? [first.context] : [];
  let message = null;
  let statusChars = 0;
  let handoffLog = null;
  const headless = isHeadless();
  const restorable = input.cwd ? isTrusted(resolve(input.cwd), config.status.trustedRoots) : false;
  if (event === 'UserPromptSubmit' && input.transcript_path) {
    if (!headless) {
      try {
        const lines = tailLines(input.transcript_path);
        const contextTokens = lastContextTokens(lines);
        const idle = idleCheck({ lines, contextTokens, sessionId: input.session_id, prompt: input.prompt, restorable }, state, config);
        if (idle) {
          saveState(dataDir, input.session_id, state, loadedLeftOn);
          log(dataDir, { cmd: 'idle-block', session: input.session_id, ...idle.log });
          console.log(JSON.stringify({ decision: 'block', reason: idle.reason }));
          return;
        }
        const elapsed = Date.now() - hookStart;
        const budget = Math.min(config.handoff.jev?.timeoutMs ?? 3000, 4000 - elapsed);
        const jevConfig =
          budget < 500
            ? { ...config, handoff: { ...config.handoff, jev: { ...config.handoff.jev, enabled: false, noTime: true } } }
            : { ...config, handoff: { ...config.handoff, jev: { ...config.handoff.jev, timeoutMs: budget } } };
        // Untrusted folders save to a private file instead of the repo's STATUS.md.
        const target = restorable
          ? 'STATUS.md at the repo root'
          : input.cwd
            ? `${privateStatusPath(dataDir, input.cwd)} (private handoff file; create its folder if missing)`
            : null;
        const d = !config.handoff.enabled ? { state, log: null } : await decide(
          { sessionId: input.session_id, contextTokens, lines, prompt: input.prompt, restorable: !!target, target: target ?? undefined, autoClear: !!target && autoClearOn(config, { headless }) },
          state,
          jevConfig,
        );
        state = d.state;
        handoffLog = d.log;
        if (d.note) {
          message = d.note.message;
          contexts.push(d.note.context);
          if (d.autoClear) markPending(dataDir, { cwd: resolve(input.cwd) });
        }
      } catch {}
      if (config.bigSkill.enabled) try {
        const skills = findBigSkills(readNewLines(input.transcript_path, state, input.session_id), config.bigSkill.minTokens);
        if (skills.length) {
          log(dataDir, { cmd: 'big-skill', session: input.session_id, skills });
          // A handoff note already asks for STATUS.md and /clear; one note is enough.
          if (!message) {
            const n = bigSkillNote(skills, restorable);
            message = n.message;
            contexts.push(n.context);
          }
        }
      } catch {}
    }
  }
  if (event === 'SessionStart' && ['startup', 'clear', 'compact'].includes(input.source ?? 'startup')) {
    let s = loadStatusContext(input.cwd, config.status);
    if (!s && input.cwd && input.source === 'clear') s = loadPrivateStatus(dataDir, input.cwd, config.status);
    try {
      const recap = s && input.cwd ? takePending(dataDir, { cwd: resolve(input.cwd), source: input.source }) : null;
      if (recap) {
        contexts.push(recap);
        if (!message) message = recapMessage(s);
      }
      const moved = pruneExports(dataDir, config.handoff.autoClear.keepExports);
      if (moved.length) log(dataDir, { cmd: 'autoclear-prune', moved });
    } catch {}
    if (s) {
      contexts.push(s);
      statusChars = s.length;
    }
    if (input.source !== 'compact' && !headless) {
      const nudge = setupNudge(config);
      if (nudge) contexts.push(nudge);
    }
  }
  if (handoffLog) log(dataDir, { cmd: 'handoff', session: input.session_id, ...handoffLog });
  if (!contexts.length && !message) {
    if (handoffLog || event === 'UserPromptSubmit') saveState(dataDir, input.session_id, state, loadedLeftOn);
    return;
  }
  saveState(dataDir, input.session_id, state, loadedLeftOn);
  log(dataDir, { cmd: event, session: input.session_id, message, context: contexts.filter((c) => !c.startsWith('scope: project state')), statusChars });
  const out = {};
  if (message) out.systemMessage = message;
  if (contexts.length) out.hookSpecificOutput = { hookEventName: event, additionalContext: contexts.join('\n\n') };
  console.log(JSON.stringify(out));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  if (!cmd || args.help) {
    console.log(USAGE);
    return;
  }
  if (cmd === 'hook-prompt' || cmd === 'hook-start') {
    if (process.env.SCOPE_OFF === '1') return;
    let config;
    try {
      config = loadConfig(configPath, userPath);
    } catch {
      return;
    }
    try {
      await runHook(cmd === 'hook-prompt' ? 'UserPromptSubmit' : 'SessionStart', config);
    } catch {}
    return;
  }

  if (cmd === 'features') {
    if (rest[0] === 'set') {
      setFeatures(userPath, rest.slice(1));
      console.log(`saved ${userPath}; applies from the next prompt`);
    }
    const merged = deepMerge(JSON.parse(readFileSync(configPath, 'utf8')), readUserConfig(userPath));
    const list = listFeatures(withDefaults(merged));
    if (args.json) console.log(JSON.stringify({ userConfig: userPath, setupDone: !!merged.setupDone, features: list }, null, 1));
    else for (const f of list) console.log(`${f.name.padEnd(11)} ${String(f.value).padEnd(5)} ${f.en}`);
    return;
  }

  const config = loadConfig(configPath, userPath);

  if (cmd === 'plan') {
    const task = rest.join(' ');
    const profiles = args.profile ? args.profile.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const result = plan({ task, profiles, status: readStatus(args.status), config });
    log(dataDir, { cmd, task: task.slice(0, 200), profiles: result.profiles.map((p) => p.name), want: result.want, disable: result.disable, enable: result.enable });
    console.log(JSON.stringify(result, null, 1));
  } else if (cmd === 'status') {
    const status = readStatus(args.status);
    if (!status) throw new Error('status needs --status <file|->');
    console.log(JSON.stringify(summarize(status, config), null, 1));
  } else if (cmd === 'audit') {
    const days = Number(args.days ?? 7);
    const root = join(homedir(), '.claude', 'projects');
    if (args.window) {
      if (args.window !== '5h') throw new Error('--window supports 5h only');
      console.log(formatWindow(windowAll({ root, days, pricing: config.pricing })));
      return;
    }
    console.log(args.breakdown ? formatBreakdown(breakdownAll({ root, days })) : formatAudit(audit({ root, days })));
  } else if (cmd === 'simulate') {
    const days = Number(args.days ?? 7);
    console.log(formatSimulation(simulateAll({ root: join(homedir(), '.claude', 'projects'), days })));
  } else if (cmd === 'profiles') {
    for (const [name, p] of Object.entries(config.profiles)) {
      console.log(`${name}: ${p.connectors.join(', ')}\n  keywords: ${p.keywords.join(', ')}`);
    }
    console.log(`always on: ${config.always.join(', ') || '(none)'}`);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`scope: ${err.message}`);
  process.exitCode = 1;
});

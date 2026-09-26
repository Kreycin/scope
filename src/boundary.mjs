// Decide, at a user prompt, whether Claude should save STATUS.md so the user can /clear.
//
//   context < min                 -> nothing
//   deterministic step signal     -> hand off (commit, tests pass, STATUS.md edit, "โอเค", new topic, idle)
//   context >= max                -> hand off (fallback, even mid-step)
//   otherwise                     -> ask JEV one Noul: "did a step just finish?"
//
// A note fires at most once until the context grows by `regrow` past the last note; a
// smaller context than the last note means the session was cleared, so the gate resets.
import { scanTimeline } from './simulate.mjs';
import { systemOne } from './jev.mjs';
import { autoClearNote } from './autoclear.mjs';

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

// Signals for the prompt being submitted now: transcript tail plus the new prompt text.
export function currentPrompt(lines, prompt, now = Date.now()) {
  const row = JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), message: { content: prompt ?? '' } });
  const tl = scanTimeline([...lines, row]);
  return tl.prompts.at(-1) ?? { signals: [], text: prompt, lastAssistantText: '', tools: [] };
}

export function gate({ sessionId = 'unknown', contextTokens, signals }, state, config) {
  const { min, max, regrow } = config.handoff;
  state.handoff ??= {};
  let last = state.handoff[sessionId] ?? 0;
  if (contextTokens < last) {
    delete state.handoff[sessionId];
    last = 0;
  }
  if (!contextTokens || contextTokens < min) return { action: 'none' };
  if (last && contextTokens < last + regrow) return { action: 'none' };
  if (signals.length) return { action: 'handoff', reason: signals.join('+') };
  if (contextTokens >= max) return { action: 'handoff', reason: 'size' };
  return { action: 'ask-jev' };
}

export function markHandoff(state, sessionId, contextTokens) {
  state.handoff ??= {};
  state.handoff[sessionId] = contextTokens;
  const ids = Object.keys(state.handoff);
  for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete state.handoff[id];
}

export const STEP_DONE_QUESTION = {
  type: 'noul',
  instructions:
    'The assistant was working on a coding task and `user_message` is the reply that just arrived. ' +
    'Had the assistant finished a step of the work (a piece of work complete and reported) so that `user_message` ' +
    'starts the next step or a different task, rather than continuing, correcting or waiting on unfinished work?',
  criteria: {
    true: 'The previous step is complete and reported; the user moves on to a next step, a new topic, or just acknowledges.',
    false: 'The work is mid-way: the user answers a question, corrects the result, reports a problem, or asks to keep going on the same unfinished change.',
  },
};

export async function askJev(prompt, { threshold, timeoutMs }, deps = {}) {
  const state = {
    assistant_last_message: clip(prompt.lastAssistantText, 1500),
    assistant_recent_tools: prompt.tools ?? [],
    user_message: clip(prompt.text, 1500),
  };
  const started = Date.now();
  const res = await (deps.systemOne ?? systemOne)({ state, questions: { step_done: STEP_DONE_QUESTION }, timeoutMs });
  const p = res.answers?.step_done?.noul;
  if (typeof p !== 'number') throw new Error('no noul in answer');
  return { p, done: p >= threshold, latency_ms: Date.now() - started, usage: res.usage ?? null };
}

export function handoffNote(contextTokens, reason, restorable = true, target = 'STATUS.md at the repo root') {
  const k = Math.round(contextTokens / 1000);
  if (!restorable) {
    const message =
      `scope: context ${k}k tokens and a step looks finished (${reason}). Type /compact to shrink it; ` +
      `/clear would lose this work here because STATUS.md is only restored under trusted folders.`;
    const context =
      `scope: context is ${k}k tokens and every request re-reads it; a step looks finished (${reason}). ` +
      `Handle the user's message first; if it continues unfinished work, finish that step. ` +
      `Then tell the user in one line that they can type /compact to shrink the context.`;
    return { message, context };
  }
  const message = `scope: context ${k}k tokens and a step looks finished (${reason}). After Claude saves its state, type /clear to continue from it.`;
  const context =
    `scope: context is ${k}k tokens and every request re-reads it; a step looks finished (${reason}). ` +
    `Handle the user's message first; if it continues unfinished work, finish that step before handing off. ` +
    `Then write ${target} (Goal, Done, Decisions, Key files, Next, Open questions; under ~80 lines; ` +
    `rewrite stale lines instead of appending; keep an existing file's language and layout) ` +
    `and tell the user in one line that state is saved and they can type /clear to continue from it.`;
  return { message, context };
}

// Full decision for one prompt. Never throws: JEV failures mean no note.
export async function decide({ sessionId, contextTokens, lines, prompt, now, restorable = true, autoClear = false, target }, state, config, deps = {}) {
  const cur = currentPrompt(lines, prompt, now);
  const g = gate({ sessionId, contextTokens, signals: cur.signals }, state, config);
  let reason = g.reason;
  let jev = null;
  if (g.action === 'ask-jev') {
    if (!config.handoff.jev?.enabled) {
      return { note: null, state, log: { gate: 'no-signal', jev: config.handoff.jev?.noTime ? 'no-time' : 'disabled' } };
    }
    try {
      jev = await askJev(cur, config.handoff.jev, deps);
    } catch (err) {
      return { note: null, state, log: { gate: 'ask-jev', jev_error: String(err.message).slice(0, 100) } };
    }
    if (!jev.done) return { note: null, state, log: { gate: 'ask-jev', p: jev.p, latency_ms: jev.latency_ms } };
    reason = `JEV p=${jev.p.toFixed(2)}`;
  } else if (g.action === 'none') {
    return { note: null, state, log: null };
  }
  markHandoff(state, sessionId, contextTokens);
  const note = autoClear ? autoClearNote(contextTokens, reason, target) : handoffNote(contextTokens, reason, restorable, target);
  return { note, autoClear, state, log: { gate: g.action, reason, p: jev?.p, latency_ms: jev?.latency_ms, autoClear } };
}

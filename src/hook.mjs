// Hook logic. Hooks cannot flip connectors themselves; they tell Claude to,
// and only when something must change, so a normal prompt adds zero tokens.
import { plan } from './plan.mjs';

const TOGGLE = 'mcp__ccd_connectors__set_session_connector_enabled';
const MAX_SESSIONS = 50;

export function emptyState() {
  return { leftOn: [], sessions: {} };
}

function remember(state, sessionId, names) {
  const opened = new Set(state.sessions[sessionId] ?? []);
  for (const n of names) opened.add(n);
  state.sessions[sessionId] = [...opened];
  const ids = Object.keys(state.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete state.sessions[id];
  state.leftOn = [...new Set([...state.leftOn, ...names])];
}

// UserPromptSubmit: connectors this prompt needs that this session has not opened yet.
export function onPrompt({ prompt = '', sessionId = 'unknown' }, state, config) {
  const r = plan({ task: prompt.slice(0, 2000), config });
  const always = new Set(config.always.map((c) => c.toLowerCase()));
  const opened = new Set((state.sessions[sessionId] ?? []).map((c) => c.toLowerCase()));
  const need = [];
  for (const m of r.profiles) {
    for (const c of config.profiles[m.name].connectors) {
      if (!always.has(c.toLowerCase()) && !opened.has(c.toLowerCase()) && !need.includes(c)) need.push(c);
    }
  }
  if (!need.length) return { context: null, state };
  remember(state, sessionId, need);
  const hits = r.profiles.flatMap((p) => p.hits).join(', ');
  const context =
    `scope: prompt matched [${hits}]; connector(s) ${need.join(', ')} are off by default. ` +
    `If this task really needs them, load ${TOGGLE} via ToolSearch and enable each (enabled: true); ` +
    `tools arrive next turn, so say so in one line and stop. If not needed, ignore this note.`;
  return { context, state };
}

// SessionStart: connectors a previous session opened stay on as the account default; ask to close them.
export function onStart({ sessionId = 'unknown', source = 'startup' }, state) {
  if (source !== 'startup' && source !== 'clear') return { context: null, state };
  const left = state.leftOn;
  state.leftOn = [];
  if (!left.length) return { context: null, state };
  state.sessions[sessionId] = [];
  const context =
    `scope: connector(s) ${left.join(', ')} were opened by an earlier task and are still on for every request. ` +
    `Unless the user's first message needs them, load ${TOGGLE} via ToolSearch and disable each (enabled: false), ` +
    `with one short line to the user.`;
  return { context, state };
}

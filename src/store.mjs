// Per-session state files: parallel sessions used to race on one state.json and lose
// updates. Each session now gets its own file; only leftOn (account-wide connector
// state) still lives in the shared state.json, merged by delta on save.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  statSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

// Sanitize a session id into a safe filename stem.
export function sessionFileId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return s || 'unknown';
}

// Load the in-memory state shape for one session: leftOn (account-wide) plus this
// session's own slices. Falls back to the legacy shared-map shape if no session file
// exists yet.
export function loadState(dataDir, sessionId) {
  const legacy = readJson(join(dataDir, 'state.json'));
  const state = { leftOn: Array.isArray(legacy?.leftOn) ? legacy.leftOn : [], sessions: {} };

  const fid = sessionFileId(sessionId);
  let sess = readJson(join(dataDir, 'sessions', `${fid}.json`));
  if (!sess && legacy && (legacy.sessions || legacy.handoff || legacy.idleBlock || legacy.skillScan)) {
    sess = {};
    if (legacy.sessions?.[sessionId] !== undefined) sess.opened = legacy.sessions[sessionId];
    if (legacy.handoff?.[sessionId] !== undefined) sess.handoff = legacy.handoff[sessionId];
    if (legacy.idleBlock?.[sessionId] !== undefined) sess.idleBlock = legacy.idleBlock[sessionId];
    if (legacy.skillScan?.[sessionId] !== undefined) sess.skillScan = legacy.skillScan[sessionId];
  }
  if (sess) {
    if (sess.opened !== undefined) state.sessions[sessionId] = sess.opened;
    if (sess.handoff !== undefined) state.handoff = { [sessionId]: sess.handoff };
    if (sess.idleBlock !== undefined) state.idleBlock = { [sessionId]: sess.idleBlock };
    if (sess.skillScan !== undefined) state.skillScan = { [sessionId]: sess.skillScan };
    if (sess.stalledClear !== undefined) state.stalledClear = { [sessionId]: sess.stalledClear };
    if (sess.readGuard !== undefined) state.readGuard = { [sessionId]: sess.readGuard };
  }
  return state;
}

// Persist this session's slice, and merge any leftOn change into the shared state.json
// by delta so two sessions saving from the same stale load don't clobber each other.
export function saveState(dataDir, sessionId, state, loaded = []) {
  const fid = sessionFileId(sessionId);
  const slice = {};
  const opened = state.sessions?.[sessionId];
  if (opened !== undefined) slice.opened = opened;
  const handoff = state.handoff?.[sessionId];
  if (handoff !== undefined) slice.handoff = handoff;
  const idleBlock = state.idleBlock?.[sessionId];
  if (idleBlock !== undefined) slice.idleBlock = idleBlock;
  const skillScan = state.skillScan?.[sessionId];
  if (skillScan !== undefined) slice.skillScan = skillScan;
  const stalledClear = state.stalledClear?.[sessionId];
  if (stalledClear !== undefined) slice.stalledClear = stalledClear;
  const readGuard = state.readGuard?.[sessionId];
  if (readGuard !== undefined) slice.readGuard = readGuard;
  atomicWrite(join(dataDir, 'sessions', `${fid}.json`), JSON.stringify(slice));

  const leftOn = state.leftOn ?? [];
  const added = leftOn.filter((x) => !loaded.includes(x));
  const removed = loaded.filter((x) => !leftOn.includes(x));
  if (added.length || removed.length) {
    const fresh = readJson(join(dataDir, 'state.json'));
    const freshLeftOn = Array.isArray(fresh?.leftOn) ? fresh.leftOn : [];
    const merged = [...new Set([...freshLeftOn.filter((x) => !removed.includes(x)), ...added])];
    atomicWrite(join(dataDir, 'state.json'), JSON.stringify({ leftOn: merged }));
  }
}

// Drop session files nobody has touched in a while. Errors ignored: best effort.
export function pruneSessions(dataDir, maxAgeDays = 14) {
  try {
    const dir = join(dataDir, 'sessions');
    const cutoff = Date.now() - maxAgeDays * 86400000;
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // one bad file shouldn't stop the prune
      }
    }
  } catch {
    // no sessions dir yet, or unreadable: nothing to prune
  }
}

// Append-only debug log. Best effort: logging must never break a hook. Rotates the
// file once it grows past maxBytes so it doesn't grow unbounded.
export function log(dataDir, entry, maxBytes = 5 * 1024 * 1024) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const p = join(dataDir, 'log.jsonl');
    try {
      if (statSync(p).size > maxBytes) renameSync(p, join(dataDir, 'log.1.jsonl'));
    } catch {
      // no existing log yet
    }
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {
    // Logging is best effort; planning must still work.
  }
}

// Auto clear (desktop app only): at a handoff Claude saves STATUS.md, exports the chat
// to ~/Downloads, then clears itself. A cleared view hides the old chat, so the next
// session opens with a short recap, and old exports this flow made go to the Trash.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const EXPORT_TOOL = 'mcp__ccd_session_mgmt__export_transcript';
export const CLEAR_TOOL = 'mcp__ccd_session_mgmt__clear_session';
export const TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title';
// The app does not show a SessionStart message on the cleared screen, so the sidebar title carries the hint.
export const CLEARED_TITLE = 'cleared: send any message to continue';
const PENDING = 'autoclear-pending.json';
const EXPORTS = 'exports.json';
const EXPORT_RE = /^session-export-\d+\.zip$/;
const PENDING_MAX_MS = 6 * 3600 * 1000;
// The desktop clear tool opens a fresh session whose SessionStart source is 'startup',
// so a startup this soon after the mark counts as that clear.
const STARTUP_MAX_MS = 5 * 60 * 1000;

export function autoClearOn(config, { headless, env = process.env }) {
  return !!config.handoff.autoClear?.enabled && !headless && env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop';
}

export function autoClearNote(contextTokens, reason, target = 'STATUS.md at the repo root') {
  const k = Math.round(contextTokens / 1000);
  const message = `scope: context ${k}k tokens and a step looks finished (${reason}). Claude will save its state, export this chat to ~/Downloads, then clear.`;
  const context =
    `scope: context is ${k}k tokens and every request re-reads it; a step looks finished (${reason}). ` +
    `Handle the user's message first; if it continues unfinished work or you asked the user something, finish or wait and skip the rest of this note. ` +
    `Otherwise, at the end of this turn: write ${target} (Goal, Done, Decisions, Key files, Next, Open questions; under ~80 lines; ` +
    `rewrite stale lines instead of appending; keep an existing file's language and layout; put anything the user still needs from your reply into Next); ` +
    `load ${EXPORT_TOOL}, ${CLEAR_TOOL} and ${TITLE_TOOL} in one ToolSearch call (if export or clear is missing, tell the user state is saved and to type /clear, and stop); ` +
    `call the export with session_id "self" (if it is refused, tell the user state is saved, the export failed, and to type /clear when ready, and stop); ` +
    `set this session's title to "${CLEARED_TITLE}" (skip it if the title tool is missing or refused); ` +
    `tell the user in one line that state is saved, the chat was exported to Downloads, and the session is clearing; ` +
    `then call the clear with session_id "self" as your last action (if it is refused, tell the user to type /clear).`;
  return { message, context };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// Remember that a handoff asked for a clear, so the next clear in this folder gets a recap.
export function markPending(dataDir, { cwd, now = Date.now() }) {
  writeJson(join(dataDir, PENDING), { cwd, at: now });
}

// SessionStart after a clear (or the desktop tool's fresh startup): consume the mark, record the exports made since it, return recap context.
export function takePending(dataDir, { cwd, source, now = Date.now(), downloads = join(homedir(), 'Downloads') }) {
  const path = join(dataDir, PENDING);
  const p = readJson(path, null);
  if (!p) return null;
  if (now - p.at > PENDING_MAX_MS) {
    writeJson(path, null);
    return null;
  }
  const cleared = source === 'clear' || (source === 'startup' && now - p.at <= STARTUP_MAX_MS);
  if (!cleared || p.cwd !== cwd) return null;
  writeJson(path, null);
  recordExports(dataDir, downloads, p.at - 60000, now);
  return (
    `scope: this session was cleared automatically after a handoff; the user no longer sees the old chat ` +
    `(an export zip is in ~/Downloads). Open your first reply with a 2-3 line recap in the user's language: ` +
    `what was just finished and what Next says, from the saved state below. ` +
    `Then load ${TITLE_TOOL} and set a short title (3-6 words) naming the current work, replacing the "${CLEARED_TITLE}" placeholder.`
  );
}

// Exports this flow made: zips in Downloads created between the handoff and the clear.
export function recordExports(dataDir, downloads, from, to) {
  let names = [];
  try {
    names = readdirSync(downloads).filter((n) => EXPORT_RE.test(n));
  } catch {
    return;
  }
  const list = readJson(join(dataDir, EXPORTS), []);
  for (const n of names) {
    const f = join(downloads, n);
    const t = statSync(f).mtimeMs;
    if (t >= from && t <= to + 60000 && !list.some((e) => e.path === f)) list.push({ path: f, at: t });
  }
  writeJson(join(dataDir, EXPORTS), list);
}

// Keep the newest `keep` auto exports; move older ones to the Trash (recoverable). Never touches other files.
export function pruneExports(dataDir, keep, trash = join(homedir(), '.Trash')) {
  const path = join(dataDir, EXPORTS);
  const list = readJson(path, []).filter((e) => existsSync(e.path));
  list.sort((a, b) => b.at - a.at);
  const moved = [];
  for (const e of list.slice(keep)) {
    let dest = join(trash, basename(e.path));
    if (existsSync(dest)) dest = dest.replace(/\.zip$/, `-${Date.now()}.zip`);
    try {
      mkdirSync(trash, { recursive: true });
      renameSync(e.path, dest);
      moved.push(e.path);
    } catch {}
  }
  writeJson(path, list.filter((e) => !moved.includes(e.path)));
  return moved;
}
